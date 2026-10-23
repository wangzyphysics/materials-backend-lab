import pg from 'pg';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../src/model.mjs';

process.umask(0o077);

const quote = value => '"' + value.replaceAll('"', '""') + '"';
const hash = value => createHash('sha256').update(value).digest('hex');
async function run(command, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`pg_dump failed (${code}): ${error}`)));
  });
}
async function inventory(client) {
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await client.query("SET LOCAL DateStyle TO 'ISO, MDY'");
  await client.query("SET LOCAL bytea_output TO 'hex'");
  const tables = {};
  const names = (await client.query(`SELECT n.nspname AS schema,c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='r' AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND n.nspname <> 'information_schema' ORDER BY n.nspname,c.relname`)).rows;
  for (const { schema, name } of names) {
    const relation = `${quote(schema)}.${quote(name)}`;
    const columns = (await client.query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated
      FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [relation])).rows;
    const rows = (await client.query(`SELECT row_to_json(t)::jsonb::text AS row FROM ${relation} t
      ORDER BY row_to_json(t)::jsonb::text COLLATE "C"`)).rows;
    const digest = createHash('sha256');
    for (const row of rows) digest.update(row.row + '\n');
    tables[`${schema}.${name}`] = { count: rows.length, sha256: digest.digest('hex'), columns };
  }
  const sequences = {};
  for (const row of (await client.query(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    ORDER BY n.nspname,c.relname`)).rows) {
    const relation = `${quote(row.schema)}.${quote(row.name)}`;
    sequences[`${row.schema}.${row.name}`] = (await client.query(`SELECT last_value::text,is_called FROM ${relation}`)).rows[0];
  }
  return { tables, sequences };
}

const [action, destination, dumpCommand, configArgument] = process.argv.slice(2);
if (!['backup', 'verify', 'inspect'].includes(action) || !destination)
  throw new Error('Usage: node scripts/migration-backup.mjs backup OUTPUT_DIRECTORY PG_DUMP [CONFIG_FILE] | verify MANIFEST_FILE [CONFIG_FILE] | inspect INVENTORY_FILE [CONFIG_FILE]');
const configFile = action === 'backup' ? configArgument : dumpCommand;
const config = JSON.parse(await readFile(configFile ?? path.join(ROOT, '.local/connection.json'), 'utf8'));
const client = new pg.Client(config);
await client.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  if (action === 'backup') {
    if (!dumpCommand) throw new Error('Supply the absolute path to PostgreSQL 18 pg_dump.');
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const archive = path.join(destination, 'calypso.dump');
    // Never overwrite an existing backup, even after a partially failed attempt.
    for (const file of [archive, path.join(destination, 'manifest.json')]) {
      try { await stat(file); throw new Error('Backup destination already contains output; choose a new directory.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    await run(dumpCommand, ['--host', config.host, '--port', String(config.port), '--username', config.user,
      '--dbname', config.database, '--format=custom', '--no-owner', '--no-acl', '--no-password',
      '--snapshot', snapshot, '--file', archive],
    { ...process.env, PGPASSWORD: config.password, PGCONNECT_TIMEOUT: '15' });
    const report = await inventory(client);
    const manifest = { format: 'calypso-full-pg-backup-v1', created_at: new Date().toISOString(),
      database: config.database, server_version: (await client.query('SHOW server_version')).rows[0].server_version,
      archive_sha256: hash(await readFile(archive)), ...report };
    const { chmod } = await import('node:fs/promises');
    await chmod(archive, 0o600);
    await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: 'backup_created', directory: destination,
      tables: Object.fromEntries(Object.entries(report.tables).map(([name, row]) => [name, row.count])), archive_sha256: manifest.archive_sha256 }, null, 2));
  } else if (action === 'inspect') {
    const report = await inventory(client);
    await writeFile(destination, JSON.stringify({ format: 'calypso-full-pg-inventory-v1', ...report }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: 'inventory_only_not_backup',
      tables: Object.fromEntries(Object.entries(report.tables).map(([name, row]) => [name, row.count])) }, null, 2));
  } else {
    const expected = JSON.parse(await readFile(destination, 'utf8'));
    if (!['calypso-full-pg-backup-v1', 'calypso-full-pg-inventory-v1'].includes(expected.format)) throw new Error('Unsupported backup manifest');
    const actual = await inventory(client);
    const mismatches = [];
    if (JSON.stringify(Object.keys(actual.tables)) !== JSON.stringify(Object.keys(expected.tables))) mismatches.push('table set');
    for (const [name, value] of Object.entries(expected.tables)) {
      const row = actual.tables[name];
      if (!row || row.count !== value.count || row.sha256 !== value.sha256 || JSON.stringify(row.columns) !== JSON.stringify(value.columns)) mismatches.push(name);
    }
    if (JSON.stringify(actual.sequences) !== JSON.stringify(expected.sequences)) mismatches.push('sequences');
    if (mismatches.length) throw new Error('Restored database differs from backup: ' + mismatches.join(', '));
    console.log(JSON.stringify({ status: 'verified', tables: Object.keys(actual.tables).length,
      sequences: Object.keys(actual.sequences).length, table_contents_and_columns: 'identical' }, null, 2));
  }
  await client.query('COMMIT');
} catch (error) { await client.query('ROLLBACK'); throw error; }
finally { await client.end(); }
