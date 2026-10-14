import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST with waiting + retry on rate limits (429), server errors (5xx) and network blips. */
async function postJson(url, body, headers = {}) {
  let rate = 0, other = 0;
  while (true) {
    let res, raw;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      raw = await res.text();
    } catch (e) {
      if (++other > 3) throw e;
      console.log(`[embed] network error (${e.message}). Retrying (${other}/3)...`);
      await sleep(2000 * other);
      continue;
    }
    if (res.ok) return JSON.parse(raw);
    if (res.status === 429) {
      if (/PerDay|per day/i.test(raw)) throw new Error('Embedding API: DAILY free quota used up. Try again tomorrow, or enable billing. (Embeddings are cached on disk, so finished texts will not be asked again.)');
      if (++rate > 5) throw new Error(`Embedding API 429: ${raw.slice(0, 300)}`);
      const m = raw.match(/retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s/) || raw.match(/retry in (\d+(?:\.\d+)?)s/i);
      const wait = Math.min(Math.ceil((m ? Number(m[1]) : 30) * 1000) + 1000, 90_000);
      console.log(`[embed] rate limited (429). Waiting ${Math.round(wait / 1000)}s then retrying (${rate}/5)...`);
      await sleep(wait);
      continue;
    }
    if (res.status >= 500 && ++other <= 3) { await sleep(2000 * other); continue; }
    throw new Error(`Embedding API ${res.status}: ${raw.slice(0, 300)}`);
  }
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

/* Disk cache: the same text + provider + model is never sent to the API twice.
   Saves free-tier quota when you re-run evaluations or re-analyse a contract. Disable with EMBED_CACHE=0. */
const CACHE_FILE = process.env.EMBED_CACHE_FILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/.embed_cache.json');
const CACHE_ON = process.env.EMBED_CACHE !== '0';
let cache = null;
function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }
  return cache;
}
const cacheKey = (text) => {
  const model = config.embedProvider === 'openai' ? config.openaiEmbedModel : config.geminiEmbedModel;
  return crypto.createHash('sha1').update(`${config.embedProvider}|${model}|${EMBED_DIM}|${text}`).digest('hex');
};

/** embed(["text", ...]) -> number[][]  (each vector has EMBED_DIM numbers) */
export async function embed(texts) {
  if (!texts.length) return [];
  if (config.embedProvider === 'mock') return texts.map(mockEmbedOne);

  const c = CACHE_ON ? loadCache() : {};
  const keys = texts.map(cacheKey);
  const missing = [...new Set(texts.map((t, i) => (c[keys[i]] ? null : i)).filter((i) => i !== null).map((i) => texts[i]))];

  if (missing.length) {
    const fn = config.embedProvider === 'openai' ? openaiEmbed : geminiEmbed;
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      const vecs = await fn(batch);
      batch.forEach((t, j) => { c[cacheKey(t)] = vecs[j]; });
      if (CACHE_ON) fs.writeFileSync(CACHE_FILE, JSON.stringify(c)); // save after every batch so a crash loses nothing
    }
  }
  return texts.map((_, i) => c[keys[i]]);
}