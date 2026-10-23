import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { batchSchema } from '../domain/materials/batch-contribution.ts';
import { transaction, event } from '../platform/database.mjs';
import { saveBatchInTransaction } from '../platform/contributions.mjs';
import { validatePackage } from './validation.mjs';
import { ContributionError } from './errors.mjs';
const importSchema = z.object({
    sourceNamespace: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
    externalBatchId: z.string().trim().min(1).max(200), reason: z.string().trim().min(3).max(2000), draft: z.unknown(),
}).strict();
const requireAdmin = user => { if (!user || user.role !== 'admin' || user.status !== 'active' || user.demoAccount || user.passwordChangeRequired)
    throw new ContributionError(403, 'Active administrator access required'); };
const receiptDto = row => ({ id: row.id, batchId: row.batch_id, sourceNamespace: row.source_namespace, externalBatchId: row.external_batch_id, packageHash: row.package_hash, reason: row.reason, counts: row.counts, createdAt: row.created_at.toISOString() });
async function previous(db, user, input) { return (await db.query('SELECT * FROM calypso_platform.ingestion_receipts WHERE owner_id=$1 AND source_namespace=$2 AND external_batch_id=$3', [user.id, input.sourceNamespace, input.externalBatchId])).rows[0]; }
export async function previewImport(pool, user, value) {
    requireAdmin(user);
    const input = importSchema.parse(value), { report } = await validatePackage(input.draft), prior = await previous(pool, user, input);
    return { report, action: prior ? (prior.package_hash === report.packageHash ? 'replay' : 'conflict') : 'create', receipt: prior ? receiptDto(prior) : null };
}
/** Allocate private identities once. A package copy cannot overwrite another batch's Phase IDs. */
function importedCopy(batch) {
    const phases = new Map(batch.phases.map(p => [p.id, 'PH-' + randomUUID()])), conditions = new Map(batch.conditions.map(c => [c.id, 'PT-' + randomUUID()]));
    return batchSchema.parse({ ...batch, id: randomUUID(), phases: batch.phases.map(p => ({ ...p, id: phases.get(p.id) })),
        conditions: batch.conditions.map(c => ({ ...c, id: conditions.get(c.id), phaseId: phases.get(c.phaseId) })),
        records: batch.records.map(r => ({ ...r, phaseId: phases.get(r.phaseId), conditionId: conditions.get(r.conditionId) })) });
}
export async function commitImport(pool, user, value) {
    requireAdmin(user);
    const input = importSchema.parse(value), validated = await validatePackage(input.draft);
    return transaction(pool, async (db) => {
        // Role/status changes and importing use the same account-row locking discipline.
        const actor = (await db.query('SELECT role,status,demo_account,password_change_required FROM calypso_platform.users WHERE id=$1 FOR SHARE', [user.id])).rows[0];
        if (!actor || actor.role !== 'admin' || actor.status !== 'active' || actor.demo_account || actor.password_change_required)
            throw new ContributionError(403, 'Active administrator access required');
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['ingest', user.id, input.sourceNamespace, input.externalBatchId])]);
        const prior = await previous(db, user, input);
        if (prior) {
            if (prior.package_hash !== validated.report.packageHash)
                throw new ContributionError(409, 'This source and batch key already refer to different content. Use a new revision key; existing data were not overwritten.');
            return { receipt: receiptDto(prior), report: validated.report, replayed: true };
        }
        const batch = importedCopy(validated.batch);
        await saveBatchInTransaction(db, user, batch, validated.files, batch.updatedAt);
        const row = (await db.query(`INSERT INTO calypso_platform.ingestion_receipts(id,owner_id,batch_id,source_namespace,external_batch_id,package_hash,reason,counts)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [randomUUID(), user.id, batch.id, input.sourceNamespace, input.externalBatchId, validated.report.packageHash, input.reason, validated.report.counts])).rows[0];
        await event(db, batch.id, user.id, 'ingestion.imported', { receiptId: row.id, sourceNamespace: input.sourceNamespace, externalBatchId: input.externalBatchId, packageHash: row.package_hash, reason: input.reason });
        return { receipt: receiptDto(row), report: validated.report, replayed: false };
    });
}
export async function listImports(pool, user, params) {
    requireAdmin(user);
    if ([...params.keys()].some(k => !['offset', 'limit'].includes(k)) || ['offset', 'limit'].some(k => params.getAll(k).length > 1))
        throw new ContributionError(400, 'Unsupported import list criteria');
    const offset = Number(params.get('offset') ?? 0), limit = Number(params.get('limit') ?? 20);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new ContributionError(400, 'Use an offset and a limit between 1 and 100');
    const total = Number((await pool.query('SELECT count(*) FROM calypso_platform.ingestion_receipts WHERE owner_id=$1', [user.id])).rows[0].count);
    const rows = (await pool.query(`SELECT i.*,b.review_status,b.deleted_at,b.updated_at,b.draft_json->>'title' AS title,b.draft_json->>'visibility' AS visibility
  FROM calypso_platform.ingestion_receipts i JOIN calypso_platform.batches b ON b.id=i.batch_id WHERE i.owner_id=$1 ORDER BY i.created_at DESC,i.id LIMIT $2 OFFSET $3`, [user.id, limit, offset])).rows;
    return { total, offset, limit, items: rows.map(row => ({ ...receiptDto(row), title: row.title, visibility: row.visibility, review: row.review_status, archived: !!row.deleted_at, updatedAt: row.updated_at.toISOString() })) };
}
