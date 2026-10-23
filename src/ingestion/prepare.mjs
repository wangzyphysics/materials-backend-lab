import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { newBatch, makeDraftFile, applyGroupedManifest, parseDelimited, safePath, batchLimits, batchSchema } from '../domain/materials/batch-contribution.ts';
const metadataSchema = z.object({ title: z.string().max(500).optional(), contributor: z.object({ name: z.string(), email: z.string(), institution: z.string().optional(), department: z.string().optional(), researchGroup: z.string().optional(), careerStage: z.string().optional(), orcid: z.string().optional() }).strict().optional(), visibility: z.enum(['private', 'public-after-review']).optional(), permissionConfirmed: z.boolean().optional(), computationRequested: z.boolean().optional() }).strict();
export async function readJsonFile(file, maxBytes = 72 * 1024 * 1024) {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes)
        throw new Error('Choose a regular JSON file within the package size limit');
    return JSON.parse(await readFile(file, 'utf8'));
}
/** CSV uses the existing contribution manifest contract. No directory guessing or arbitrary script execution. */
export async function prepareManifest(manifestFile, directory, metadata = {}) {
    const root = await realpath(directory), info = await stat(manifestFile);
    if (!info.isFile() || info.size > 1024 * 1024)
        throw new Error('Manifest must be a regular CSV file no larger than 1 MiB');
    const text = await readFile(manifestFile, 'utf8'), rows = parseDelimited(text), headings = rows.shift()?.map(h => h.toLowerCase()) ?? [];
    const fileColumn = headings.indexOf('file');
    if (fileColumn < 0)
        throw new Error('Manifest needs a file column');
    const names = [...new Set(rows.map(row => safePath(row[fileColumn] ?? '')))];
    if (names.length > batchLimits.files)
        throw new Error('Too many original files');
    const files = [];
    let total = 0;
    for (const name of names) {
        const file = await realpath(path.join(root, name));
        if (!file.startsWith(root + path.sep))
            throw new Error('File escapes the selected directory: ' + name);
        const info = await stat(file);
        total += info.size;
        if (!info.isFile() || info.size > batchLimits.fileBytes || total > batchLimits.totalBytes)
            throw new Error('Original file size limit exceeded: ' + name);
        files.push(await makeDraftFile(name, new Uint8Array(await readFile(file))));
    }
    const fields = metadataSchema.parse(metadata);
    return applyGroupedManifest(text, files, batchSchema.parse({ ...newBatch(), ...fields, files }));
}
