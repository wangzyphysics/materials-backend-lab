import { spawn } from 'node:child_process';
import { access, mkdir, readFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ROOT } from '../src/model.mjs';

process.umask(0o077);
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node scripts/package-backend.mjs OUTPUT.tar.gz');
const output = path.resolve(destination);
const root = path.resolve(ROOT);
if (output.startsWith(root + path.sep) && !output.startsWith(path.join(root, '.local') + path.sep))
  throw new Error('Put the archive outside the backend directory or inside its excluded .local directory.');
try { await access(output); throw new Error('Output already exists; choose a new archive path.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
const name = path.basename(root);
await new Promise((resolve, reject) => {
  const args = [...(process.platform === 'darwin' ? ['--no-xattrs'] : []), '--exclude=' + name + '/node_modules', '--exclude=' + name + '/.local',
    '--exclude=' + name + '/artifacts', '--exclude=' + name + '/.git', '--exclude=__pycache__',
    '--exclude=.DS_Store', '--exclude=*.log', '-czf', output, '-C', path.dirname(root), name];
  // macOS file provenance/xattrs are irrelevant to the Linux deployment.
  const child = spawn('tar', args, { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1', COPY_EXTENDED_ATTRIBUTES_DISABLE: '1' } });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error('Backend packaging failed: ' + code)));
});
await chmod(output, 0o600);
console.log(JSON.stringify({ archive: output,
  sha256: createHash('sha256').update(await readFile(output)).digest('hex'),
  includes: 'Backend source, domain validation, package manifests, samples, scripts, tests, inspection page and docs.',
  excludes: 'Database files, credentials, node_modules and historical verification artifacts.' }, null, 2));
