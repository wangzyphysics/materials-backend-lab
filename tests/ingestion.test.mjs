import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, mkdir, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { newBatch, newPhase, newCondition, defaultRecord, makeDraftFile, batchSchema, importBatchDraft } from '../src/domain/materials/batch-contribution.ts';
import { emptyProfile } from '../src/domain/accounts/model.ts';
import { validatePackage } from '../src/ingestion/validation.mjs';
import { prepareManifest } from '../src/ingestion/prepare.mjs';
import { createIngestionClient } from '../src/ingestion/http-client.mjs';
import { platformPool, migrate, transaction } from '../src/platform/database.mjs';
import { createPlatformServer, createUser } from '../src/platform/server.mjs';
const text = new TextEncoder();
async function fixture() {
    const batch = newBatch(), file = await makeDraftFile('spectrum.csv', text.encode('x,y,repeat\n100,2,3\n200,5,6\n'));
    const phase = { ...newPhase(), formula: 'FeO' }, condition = { ...newCondition(phase.id), pressureMode: 'reported', pressureGPa: '50', temperatureMode: 'reported', temperatureK: '300' };
    const record = { ...defaultRecord(file.id, 1, 'experimental', 'raman'), phaseId: phase.id, conditionId: condition.id, source: 'Disposable ingestion QA fixture', method: 'Synthetic QA measurement' };
    return batchSchema.parse({ ...batch, title: 'Disposable ingestion QA', phases: [phase], conditions: [condition], records: [record, { ...record, id: 'repeat', yColumn: 2, acquisitionLabel: 'Repeat acquisition' }], files: [file], permissionConfirmed: true, contributor: { ...batch.contributor, name: 'QA', email: 'qa@example.test' } });
}
const manifest = 'record_id,file,origin,data_type,phase_key,condition_key,formula,pressure_mode,pressure_gpa,temperature_mode,temperature_k,method,source,y_column\na,spectrum.csv,experimental,raman,p1,c1,FeO,reported,50,reported,300,QA,QA,y\nb,spectrum.csv,theoretical,xrd,p1,c1,FeO,reported,50,reported,300,QA,QA,repeat\n';
test('canonical fingerprints ignore transport IDs but preserve conditions, associations, publication and acquisition semantics', async () => {
    const batch = await fixture(), copy = await importBatchDraft(batch);
    const a = await validatePackage(batch), b = await validatePackage(copy);
    assert.equal(a.report.packageHash, b.report.packageHash);
    assert.equal(a.report.canSubmit, true);
    const extra = {...batch.files[0], id: 'another-file', path: 'additional.csv'};
    const forward = await validatePackage({...batch, files: [...batch.files, extra]});
    const reverse = await validatePackage({...batch, files: [extra, ...batch.files]});
    assert.equal(forward.report.packageHash, reverse.report.packageHash);
    const badLinkA = await validatePackage({...batch, records: batch.records.map(r => ({...r, structureRecordId:'unresolved-a'}))});
    const badLinkB = await validatePackage({...batch, records: batch.records.map(r => ({...r, structureRecordId:'unresolved-b'}))});
    assert.equal(badLinkA.report.canSubmit, false);
    assert.notEqual(badLinkA.report.packageHash, badLinkB.report.packageHash);
    for (const change of [{ ...batch, visibility: 'public-after-review' }, { ...batch, conditions: [{ ...batch.conditions[0], pressureGPa: '51' }] }, { ...batch, records: [batch.records[0], { ...batch.records[1], yColumn: 1 }] }])
        assert.notEqual((await validatePackage(change)).report.packageHash, a.report.packageHash);
    const missing = await validatePackage({ ...batch, permissionConfirmed: false, records: batch.records.map(r => ({ ...r, method: '' })) });
    assert.equal(missing.report.canSubmit, false);
    assert.ok(missing.report.issues.some(i => i.scope === 'batch'));
    assert.ok(missing.report.issues.some(i => i.recordId === 'repeat'));
    await assert.rejects(validatePackage({ ...batch, exampleOnly: true }), /Teaching examples/);
    await assert.rejects(validatePackage({ ...batch, files: [{ ...batch.files[0], sha256: '0'.repeat(64) }] }), /checksum/);
});
test('offline CSV preparation uses the contribution grouping contract, rejects path escapes and preserves original bytes', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'calypso-ingest-'));
    try {
        const dir = path.join(temp, 'files');
        await mkdir(dir);
        await writeFile(path.join(dir, 'spectrum.csv'), 'x,y,repeat\n100,2,3\n200,5,6\n');
        await writeFile(path.join(temp, 'manifest.csv'), manifest);
        const batch = await prepareManifest(path.join(temp, 'manifest.csv'), dir, { title: 'QA', permissionConfirmed: true, contributor: { name: 'QA', email: 'qa@example.test' } });
        assert.equal(batch.phases.length, 1);
        assert.equal(batch.conditions.length, 1);
        assert.equal(batch.records.length, 2);
        assert.equal(batch.files.length, 1);
        assert.equal((await validatePackage(batch)).report.canSubmit, true);
        await writeFile(path.join(temp, 'outside.csv'), 'private test bytes');
        await rm(path.join(dir, 'spectrum.csv'));
        await symlink(path.join(temp, 'outside.csv'), path.join(dir, 'spectrum.csv'));
        await assert.rejects(prepareManifest(path.join(temp, 'manifest.csv'), dir), /escapes/);
    }
    finally {
        await rm(temp, { recursive: true, force: true });
    }
});
test('CLI client rejects insecure credential destinations', () => {
    assert.throws(() => createIngestionClient({ url: 'http://remote.example', origin: 'http://127.0.0.1:5173', username: 'qa', password: 'qa' }), /HTTPS/);
    assert.throws(() => createIngestionClient({ url: 'https://remote.example/api', origin: 'http://127.0.0.1:5173', username: 'qa', password: 'qa' }), /origin/);
});
test('PostgreSQL: ordinary uploads, admin web imports and authenticated CLI share one writer, validation and review', async (t) => {
    const pool = await platformPool();
    await migrate(pool);
    const ids = [];
    let server;
    const temp = await mkdtemp(path.join(tmpdir(), 'calypso-ingest-api-'));
    const origin = 'http://127.0.0.1:5173', password = 'Disposable ingest QA password 73', suffix = randomUUID().slice(0, 8);
    const clients = [];
    try {
        const users = [];
        for (const [i, role] of ['member', 'admin', 'admin'].entries()) {
            const user = await createUser(pool, { username: `qa.ingest.${suffix}.${i}`, email: `qa.ingest.${suffix}.${i}@example.test`, password, profile: { ...emptyProfile('QA ingestion'), institution: 'QA institute', researchGroup: 'QA group', careerStage: 'researcher' } }, { role, test: true });
            ids.push(user.id);
            users.push(user);
        }
        server = await createPlatformServer(pool);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = 'http://127.0.0.1:' + server.address().port;
        function browser() { return { cookie: '', csrf: '', async req(endpoint, method = 'GET', body, extra = {}) { const response = await fetch(base + endpoint, { method, headers: { Origin: origin, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': this.csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) }); const cookie = response.headers.get('set-cookie'); if (cookie)
                this.cookie = cookie.split(';')[0]; const data = await response.json(); if (data.csrfToken)
                this.csrf = data.csrfToken; return { status: response.status, data }; } }; }
        const [member, admin, other] = [browser(), browser(), browser()];
        for (const [i, client] of [member, admin, other].entries()) {
            await client.req('/api/identity/session');
            assert.equal((await client.req('/api/identity/password/sign-in', 'POST', { identity: users[i].username, password })).status, 200);
        }
        const batch = await fixture(), input = { draft: batch, sourceNamespace: 'qa-source', externalBatchId: 'qa-run-' + suffix, reason: 'Disposable ingestion integration test' };
        await t.test('preview is read-only, yields the same report as ordinary contribution validation and rejects privilege forgery', async () => {
            const before = Number((await pool.query('SELECT count(*) FROM calypso_platform.batches WHERE owner_id=$1', [users[1].id])).rows[0].count);
            const preview = await admin.req('/api/contributions/admin/imports/preview', 'POST', input);
            assert.equal(preview.status, 200);
            assert.equal(preview.data.action, 'create');
            assert.equal(preview.data.report.canSubmit, true);
            const normal = await member.req('/api/contributions/validate', 'POST', { draft: batch });
            assert.equal(normal.status, 200);
            assert.deepEqual(normal.data, preview.data.report);
            assert.equal(Number((await pool.query('SELECT count(*) FROM calypso_platform.batches WHERE owner_id=$1', [users[1].id])).rows[0].count), before);
            assert.equal((await member.req('/api/contributions/admin/imports', 'POST', input)).status, 403);
            assert.equal((await admin.req('/api/contributions/admin/imports', 'POST', { ...input, ownerId: users[0].id, role: 'admin' })).status, 400);
            assert.equal((await admin.req('/api/contributions/admin/imports', 'POST', input, { 'X-CSRF-Token': 'bad' })).status, 403);
        });
        let receipt;
        await t.test('concurrent retries return one receipt; imports allocate new graph IDs and ordinary saves remain compatible', async () => {
            const pair = await Promise.all([admin.req('/api/contributions/admin/imports', 'POST', input), admin.req('/api/contributions/admin/imports', 'POST', input)]);
            assert.deepEqual(pair.map(r => r.status), [200, 200]);
            assert.equal(pair[0].data.receipt.id, pair[1].data.receipt.id);
            assert.deepEqual(pair.map(r => r.data.replayed).sort(), [false, true]);
            receipt = pair[0].data.receipt;
            const imported = await admin.req('/api/contributions/batches/' + receipt.batchId);
            assert.equal(imported.status, 200);
            assert.equal(imported.data.state.review, 'not-submitted');
            assert.notEqual(imported.data.draft.phases[0].id, batch.phases[0].id);
            assert.equal(imported.data.draft.files[0].contentBase64, batch.files[0].contentBase64);
            const ordinary = await member.req('/api/contributions/batches/' + batch.id, 'PUT', { draft: batch, expectedUpdatedAt: batch.updatedAt });
            assert.equal(ordinary.status, 200);
            assert.equal(imported.data.draft.records[1].yColumn, ordinary.data.draft.records[1].yColumn);
            assert.equal((await other.req('/api/contributions/batches/' + receipt.batchId)).status, 404);
            assert.equal((await other.req('/api/contributions/admin/imports')).data.total, 0);
            assert.equal((await admin.req('/api/contributions/admin/imports?offset=0&limit=1')).data.items.length, 1);
            assert.equal((await admin.req('/api/contributions/admin/imports?limit=200')).status, 400);
        });
        await t.test('changed content with the same source key is a conflict, copied transport IDs replay and corrupted bytes never write', async () => {
            const changed = await admin.req('/api/contributions/admin/imports', 'POST', { ...input, draft: { ...batch, title: 'Changed content' } });
            assert.equal(changed.status, 409);
            assert.match(changed.data.error, /different content/);
            assert.equal((await admin.req('/api/contributions/admin/imports/preview', 'POST', { ...input, draft: { ...batch, title: 'Changed content' } })).data.action, 'conflict');
            assert.equal((await admin.req('/api/contributions/admin/imports', 'POST', { ...input, draft: await importBatchDraft(batch) })).data.replayed, true);
            const corrupt = { ...input, externalBatchId: 'corrupt', draft: { ...batch, files: [{ ...batch.files[0], sha256: '0'.repeat(64) }] } };
            assert.equal((await admin.req('/api/contributions/admin/imports', 'POST', corrupt)).status, 400);
            assert.equal((await admin.req('/api/contributions/admin/imports')).data.total, 1);
        });
        await t.test('CLI authenticates to the same API, validates and reuses the web receipt without a database connection', async () => {
            const config = { url: base, origin, username: users[1].username, password }, client = createIngestionClient(config);
            clients.push(client);
            await client.login();
            assert.equal((await client.preview(input)).action, 'replay');
            assert.equal((await client.upload(input)).receipt.id, receipt.id);
            await client.close();
            const credentials = path.join(temp, 'credentials.json'), payload = path.join(temp, 'package.json');
            await writeFile(credentials, JSON.stringify(config), { mode: 0o600 });
            await chmod(credentials, 0o600);
            await writeFile(payload, JSON.stringify(batch));
            const result = await new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--experimental-strip-types', 'scripts/ingestion.mjs', 'upload', '--input', payload, '--credentials', credentials, '--source', input.sourceNamespace, '--key', input.externalBatchId, '--reason', input.reason], { cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk); child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr })); });
            assert.equal(result.code, 0, result.stderr);
            assert.equal(JSON.parse(result.stdout).receipt.id, receipt.id);
            assert.ok(!result.stdout.includes(password));
        });
        await t.test('imported data follow ordinary review, privacy and immutable submitted-batch rules', async () => {
            const submit = await admin.req('/api/contributions/batches/' + receipt.batchId + '/submit', 'POST', {});
            assert.equal(submit.status, 200);
            const row = (await admin.req('/api/contributions/batches/' + receipt.batchId)).data;
            assert.equal((await admin.req('/api/contributions/batches/' + receipt.batchId, 'PUT', { draft: row.draft, expectedUpdatedAt: row.draft.updatedAt })).status, 409);
            const reviewed = await other.req('/api/contributions/admin/review/' + receipt.batchId, 'PATCH', { status: 'approved', notes: 'Disposable QA approval', expectedUpdatedAt: submit.data.updatedAt });
            assert.equal(reviewed.status, 200);
            assert.ok(reviewed.data.records.every(r => r.publication === 'private' && r.percent === null));
            const search = await member.req('/api/materials/materials?provenance=contributed');
            assert.equal(search.status, 200);
            assert.ok(!search.data.items.some(r => r.phaseId === row.draft.phases[0].id));
            assert.equal((await admin.req('/api/contributions/batches/' + receipt.batchId, 'DELETE')).status, 200);
            assert.equal((await admin.req('/api/contributions/admin/imports', 'POST', input)).data.replayed, true);
            assert.equal((await admin.req('/api/contributions/admin/imports')).data.items[0].archived, true);
        });
        await t.test('incomplete internal drafts save with a report but cannot submit or become searchable', async () => {
            const incomplete = {...input, externalBatchId: 'incomplete-' + suffix, draft: {...batch, title: '', permissionConfirmed: false}};
            const report = await admin.req('/api/contributions/admin/imports/preview', 'POST', incomplete);
            assert.equal(report.status, 200); assert.equal(report.data.report.canSubmit, false);
            const saved = await admin.req('/api/contributions/admin/imports', 'POST', incomplete);
            assert.equal(saved.status, 200);
            assert.equal((await admin.req('/api/contributions/batches/' + saved.data.receipt.batchId + '/submit', 'POST', {})).status, 400);
        });
    }
    finally {
        for (const client of clients)
            await client.close().catch(() => { });
        if (server)
            await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
        if (ids.length)
            await transaction(pool, async (db) => {
                for (const table of ['batch_events', 'records', 'files', 'contribution_conditions', 'contribution_phases'])
                    await db.query(`DELETE FROM calypso_platform.${table} WHERE batch_id IN (SELECT id FROM calypso_platform.batches WHERE owner_id=ANY($1::uuid[]))`, [ids]);
                await db.query('DELETE FROM calypso_platform.batches WHERE owner_id=ANY($1::uuid[])', [ids]);
                for (const table of ['sessions', 'password_credentials'])
                    await db.query(`DELETE FROM calypso_platform.${table} WHERE user_id=ANY($1::uuid[])`, [ids]);
                await db.query('DELETE FROM calypso_platform.users WHERE id=ANY($1::uuid[])', [ids]);
            });
        await pool.end();
        await rm(temp, { recursive: true, force: true });
    }
});
