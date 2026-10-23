import { createHash } from 'node:crypto';
import { batchSchema, safePath, fileBytes, hashBytes, inspectFile, batchReadiness } from '../domain/materials/batch-contribution.ts';
import { ContributionError } from './errors.mjs';
// Sort object keys, preserve scientific array order and the original numeric strings.
export function stableJson(value) {
    if (Array.isArray(value))
        return '[' + value.map(stableJson).join(',') + ']';
    if (value && typeof value === 'object')
        return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
    return JSON.stringify(value);
}
/** Transport IDs/timestamps do not change package identity. Associations and all scientific context do. */
export function packageFingerprint(batch) {
    const phases = new Map(batch.phases.map((p, i) => [p.id, 'phase:' + i]));
    const conditions = new Map(batch.conditions.map((c, i) => [c.id, 'condition:' + i]));
    const records = new Map(batch.records.map((r, i) => [r.id, 'record:' + i]));
    const files = new Map(batch.files.map(f => [f.id, f.path]));
    const content = { schemaVersion: 3, title: batch.title, visibility: batch.visibility, contributor: batch.contributor,
        permissionConfirmed: batch.permissionConfirmed, computationRequested: batch.computationRequested,
        phases: batch.phases.map(p => ({ ...p, id: phases.get(p.id) })),
        conditions: batch.conditions.map(c => ({ ...c, id: conditions.get(c.id), phaseId: phases.get(c.phaseId) })),
        files: batch.files.map(({ id, contentBase64, ...f }) => f).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
        records: batch.records.map(r => ({ ...r, id: records.get(r.id), fileId: files.get(r.fileId), phaseId: phases.get(r.phaseId), conditionId: conditions.get(r.conditionId),
            phaseLabel: batch.phases.find(p => p.id === r.phaseId)?.name ?? '', structureRecordId: r.structureRecordId ? (records.get(r.structureRecordId) ?? 'unresolved:' + r.structureRecordId) : '' })),
    };
    return createHash('sha256').update(stableJson(content)).digest('hex');
}
export async function checkedFiles(batch) {
    const files = [];
    for (const file of batch.files) {
        safePath(file.path);
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64))
            throw new ContributionError(400, 'Invalid file encoding');
        const bytes = fileBytes(file);
        if (await hashBytes(bytes) !== file.sha256)
            throw new ContributionError(400, 'File checksum mismatch: ' + file.path);
        files.push({ file, bytes: Buffer.from(bytes) });
    }
    return files;
}
/** One authoritative validator, used by normal saves, internal imports, previews and submission. */
export async function validatePackage(input) {
    const batch = batchSchema.parse(input);
    if (batch.exampleOnly)
        throw new ContributionError(400, 'Teaching examples cannot be saved as research data');
    const files = await checkedFiles(batch);
    const inspections = Object.fromEntries(batch.files.map(f => [f.id, inspectFile(f)]));
    const readiness = batchReadiness(batch, inspections);
    const issues = [...readiness.batchIssues.map(message => ({ scope: 'batch', recordId: null, message })),
        ...Object.entries(readiness.issues).flatMap(([recordId, messages]) => messages.map(message => ({ scope: 'record', recordId, message })))];
    const report = { schemaVersion: 3, packageHash: packageFingerprint(batch), canSubmit: issues.length === 0,
        counts: { phases: batch.phases.length, conditions: batch.conditions.length, records: batch.records.length, files: batch.files.length, bytes: batch.files.reduce((sum, f) => sum + f.size, 0), ready: readiness.ready }, issues };
    return { batch, files, report };
}
