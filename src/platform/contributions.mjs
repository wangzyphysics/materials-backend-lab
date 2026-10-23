import { batchSchema } from '../domain/materials/batch-contribution.ts';
import { event, newId, transaction } from './database.mjs';
import { composition } from './materials.mjs';
import { ContributionError } from '../ingestion/errors.mjs';
import { validatePackage } from '../ingestion/validation.mjs';
const fail = (status, message) => { throw new ContributionError(status, message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function ownedBatch(db, id, user, { lock = false, archived = false } = {}) {
    if (!uuid.test(id))
        fail(404, 'Batch not found');
    const row = (await db.query(`SELECT * FROM calypso_platform.batches WHERE id=$1 AND owner_id=$2${archived ? '' : ' AND deleted_at IS NULL'}${lock ? ' FOR UPDATE' : ''}`, [id, user.id])).rows[0];
    if (!row)
        fail(404, 'Batch not found');
    return row;
}
export async function draftDto(db, row) {
    const files = (await db.query('SELECT * FROM calypso_platform.files WHERE batch_id=$1 ORDER BY client_id', [row.id])).rows;
    return batchSchema.parse({ ...row.draft_json, id: row.id, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), files: files.map(f => ({ id: f.client_id, path: f.path, sha256: f.sha256, size: f.size, mediaType: f.media_type, contentBase64: f.bytes.toString('base64') })) });
}
export function statusDto(row) {
    const draft = row.draft_json;
    return { id: row.id, title: draft.title, ownerId: row.owner_id, review: row.review_status, reviewNotes: row.review_notes, submittedAt: row.submitted_at?.toISOString() ?? null, updatedAt: row.updated_at.toISOString(), archivedAt: row.deleted_at?.toISOString() ?? null,
        records: draft.records.map(r => ({ id: r.id, review: row.review_status, publication: row.review_status === 'approved' && draft.visibility === 'public-after-review' ? 'public' : 'private',
            computation: !draft.computationRequested ? 'not-requested' : r.dataType !== 'structure' ? 'not-applicable' : row.review_status === 'approved' ? 'pending-eligibility' : row.review_status === 'rejected' ? 'blocked-by-review' : row.review_status === 'not-submitted' ? 'awaiting-submission' : 'awaiting-review',
            ingestion: 'not-ingested', quality: 'not-started', percent: null, currentStep: null, reason: draft.computationRequested ? 'VASP workflow adapter is not connected.' : null })) };
}
/** Shared transactional writer for the contribution API and administrator ingestion. */
export async function saveBatchInTransaction(db, user, batch, files, expectedUpdatedAt) {
    const id = batch.id;
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['batch:' + id]);
    let row = (await db.query('SELECT * FROM calypso_platform.batches WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (row) {
        if (row.owner_id !== user.id || row.deleted_at)
            fail(404, 'Batch not found');
        if (!['not-submitted', 'needs-information'].includes(row.review_status))
            fail(409, 'Submitted records are read-only. Create a new batch for revisions.');
        if (row.updated_at.toISOString() !== expectedUpdatedAt)
            fail(409, 'Draft changed; reload before saving');
    }
    const metadata = { ...batch, files: [] };
    if (!row)
        row = (await db.query('INSERT INTO calypso_platform.batches(id,owner_id,draft_json) VALUES($1,$2,$3) RETURNING *', [id, user.id, metadata])).rows[0];
    else
        row = (await db.query('UPDATE calypso_platform.batches SET draft_json=$1,updated_at=now() WHERE id=$2 RETURNING *', [metadata, id])).rows[0];
    // IDs are permanent and globally unique; an imported copy must remap its graph identities.
    await db.query('DELETE FROM calypso_platform.contribution_conditions WHERE batch_id=$1', [id]);
    await db.query('DELETE FROM calypso_platform.contribution_phases WHERE batch_id=$1 AND NOT(id=ANY($2::text[]))', [id, batch.phases.map(p => p.id)]);
    for (const phase of batch.phases) {
        const saved = await db.query('INSERT INTO calypso_platform.contribution_phases(id,batch_id,metadata) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET metadata=EXCLUDED.metadata WHERE contribution_phases.batch_id=EXCLUDED.batch_id RETURNING id', [phase.id, id, phase]);
        if (!saved.rowCount)
            fail(409, 'Phase ID belongs to another contribution. Import the draft as a copy.');
    }
    for (const condition of batch.conditions)
        await db.query('INSERT INTO calypso_platform.contribution_conditions(id,batch_id,phase_id,metadata) VALUES($1,$2,$3,$4)', [condition.id, id, condition.phaseId, condition]);
    await db.query('DELETE FROM calypso_platform.files WHERE batch_id=$1', [id]);
    for (const { file, bytes } of files)
        await db.query('INSERT INTO calypso_platform.files(batch_id,client_id,path,sha256,size,media_type,bytes) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, file.id, file.path, file.sha256, file.size, file.mediaType, bytes]);
    await db.query('DELETE FROM calypso_platform.records WHERE batch_id=$1 AND NOT(client_id=ANY($2::text[]))', [id, batch.records.map(r => r.id)]);
    for (const record of batch.records) {
        let counts = {};
        try {
            counts = composition(record.formula);
        }
        catch { }
        await db.query('INSERT INTO calypso_platform.records(id,batch_id,client_id,input_json) VALUES($1,$2,$3,$4) ON CONFLICT(batch_id,client_id) DO UPDATE SET input_json=EXCLUDED.input_json', [newId(), id, record.id, { ...record, _phaseStatus: batch.phases.find(p => p.id === record.phaseId).identification, _composition: counts, _elements: Object.keys(counts).sort() }]);
    }
    await event(db, id, user.id, 'draft.saved', {});
    return { draft: await draftDto(db, row), state: statusDto(row) };
}
export async function saveContribution(pool, user, input, expectedUpdatedAt) {
    const { batch, files } = await validatePackage(input);
    return transaction(pool, db => saveBatchInTransaction(db, user, batch, files, expectedUpdatedAt));
}
