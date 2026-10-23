import { writeFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { batchSchema } from '../src/domain/materials/batch-contribution.ts';
import { prepareManifest, readJsonFile } from '../src/ingestion/prepare.mjs';
import { validatePackage } from '../src/ingestion/validation.mjs';
import { createIngestionClient } from '../src/ingestion/http-client.mjs';
const help = `CALYPSO data imports — same contract and API as Contribute

Offline:
  prepare --manifest manifest.csv --directory ./files --metadata metadata.json --out package.json
  check --input package.json
Authenticated (private credentials JSON: url, origin, username, password):
  validate --input package.json --credentials /private/import-login.json --source lab --key run-001 --reason "Import instrument run"
  upload   --input package.json --credentials /private/import-login.json --source lab --key run-001 --reason "Import instrument run"
  list     --credentials /private/import-login.json
  status   --batch UUID --credentials /private/import-login.json
  submit   --batch UUID --credentials /private/import-login.json

Upload saves a private-to-owner draft. Publication still requires submission,
review and public intent. Check reports do not certify scientific validity.
Limits: 100 files / 10 MiB each / 50 MiB total / 300 records per batch.
`;
export async function runCli(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: Object.fromEntries(['manifest', 'directory', 'metadata', 'out', 'input', 'credentials', 'source', 'key', 'reason', 'batch', 'offset', 'limit'].map(k => [k, { type: 'string' }]).concat([['help', { type: 'boolean' }]])) });
    const [command] = positionals;
    if (values.help || !command) {
        console.log(help);
        return;
    }
    if (positionals.length !== 1)
        throw new Error('Use exactly one command');
    const required = key => { if (!values[key])
        throw new Error('Missing --' + key); return values[key]; };
    if (command === 'prepare') {
        const draft = await prepareManifest(required('manifest'), required('directory'), values.metadata ? await readJsonFile(values.metadata, 1024 * 1024) : {});
        const output = required('out');
        await writeFile(output, JSON.stringify(draft, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ output, report: (await validatePackage(draft)).report }, null, 2));
        return;
    }
    if (command === 'check') {
        const report = (await validatePackage(await readJsonFile(required('input')))).report;
        console.log(JSON.stringify(report, null, 2));
        if (!report.canSubmit) process.exitCode = 2;
        return;
    }
    if (!['validate', 'upload', 'list', 'status', 'submit'].includes(command))
        throw new Error('Unknown command; use --help');
    // Read credentials only after command validation. Do not accept credentials on command lines.
    const credentialFile = required('credentials'), info = await stat(credentialFile);
    if (process.platform !== 'win32' && (info.mode & 0o077))
        throw new Error('Credentials file must be private: chmod 600 FILE');
    const client = createIngestionClient(await readJsonFile(credentialFile, 16384));
    try {
        await client.login();
        let result;
        if (command === 'list')
            result = await client.list(values.offset ?? 0, values.limit ?? 20);
        else if (command === 'status')
            result = await client.status(required('batch'));
        else if (command === 'submit')
            result = await client.submit(required('batch'));
        else {
            const input = { draft: batchSchema.parse(await readJsonFile(required('input'))), sourceNamespace: required('source'), externalBatchId: required('key'), reason: required('reason') };
            result = command === 'validate' ? await client.preview(input) : await client.upload(input);
        }
        console.log(JSON.stringify(result, null, 2));
        if (command === "validate") {
            if (result.action === "conflict") process.exitCode = 3;
            else if (!result.report.canSubmit) process.exitCode = 2;
        }
    }
    finally {
        await client.close();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        await runCli(process.argv.slice(2));
    }
    catch (error) {
        console.error(JSON.stringify({ error: error.message, ...(error.status ? { status: error.status } : {}), ...(error.issues ? { issues: error.issues } : {}) }));
        process.exitCode = 1;
    }
}
