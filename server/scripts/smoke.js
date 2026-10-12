// End-to-end check against the RUNNING API: upload 3 sample contracts and compare findings to expected.json
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.API || 'http://localhost:4000/api';
const dir = path.dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(await fs.readFile(path.join(dir, '../data/contracts/expected.json'), 'utf8'));
const j = async (url, opts) => { const r = await fetch(BASE + url, { headers: { 'Content-Type': 'application/json' }, ...opts }); const b = await r.json(); if (!r.ok) throw new Error(b.error); return b; };
let failed = 0;

const health = await j('/health');
console.log(`API ok. LLM=${health.llmProvider} embeddings=${health.embedProvider} policies=${health.policies}`);
if (health.warning) { console.log('WARNING:', health.warning); process.exit(1); }

const samples = await j('/contracts/samples');
for (const file of samples) {
  const base = file.replace(/\.[^.]+$/, '');
  if (!expected[base]) continue;
  const { id } = await j('/contracts/from-sample', { method: 'POST', body: JSON.stringify({ filename: file }) });
  let data;
  for (let i = 0; i < 120; i++) {
    data = await j(`/contracts/${id}`);
    if (data.contract.status !== 'processing') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (data.contract.status !== 'done') { console.log(`FAIL ${file}: status ${data.contract.status} ${data.contract.error || ''}`); failed++; continue; }
  const got = new Set(data.findings.map((f) => f.policy_id));
  const want = new Set(expected[base]);
  const missing = [...want].filter((x) => !got.has(x));
  const extra = [...got].filter((x) => !want.has(x));
  const unverified = data.findings.filter((f) => !f.verified).length;
  const ok = !missing.length && !extra.length && !unverified;
  console.log(`${ok ? 'PASS' : 'DIFF'} ${file}: ${data.clauses.length} clauses, ${data.findings.length} findings` +
    (missing.length ? `\n     missing: ${missing.join(', ')}` : '') + (extra.length ? `\n     extra: ${extra.join(', ')}` : '') + (unverified ? `\n     unverified quotes: ${unverified}` : ''));
  if (!ok) failed++;
}
console.log(failed ? '\nSome checks differed. With the mock provider this should be zero; with a real LLM small differences are normal.' : '\nAll checks passed.');
process.exit(failed && health.llmProvider === 'mock' ? 1 : 0);
