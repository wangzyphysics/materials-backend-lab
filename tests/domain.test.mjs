import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/model.mjs';
import { registrationSchema, emptyProfile } from '../src/domain/accounts/model.ts';
import { normalizeSearch } from '../src/domain/materials/search.ts';
import { aggregateCountries } from '../src/domain/materials/country-regions.ts';
import { inspectFile, makeDraftFile } from '../src/domain/materials/batch-contribution.ts';

test('backend registration validates its own required fields and rejects caller privileges', () => {
  const payload = { username: 'independent.qa', email: 'Independent@Example.TEST', password: 'QA password only 42',
    profile: { ...emptyProfile('Independent QA'), institution: 'QA Institute', researchGroup: 'QA group', careerStage: 'doctoral' } };
  assert.equal(registrationSchema.parse(payload).email, 'independent@example.test');
  assert.throws(() => registrationSchema.parse({ ...payload, role: 'admin' }));
  assert.throws(() => registrationSchema.parse({ ...payload, profile: { ...payload.profile, institution: '' } }));
});
test('backend scientific input and statistics retain existing semantics', async () => {
  assert.equal(normalizeSearch('Fe₂O₃'), 'Fe2O3');
  assert.equal(aggregateCountries(['China', 'CN', '中国']).regions[0].countryCode, 'CHN');
  const file = await makeDraftFile('qa.csv', new TextEncoder().encode('100,0\n200,1\n'), 'text/csv');
  assert.ok(inspectFile(file));
});
test('runtime, scripts and tests resolve relative source imports within the backend', async () => {
  const root = path.resolve(ROOT);
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!/\.(?:mjs|ts)$/.test(entry.name)) continue;
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
        const resolved = path.resolve(path.dirname(file), match[1]);
        assert.ok(resolved.startsWith(root + path.sep), 'Source import escapes backend: ' + file + ' → ' + match[1]);
        await access(resolved);
      }
    }
  }
  for (const dir of ['src', 'scripts', 'tests']) await walk(path.join(root, dir));
});
