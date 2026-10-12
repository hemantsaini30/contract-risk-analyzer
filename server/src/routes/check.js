import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { embed } from '../services/embeddings.js';
import { retrieve } from '../services/retrieval.js';
import { analyzeClause } from '../services/llm.js';
import { verifyFinding } from '../services/verify.js';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/eval/labeled_clauses.json');
export const checkRouter = Router();

/** Example clauses (with the known right answer) so you can test by hand. */
checkRouter.get('/examples', async (_req, res, next) => {
  try {
    res.json(JSON.parse(await fs.readFile(EXAMPLES, 'utf8')));
  } catch (e) { next(e); }
});

/**
 * POST /api/check { clause }
 * 1) embed the clause (Gemini)  2) find the closest policies in pgvector + keyword search
 * 3) ask the LLM (Groq) to judge it against ONLY those policies  4) verify every quote
 */
checkRouter.post('/', async (req, res, next) => {
  try {
    const clause = String(req.body?.clause || '').trim();
    if (clause.length < 20) return res.status(400).json({ error: 'Paste a full clause (at least 20 characters).' });
    if (clause.length > 4000) return res.status(400).json({ error: 'Clause is too long (max 4000 characters). Paste one clause at a time.' });

    const t0 = Date.now();
    const [embedding] = await embed([clause]);
    const retrieved = await retrieve(clause, { topK: config.topK, embedding });
    if (!retrieved.length) return res.status(400).json({ error: 'No policies in the database. Run: npm run seed' });

    const { findings } = await analyzeClause({ number: null, text: clause }, retrieved);
    const checked = findings.map((f) => verifyFinding(f, clause, retrieved)).filter(Boolean);

    const order = ['Critical', 'High', 'Medium', 'Low'];
    checked.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));

    res.json({
      verdict: checked.length ? 'violation' : 'compliant',
      highest_severity: checked[0]?.severity ?? null,
      findings: checked,
      policies_checked: retrieved.map((r) => ({
        policy_id: r.policy_id, title: r.title, text: r.text, scores: r.scores,
      })),
      models: { llm: config.llmProvider, embeddings: config.embedProvider },
      ms: Date.now() - t0,
    });
  } catch (e) { next(e); }
});