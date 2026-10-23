import pg from 'pg';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../src/model.mjs';
import { openRepository } from '../src/repository.mjs';
import { MaterialService } from '../src/service.mjs';

// Copy only the backend to a new directory with no sibling website. Run all
// platform writes in a newly created, disposable database, never the source DB.
const config = JSON.parse(await readFile(path.join(ROOT, '.local/connection.json'), 'utf8'));
const database = 'calypso_independent_' + randomUUID().replaceAll('-', '').slice(0, 16);
const admin = new pg.Client({ ...config, database: 'postgres' });
await admin.connect();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'calypso-independent-'));
const isolated = path.join(temporary, 'materials-backend-lab');
let created = false;
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: isolated, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const capture = chunk => { output = (output + chunk).slice(-6000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) reject(new Error(command + ' failed: ' + output));
      else { console.log(output.trim()); resolve(); }
    });
  });
}
try {
  const source = await openRepository();
  let snapshot;
  try { snapshot = await new MaterialService(source).exportSnapshot(); } finally { await source.close(); }
  await admin.query('CREATE DATABASE "' + database + '"'); created = true;
  const excluded = ['node_modules', '.local', 'artifacts', '.git'].map(name => path.join(path.resolve(ROOT), name));
  await cp(ROOT, isolated, { recursive: true, filter: file => !excluded.some(dir => path.resolve(file) === dir || path.resolve(file).startsWith(dir + path.sep)) });
  await mkdir(path.join(isolated, '.local'), { mode: 0o700 });
  await writeFile(path.join(isolated, '.local/connection.json'), JSON.stringify({ ...config, database }), { mode: 0o600 });
  await writeFile(path.join(isolated, '.local/source.json'), JSON.stringify(snapshot), { mode: 0o600 });
  // This runs on the current host; it is not a Linux runtime test. Explicitly
  // omit native optional binaries using the same install command as the server.
  await run('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund']);
  await run(process.execPath, ['--input-type=module', '-e', `
    import {readFile} from 'node:fs/promises';
    const {openRepository}=await import(${JSON.stringify(pathToFileURL(path.join(isolated, 'src/repository.mjs')).href)});
    const {MaterialService}=await import(${JSON.stringify(pathToFileURL(path.join(isolated, 'src/service.mjs')).href)});
    const repo=await openRepository();
    try {await new MaterialService(repo).restoreSnapshot(JSON.parse(await readFile('.local/source.json','utf8')));}
    finally {await repo.close();}
  `]);
  await run('npm', ['run', 'platform:domain:test']);
  // Existing showcase assertions require explicitly marked demo fixtures.
  // Seed them only in the disposable database, not the source platform.
  await run('npm', ['run', 'platform:showcase']);
  await run('npm', ['run', 'platform:test']);
  console.log('PASS: standalone backend production install and platform API tests; no sibling website, no source-database test writes.');
} finally {
  if (created) await admin.query('DROP DATABASE "' + database + '" WITH (FORCE)');
  await admin.end();
  await rm(temporary, { recursive: true, force: true });
}
