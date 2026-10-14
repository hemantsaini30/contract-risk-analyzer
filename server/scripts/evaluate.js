// Offline evaluation.
//   npm run eval --prefix server                     -> data/eval/labeled_clauses.json   (original dev set)
//   npm run eval --prefix server -- holdout          -> data/eval/holdout_clauses.json
//   npm run eval --prefix server -- dev2             -> data/eval/dev2_clauses.json
//   npm run eval --prefix server -- holdout2         -> data/eval/holdout2_clauses.json
// Extra flags:  retrieval  = stop after the retrieval table (no LLM calls)
//               --fresh    = ignore the saved LLM answers and ask the model again
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, assertProviderKeys } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { embed } from '../src/services/embeddings.js';
import { retrieve } from '../src/services/retrieval.js';
import { analyzeClause } from '../src/services/llm.js';
import { SYSTEM_PROMPT, buildUserPrompt } from '../src/services/prompts.js';
import { verifyFinding } from '../src/services/verify.js';

assertProviderKeys();
const args = process.argv.slice(2);
const RETRIEVAL_ONLY = args.includes('retrieval');
const FRESH = args.includes('--fresh');
const setName = args.find((a) => a !== 'retrieval' && a !== '--fresh') || null;
const dir = path.dirname(fileURLToPath(import.meta.url));
const labeled = JSON.parse(await fs.readFile(path.join(dir, `../data/eval/${setName ? `${setName}_clauses` : 'labeled_clauses'}.json`), 'utf8'));
// The two original sets contain only NDA clauses. Newer sets tag every clause with "contract_type".
const DEFAULT_TYPE = !setName || setName === 'holdout' ? 'nda' : null;
const typeOf = (l) => l.contract_type || DEFAULT_TYPE;
const reportFile = `../data/eval/${setName ? `last_report_${setName}` : 'last_report'}.json`;
const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%';

if (setName?.startsWith('holdout')) console.log('\n*** HOLDOUT SET: run this once for your final number. Do NOT edit prompts, policies or labels based on these results. ***');
const { rows: [{ n: policyCount }] } = await pool.query('SELECT COUNT(*)::int AS n FROM policies');
console.log(`\nEvaluating ${labeled.length} labeled clauses from "${setName || 'labeled'}"  (LLM=${config.llmProvider}, embeddings=${config.embedProvider}, ${policyCount} policies in DB)`);
const typeCounts = labeled.reduce((a, l) => ({ ...a, [typeOf(l) || 'untyped']: (a[typeOf(l) || 'untyped'] || 0) + 1 }), {});
console.log(`retrieval mode for the end-to-end run: ${config.retrievalMode}, top ${config.topK} policies sent to the LLM`);
console.log(`contract types in this set: ${JSON.stringify(typeCounts)}  (clauses are only checked against policies of their own type)\n`);
const vectors = await embed(labeled.map((l) => l.clause));

/* ---------- 1. Retrieval ---------- */
const modes = ['vector', 'keyword', 'hybrid', 'hybrid_rerank'];
const ks = [...new Set([1, 3, config.topK, 5, 8])].sort((a, b) => a - b);
const withExpected = labeled.map((l, i) => ({ ...l, i })).filter((l) => l.expected.length);
const totalExpected = withExpected.reduce((s, l) => s + l.expected.length, 0);

console.log('RETRIEVAL  (did the right policy reach the top-k?)');
console.log('mode              ' + ks.map((k) => `recall@${k}`.padEnd(11)).join('') + `(* = what the LLM sees)`);
const retrievalReport = {};
for (const mode of modes) {
  const hits = Object.fromEntries(ks.map((k) => [k, 0]));
  const notReached = [];
  for (const l of withExpected) {
    const ranked = (await retrieve(l.clause, { mode, topK: Math.max(...ks), embedding: vectors[l.i], contractType: typeOf(l) })).map((r) => r.policy_id);
    for (const k of ks) hits[k] += l.expected.filter((e) => ranked.slice(0, k).includes(e.policy_id)).length;
    for (const x of l.expected) if (!ranked.slice(0, config.topK).includes(x.policy_id)) notReached.push(`${l.id}:${x.policy_id.replace('POL-', '')}`);
  }
  retrievalReport[mode] = { ...Object.fromEntries(ks.map((k) => [`recall@${k}`, hits[k] / totalExpected])), notInTopK: notReached };
  console.log(`${mode.padEnd(16)}  ` + ks.map((k) => (pct(hits[k] / totalExpected) + (k === config.topK ? '*' : ' ')).padEnd(11)).join(''));
  if (notReached.length) console.log(`                  never reach the LLM: ${notReached.join(', ')}`);
}
if (RETRIEVAL_ONLY) { await pool.end(); process.exit(0); }

/* ---------- 2. End-to-end analysis (with a cache so a crashed run can resume) ---------- */
const cachePath = path.join(dir, '../data/eval/.llm_cache.json');
let cache = {};
if (config.llmProvider !== 'mock' && !FRESH) { try { cache = JSON.parse(await fs.readFile(cachePath, 'utf8')); } catch { /* no cache yet */ } }
const MODEL = { openai: config.openaiLlmModel, gemini: config.geminiLlmModel, anthropic: config.anthropicModel, groq: config.groqModel }[config.llmProvider] || 'mock';
let cacheHits = 0;
async function analyzeCached(clause, retrieved) {
  if (config.llmProvider === 'mock') return analyzeClause(clause, retrieved);
  // the key covers provider, model, system prompt, clause and the exact policies shown -> any change re-asks the model
  const key = crypto.createHash('sha1').update([config.llmProvider, MODEL, SYSTEM_PROMPT, buildUserPrompt(clause, retrieved)].join('\n---\n')).digest('hex');
  if (cache[key]) { cacheHits++; return cache[key]; }
  const result = await analyzeClause(clause, retrieved);
  cache[key] = result;
  await fs.writeFile(cachePath, JSON.stringify(cache));
  return result;
}

let errors = 0;
process.on('exit', () => { if (errors) console.log(`\nWARNING: ${errors} clause(s) were skipped because the LLM call failed. The numbers above exclude them. Run again: finished clauses are cached.`); });
let acceptedExtras = 0;
const unverified = [];
let tp = 0, fp = 0, fn = 0, sevOk = 0, verified = 0, totalFindings = 0, cleanTotal = 0, cleanFlagged = 0;
const misses = [], falseAlarms = [], sevWrong = [];
const records = [], tpConf = [], fpConf = [];

for (let i = 0; i < labeled.length; i++) {
  const l = labeled[i];
  const retrieved = await retrieve(l.clause, { topK: config.topK, embedding: vectors[i], contractType: typeOf(l) });
  let findings;
  try {
    ({ findings } = await analyzeCached({ number: null, text: l.clause }, retrieved));
  } catch (err) {
    console.log(`  ! ${l.id} skipped: ${String(err.message).slice(0, 140)}`);
    errors++;
    continue;
  }
  process.stdout.write(`  analysed ${i + 1}/${labeled.length}\r`);
  const checked = findings.map((f) => verifyFinding(f, l.clause, retrieved)).filter(Boolean);

  totalFindings += checked.length;
  verified += checked.filter((f) => f.verified).length;
  for (const f of checked) {
    if (f.verified) continue;
    if (f.contract_quote_start == null) unverified.push(`${l.id} ${f.policy_id}: CONTRACT quote not found in clause -> "${f.contract_quote}"`);
    if (f.policy_quote_start == null) unverified.push(`${l.id} ${f.policy_id}: POLICY quote not found in policy text -> "${f.policy_quote}"`);
  }

  const predicted = new Map(checked.map((f) => [f.policy_id, f]));
  const expected = new Map(l.expected.map((e) => [e.policy_id, e]));
  records.push({ pred: checked.map((f) => ({ pid: f.policy_id, conf: f.confidence })), expected: l.expected.map((e) => e.policy_id), extras: l.acceptable_extra || [] });
  for (const [pid, f] of predicted) {
    if (expected.has(pid)) {
      tp++;
      tpConf.push(f.confidence);
      if (f.severity === expected.get(pid).severity) sevOk++;
      else sevWrong.push(`${l.id} ${pid}: expected ${expected.get(pid).severity}, got ${f.severity}`);
    } else if ((l.acceptable_extra || []).includes(pid)) {
      acceptedExtras++; // a defensible extra finding (decided when labelling): neither a hit nor a false alarm
    } else {
      fp++;
      fpConf.push(f.confidence);
      falseAlarms.push(`${l.id} flagged ${pid} (confidence ${f.confidence.toFixed(2)}): ${f.reasoning.slice(0, 170)}\n      clause: "${l.clause.slice(0, 110)}"`);
    }
  }
  for (const pid of expected.keys()) {
    if (!predicted.has(pid)) {
      const seen = retrieved.some((r) => r.policy_id === pid);
      fn++;
      misses.push(`${l.id} missed ${pid}  [${seen ? 'policy WAS retrieved, the LLM said no' : 'policy was NOT retrieved, the LLM never saw it'}]${l.note ? `  (${l.note})` : ''}`);
    }
  }
  if (!l.expected.length) { cleanTotal++; if (checked.length) cleanFlagged++; }
}

const precision = tp / Math.max(tp + fp, 1), recall = tp / Math.max(tp + fn, 1);
const f1 = (2 * precision * recall) / Math.max(precision + recall, 1e-9);

console.log('\nEND-TO-END DETECTION');
console.log(`precision            ${pct(precision)}`);
console.log(`recall               ${pct(recall)}`);
console.log(`F1                   ${pct(f1)}`);
console.log(`severity accuracy    ${pct(sevOk / Math.max(tp, 1))}   (severity comes from each policy, so this is ~100% by construction)`);
console.log(`citation accuracy    ${pct(verified / Math.max(totalFindings, 1))}   (quotes verified in source text)`);
console.log(`false alarms on clean clauses  ${cleanFlagged}/${cleanTotal}`);
if (acceptedExtras) console.log(`accepted extra findings        ${acceptedExtras}   (marked acceptable_extra in the labels, not counted as errors)`);
if (cacheHits) console.log(`answers reused from cache      ${cacheHits}   (use --fresh to ask the model again)`);
const avg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 'n/a');
console.log(`\nCONFIDENCE  average for correct findings ${avg(tpConf)} (n=${tpConf.length})  |  for false alarms ${avg(fpConf)} (n=${fpConf.length})`);
console.log('What if only findings at or above a confidence threshold were trusted?');
console.log('threshold   precision   recall      F1    clean clauses flagged');
const confidenceSweep = [];
for (const t of [0, 0.7, 0.8, 0.85, 0.9, 0.95]) {
  let a = 0, b = 0, c = 0, flagged = 0, clean = 0;
  for (const r of records) {
    const got = new Set(r.pred.filter((x) => x.conf >= t).map((x) => x.pid));
    for (const pid of got) { if (r.expected.includes(pid)) a++; else if (!r.extras.includes(pid)) b++; }
    for (const pid of r.expected) if (!got.has(pid)) c++;
    if (!r.expected.length) { clean++; if (got.size) flagged++; }
  }
  const pr = a / Math.max(a + b, 1), rc = a / Math.max(a + c, 1), ff = (2 * pr * rc) / Math.max(pr + rc, 1e-9);
  confidenceSweep.push({ threshold: t, precision: pr, recall: rc, f1: ff, cleanFlagged: flagged, cleanTotal: clean });
  console.log(`  >= ${t.toFixed(2)}     ${pct(pr)}     ${pct(rc)}   ${pct(ff)}    ${flagged}/${clean}`);
}
if (unverified.length) console.log('\nUnverified evidence (quote the model gave that is not in the source text):\n  ' + unverified.join('\n  '));
if (misses.length) console.log('\nMissed:\n  ' + misses.join('\n  '));
if (falseAlarms.length) console.log('\nFalse alarms:\n  ' + falseAlarms.join('\n  '));
if (sevWrong.length) console.log('\nWrong severity:\n  ' + sevWrong.join('\n  '));

const report = { set: setName || 'labeled', when: new Date().toISOString(), llm: config.llmProvider, embeddings: config.embedProvider, retrievalMode: config.retrievalMode, topK: config.topK, policies: policyCount,
  retrieval: retrievalReport, detection: { precision, recall, f1, severityAccuracy: sevOk / Math.max(tp, 1), citationAccuracy: verified / Math.max(totalFindings, 1), cleanFlagged, cleanTotal, acceptedExtras },
  misses, falseAlarms, sevWrong, unverified, confidenceSweep };
await fs.writeFile(path.join(dir, reportFile), JSON.stringify(report, null, 2));
console.log(`\nSaved server/data/eval/${path.basename(reportFile)}`);
await pool.end();