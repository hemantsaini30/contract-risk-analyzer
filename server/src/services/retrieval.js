import { query, toVector } from '../db/pool.js';
import { tokenize } from '../utils/text.js';
import { embed } from './embeddings.js';

/**
 * Hybrid retrieval of policy rules for one clause.
 *   1. Vector search  (pgvector cosine distance)   -> finds related MEANING
 *   2. Keyword search (Postgres full-text, OR query) -> finds exact TERMS
 *   3. Reciprocal Rank Fusion merges both rankings
 *   4. Light re-rank boosts policies whose title words appear in the clause
 *
 * mode: 'vector' | 'keyword' | 'hybrid' | 'hybrid_rerank'  (the last is the default)
 */
const POOL = 8;
const RRF_K = 60;

async function vectorSearch(embedding) {
  const { rows } = await query(
    `SELECT policy_id, 1 - (embedding <=> $1::vector) AS score
       FROM policies WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector LIMIT ${POOL}`,
    [toVector(embedding)]
  );
  return rows;
}

let dfCache = { at: 0, n: 0, df: new Map() };
async function docFreq() {
  if (Date.now() - dfCache.at < 10_000) return dfCache;
  const { rows: stat } = await query(`SELECT word, ndoc FROM ts_stat('SELECT tsv FROM policies')`);
  const { rows: [{ n }] } = await query('SELECT COUNT(*)::int AS n FROM policies');
  dfCache = { at: Date.now(), n, df: new Map(stat.map((r) => [r.word, Number(r.ndoc)])) };
  return dfCache;
}

/**
 * Keyword search = Postgres full-text matching + IDF weighting (BM25-lite).
 * Plain ts_rank treats every word equally, so a common word like "Northwind" would outrank
 * a rare, meaningful word like "indemnify". We weight each matching word by its rarity instead.
 */
async function keywordSearch(clauseText) {
  const { rows: lex } = await query(`SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('english', $1))) AS w`, [clauseText]);
  const { n, df } = await docFreq();
  const idf = (w) => { const d = df.get(w) || 0; return d ? Math.log(1 + (n - d + 0.5) / (d + 0.5)) : 0; };
  const terms = lex.map((r) => r.w).filter((w) => /^[a-z0-9]+$/.test(w) && idf(w) > 0);
  if (!terms.length) return [];
  const { rows } = await query(
    `SELECT policy_id, tsvector_to_array(tsv) AS lex FROM policies WHERE tsv @@ to_tsquery('simple', $1)`,
    [terms.join(' | ')]
  );
  return rows
    .map((r) => ({ policy_id: r.policy_id, score: terms.filter((t) => r.lex.includes(t)).reduce((s, t) => s + idf(t), 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, POOL);
}

function rerank(clauseText, candidates) {
  const clauseToks = new Set(tokenize(clauseText));
  const maxRrf = Math.max(...candidates.map((c) => c.rrf), 1e-9);
  for (const c of candidates) {
    const titleToks = tokenize(c.title);
    const titleHits = titleToks.filter((t) => clauseToks.has(t)).length;
    const bodyToks = [...new Set(tokenize(c.text))];
    const bodyHits = bodyToks.filter((t) => clauseToks.has(t)).length;
    c.scores.rerank = 0.6 * (c.rrf / maxRrf) + 0.25 * (titleHits / Math.max(titleToks.length, 1)) + 0.15 * (bodyHits / Math.max(bodyToks.length, 1));
  }
  return candidates.sort((a, b) => b.scores.rerank - a.scores.rerank);
}

export async function retrieve(clauseText, { mode = 'hybrid_rerank', topK = 4, embedding } = {}) {
  const useVec = mode !== 'keyword';
  const useKw = mode !== 'vector';
  const emb = useVec ? embedding || (await embed([clauseText]))[0] : null;

  const [vec, kw] = await Promise.all([useVec ? vectorSearch(emb) : [], useKw ? keywordSearch(clauseText) : []]);

  const map = new Map();
  const touch = (policy_id) => {
    if (!map.has(policy_id)) map.set(policy_id, { policy_id, rrf: 0, scores: {} });
    return map.get(policy_id);
  };
  vec.forEach((r, i) => { const c = touch(r.policy_id); c.rrf += 1 / (RRF_K + i + 1); c.scores.vector = Number(r.score); });
  kw.forEach((r, i) => { const c = touch(r.policy_id); c.rrf += 1 / (RRF_K + i + 1); c.scores.keyword = Number(r.score); });

  let candidates = [...map.values()];
  if (!candidates.length) return [];

  const { rows } = await query(
    `SELECT policy_id, title, section, text, default_severity, mock_rule FROM policies WHERE policy_id = ANY($1)`,
    [candidates.map((c) => c.policy_id)]
  );
  const byId = new Map(rows.map((r) => [r.policy_id, r]));
  candidates = candidates.map((c) => ({ ...byId.get(c.policy_id), ...c })).filter((c) => c.title);

  candidates.sort((a, b) => b.rrf - a.rrf);
  if (mode === 'hybrid_rerank') candidates = rerank(clauseText, candidates);
  return candidates.slice(0, topK);
}
