import { config, EMBED_DIM } from '../config.js';
import { tokenize, stem } from '../utils/text.js';

/* ---------- MOCK: hashed bag-of-words (no API key needed) ----------
   This is lexical, NOT truly semantic. It only exists so you can run the whole
   pipeline offline. A synonym map fakes a little semantics. Use a real embedding
   model for real accuracy. */
const SYNONYMS = {
  secret: 'confidential', proprietary: 'confidential', nondisclosure: 'confidential',
  perpetuity: 'perpetual', indefinitely: 'perpetual', indefinite: 'perpetual', forever: 'perpetual',
  cancel: 'terminat', terminate: 'terminat', terminating: 'terminat',
  jurisdiction: 'govern', law: 'govern', laws: 'govern',
  cap: 'limit', ceiling: 'limit', unlimited: 'limit', uncapped: 'limit', limitation: 'limit',
  damages: 'liabil', liable: 'liabil', liability: 'liabil', losses: 'liabil',
  indemnify: 'indemn', indemnification: 'indemn', indemnity: 'indemn',
  destroy: 'return', destruction: 'return', delete: 'return',
  poach: 'solicit', hire: 'solicit', recruit: 'solicit',
  compete: 'compet', exclusivity: 'compet', exclusive: 'compet',
  transfer: 'assign', novation: 'assign',
  arbitration: 'arbitr', arbitrator: 'arbitr', tribunal: 'arbitr',
  injunction: 'injunct', equitable: 'injunct', injunctive: 'injunct',
  residual: 'residu', memory: 'residu', unaided: 'residu',
  subpoena: 'compel', compelled: 'compel', court: 'compel',
  logo: 'publicit', press: 'publicit', marketing: 'publicit', trademark: 'publicit',
  inspect: 'audit', inspection: 'audit', premises: 'audit',
  marked: 'mark', designated: 'mark', labelled: 'mark', labeled: 'mark',
  gdpr: 'privacy', personal: 'privacy', data: 'privacy',
};

const SYN = Object.fromEntries(Object.entries(SYNONYMS).map(([k, v]) => [stem(k), v]));

function fnv(str, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mockEmbedOne(text) {
  const v = new Float64Array(EMBED_DIM);
  const toks = tokenize(text).map((t) => SYN[t] || t);
  const add = (tok, w) => {
    v[fnv(tok) % EMBED_DIM] += (fnv(tok, 99) & 1 ? 1 : -1) * w;
  };
  toks.forEach((t, i) => {
    add(t, 1);
    if (i > 0) add(`${toks[i - 1]}_${t}`, 0.5);
  });
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return Array.from(v, (x) => x / norm);
}

/* ---------- Real providers ---------- */
async function postJson(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Embedding API ${res.status}: ${raw.slice(0, 300)}`);
  return JSON.parse(raw);
}

async function openaiEmbed(texts) {
  const data = await postJson(
    'https://api.openai.com/v1/embeddings',
    { model: config.openaiEmbedModel, input: texts, dimensions: EMBED_DIM },
    { Authorization: `Bearer ${config.openaiKey}` }
  );
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function geminiEmbed(texts) {
  const model = config.geminiEmbedModel;
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${config.geminiKey}`,
    {
      requests: texts.map((t) => ({
        model: `models/${model}`,
        content: { parts: [{ text: t }] },
        outputDimensionality: EMBED_DIM,
      })),
    }
  );
  return data.embeddings.map((e) => {
    const norm = Math.sqrt(e.values.reduce((s, x) => s + x * x, 0)) || 1; // reduced dims need re-normalising
    return e.values.map((x) => x / norm);
  });
}

/** embed(["text", ...]) -> number[][]  (each vector has EMBED_DIM numbers) */
export async function embed(texts) {
  if (!texts.length) return [];
  if (config.embedProvider === 'mock') return texts.map(mockEmbedOne);
  const fn = config.embedProvider === 'openai' ? openaiEmbed : geminiEmbed;
  const out = [];
  for (let i = 0; i < texts.length; i += 50) out.push(...(await fn(texts.slice(i, i + 50))));
  return out;
}
