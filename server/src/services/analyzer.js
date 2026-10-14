import { query } from '../db/pool.js';
import { config } from '../config.js';
import { embed } from './embeddings.js';
import { retrieve } from './retrieval.js';
import { analyzeClause } from './llm.js';
import { verifyFinding } from './verify.js';
import { pLimitMap } from '../utils/text.js';

/** Full pipeline for one contract that is already stored with its clauses. */
export async function analyzeContract(contractId) {
  try {
    await query(`UPDATE contracts SET status='processing', error=NULL, clauses_done=0, llm_provider=$2, embed_provider=$3 WHERE id=$1`,
      [contractId, config.llmProvider, config.embedProvider]);
    await query('DELETE FROM findings WHERE contract_id=$1', [contractId]);

    const { rows: [{ contract_type: contractType }] } = await query('SELECT contract_type FROM contracts WHERE id=$1', [contractId]);
    const { rows: clauses } = await query('SELECT * FROM clauses WHERE contract_id=$1 ORDER BY idx', [contractId]);
    const vectors = await embed(clauses.map((c) => c.text)); // clause vectors are temporary, never stored

    await pLimitMap(clauses, config.concurrency, async (clause, i) => {
      const retrieved = await retrieve(clause.text, { topK: config.topK, embedding: vectors[i], contractType });
      const { findings } = await analyzeClause(clause, retrieved);

      for (const f of findings) {
        const v = verifyFinding(f, clause.text, retrieved);
        if (!v) continue;
        await query(
          `INSERT INTO findings (contract_id, clause_id, policy_id, severity, contract_quote, policy_quote,
             contract_quote_start, contract_quote_end, policy_quote_start, policy_quote_end,
             reasoning, suggested_revision, confidence, verified, needs_review)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [contractId, clause.id, v.policy_id, v.severity, v.contract_quote, v.policy_quote,
           v.contract_quote_start, v.contract_quote_end, v.policy_quote_start, v.policy_quote_end,
           v.reasoning, v.suggested_revision, v.confidence, v.verified, v.needs_review]
        );
      }
      const slim = retrieved.map((r) => ({ policy_id: r.policy_id, title: r.title, scores: r.scores }));
      await query('UPDATE clauses SET retrieved=$2 WHERE id=$1', [clause.id, JSON.stringify(slim)]);
      await query('UPDATE contracts SET clauses_done = clauses_done + 1 WHERE id=$1', [contractId]);
    });

    await query(`UPDATE contracts SET status='done' WHERE id=$1`, [contractId]);
  } catch (err) {
    console.error('[analyze] failed:', err);
    await query(`UPDATE contracts SET status='error', error=$2 WHERE id=$1`, [contractId, String(err.message).slice(0, 500)]);
  }
}