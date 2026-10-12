// Offline evaluation on data/eval/labeled_clauses.json
//  - Retrieval: recall@1/3/5 for vector-only vs keyword-only vs hybrid vs hybrid+rerank
//  - Detection: precision / recall / F1 of (clause, policy) conflicts
//  - Severity accuracy, citation accuracy, false-positive rate on clean clauses
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertProviderKeys } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { embed } from '../src/services/embeddings.js';
import { retrieve } from '../src/services/retrieval.js';
import { analyzeClause } from '../src/services/llm.js';
import { verifyFinding } from '../src/services/verify.js';

assertProviderKeys();
const dir = path.dirname(fileURLToPath(import.meta.url));
const labeled = JSON.parse(await fs.readFile(path.join(dir, '../data/eval/labeled_clauses.json'), 'utf8'));
const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%';

console.log(`\nEvaluating ${labeled.length} labeled clauses  (LLM=${config.llmProvider}, embeddings=${config.embedProvider})\n`);
const vectors = await embed(labeled.map((l) => l.clause));

/* ---------- 1. Retrieval ---------- */
const modes = ['vector', 'keyword', 'hybrid', 'hybrid_rerank'];
const withExpected = labeled.map((l, i) => ({ ...l, i })).filter((l) => l.expected.length);
const totalExpected = withExpected.reduce((s, l) => s + l.expected.length, 0);

console.log('RETRIEVAL  (did the right policy reach the top-k?)');
console.log('mode              recall@1  recall@3  recall@5');
const retrievalReport = {};
for (const mode of modes) {
  const hits = { 1: 0, 3: 0, 5: 0 };
  for (const l of withExpected) {
    const ranked = (await retrieve(l.clause, { mode, topK: 5, embedding: vectors[l.i] })).map((r) => r.policy_id);
    for (const k of [1, 3, 5]) hits[k] += l.expected.filter((e) => ranked.slice(0, k).includes(e.policy_id)).length;
  }
  retrievalReport[mode] = { 'recall@1': hits[1] / totalExpected, 'recall@3': hits[3] / totalExpected, 'recall@5': hits[5] / totalExpected };
  console.log(`${mode.padEnd(16)}  ${pct(hits[1] / totalExpected)}   ${pct(hits[3] / totalExpected)}   ${pct(hits[5] / totalExpected)}`);
}

/* ---------- 2. End-to-end analysis ---------- */
let errors = 0;
process.on('exit', () => { if (errors) console.log(`\nWARNING: ${errors} clause(s) were skipped because the LLM call failed. The numbers above exclude them.`); });
let tp = 0, fp = 0, fn = 0, sevOk = 0, verified = 0, totalFindings = 0, cleanTotal = 0, cleanFlagged = 0;
const misses = [], falseAlarms = [], sevWrong = [];

for (let i = 0; i < labeled.length; i++) {
  const l = labeled[i];
  const retrieved = await retrieve(l.clause, { topK: config.topK, embedding: vectors[i] });
  let findings;
  try {
    ({ findings } = await analyzeClause({ number: null, text: l.clause }, retrieved));
  } catch (err) {
    console.log(`  ! ${l.id} skipped: ${String(err.message).slice(0, 140)}`);
    errors++;
    continue;
  }
  process.stdout.write(`  analysed ${i + 1}/${labeled.length}\r`);
  const checked = findings.map((f) => verifyFinding(f, l.clause, retrieved)).filter(Boolean);

  totalFindings += checked.length;
  verified += checked.filter((f) => f.verified).length;

  const predicted = new Map(checked.map((f) => [f.policy_id, f]));
  const expected = new Map(l.expected.map((e) => [e.policy_id, e]));
  for (const [pid, f] of predicted) {
    if (expected.has(pid)) {
      tp++;
      if (f.severity === expected.get(pid).severity) sevOk++;
      else sevWrong.push(`${l.id} ${pid}: expected ${expected.get(pid).severity}, got ${f.severity}`);
    } else { fp++; falseAlarms.push(`${l.id} flagged ${pid}`); }
  }
  for (const pid of expected.keys()) if (!predicted.has(pid)) { fn++; misses.push(`${l.id} missed ${pid}${l.note ? `  (${l.note})` : ''}`); }
  if (!l.expected.length) { cleanTotal++; if (checked.length) cleanFlagged++; }
}

const precision = tp / Math.max(tp + fp, 1), recall = tp / Math.max(tp + fn, 1);
const f1 = (2 * precision * recall) / Math.max(precision + recall, 1e-9);

console.log('\nEND-TO-END DETECTION');
console.log(`precision            ${pct(precision)}`);
console.log(`recall               ${pct(recall)}`);
console.log(`F1                   ${pct(f1)}`);
console.log(`severity accuracy    ${pct(sevOk / Math.max(tp, 1))}   (on correctly detected conflicts)`);
console.log(`citation accuracy    ${pct(verified / Math.max(totalFindings, 1))}   (quotes verified in source text)`);
console.log(`false alarms on clean clauses  ${cleanFlagged}/${cleanTotal}`);
if (misses.length) console.log('\nMissed:\n  ' + misses.join('\n  '));
if (falseAlarms.length) console.log('\nFalse alarms:\n  ' + falseAlarms.join('\n  '));
if (sevWrong.length) console.log('\nWrong severity:\n  ' + sevWrong.join('\n  '));

const report = { when: new Date().toISOString(), llm: config.llmProvider, embeddings: config.embedProvider, retrieval: retrievalReport,
  detection: { precision, recall, f1, severityAccuracy: sevOk / Math.max(tp, 1), citationAccuracy: verified / Math.max(totalFindings, 1), cleanFlagged, cleanTotal }, misses, falseAlarms, sevWrong };
await fs.writeFile(path.join(dir, '../data/eval/last_report.json'), JSON.stringify(report, null, 2));
console.log('\nSaved server/data/eval/last_report.json');
await pool.end();