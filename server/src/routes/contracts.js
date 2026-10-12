import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db/pool.js';
import { extractText } from '../services/parser.js';
import { splitClauses } from '../services/splitter.js';
import { analyzeContract } from '../services/analyzer.js';
import { buildReportHtml } from '../services/report.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const SAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/contracts');

export const contractsRouter = Router();

async function createContract(buffer, filename) {
  const text = await extractText(buffer, filename);
  const clauses = splitClauses(text);
  if (!clauses.length) throw new Error('No numbered clauses found. Contracts need numbering like "1.", "2.1" or "Section 3".');
  const { rows } = await query(
    `INSERT INTO contracts (filename, full_text, clauses_total, status) VALUES ($1,$2,$3,'processing') RETURNING id`,
    [filename, text, clauses.length]
  );
  const id = rows[0].id;
  for (const c of clauses) {
    await query(
      `INSERT INTO clauses (contract_id, idx, number, heading, text, start_char, end_char) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, c.idx, c.number, c.heading, c.text, c.start_char, c.end_char]
    );
  }
  analyzeContract(id); // runs in background; the UI polls GET /api/contracts/:id
  return id;
}

contractsRouter.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT c.id, c.filename, c.status, c.clauses_total, c.clauses_done, c.created_at,
        COUNT(f.id) FILTER (WHERE f.severity='Critical') AS critical,
        COUNT(f.id) FILTER (WHERE f.severity='High') AS high,
        COUNT(f.id) FILTER (WHERE f.severity='Medium') AS medium,
        COUNT(f.id) FILTER (WHERE f.severity='Low') AS low
      FROM contracts c LEFT JOIN findings f ON f.contract_id = c.id
      GROUP BY c.id ORDER BY c.id DESC`);
    res.json(rows.map((r) => ({ ...r, critical: +r.critical, high: +r.high, medium: +r.medium, low: +r.low })));
  } catch (e) { next(e); }
});

contractsRouter.get('/samples', async (_req, res, next) => {
  try {
    const files = (await fs.readdir(SAMPLES_DIR)).filter((f) => /\.(txt|docx|pdf)$/i.test(f)).sort();
    res.json(files);
  } catch (e) { next(e); }
});

contractsRouter.post('/from-sample', async (req, res, next) => {
  try {
    const name = path.basename(String(req.body?.filename || ''));
    const buf = await fs.readFile(path.join(SAMPLES_DIR, name));
    res.json({ id: await createContract(buf, name) });
  } catch (e) { next(e); }
});

contractsRouter.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ id: await createContract(req.file.buffer, req.file.originalname) });
  } catch (e) { e.status = 400; next(e); }
});

contractsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows: [contract] } = await query('SELECT id, filename, status, error, clauses_total, clauses_done, llm_provider, embed_provider, created_at FROM contracts WHERE id=$1', [id]);
    if (!contract) return res.status(404).json({ error: 'Not found' });
    const { rows: clauses } = await query('SELECT * FROM clauses WHERE contract_id=$1 ORDER BY idx', [id]);
    const { rows: findings } = await query('SELECT * FROM findings WHERE contract_id=$1 ORDER BY id', [id]);
    const { rows: policies } = await query('SELECT policy_id, title, text FROM policies');
    res.json({ contract, clauses, findings, policies });
  } catch (e) { next(e); }
});

contractsRouter.post('/:id/reanalyze', async (req, res, next) => {
  try {
    analyzeContract(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

contractsRouter.delete('/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM contracts WHERE id=$1', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

contractsRouter.get('/:id/report', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows: [contract] } = await query('SELECT * FROM contracts WHERE id=$1', [id]);
    if (!contract) return res.status(404).json({ error: 'Not found' });
    const { rows: clauses } = await query('SELECT * FROM clauses WHERE contract_id=$1 ORDER BY idx', [id]);
    const { rows: findings } = await query('SELECT * FROM findings WHERE contract_id=$1', [id]);
    const { rows: policies } = await query('SELECT policy_id, title, text FROM policies');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="risk-report-${id}.html"`);
    res.send(buildReportHtml(contract, clauses, findings, policies));
  } catch (e) { next(e); }
});

/** Human review: accept / reject / edit a finding */
export const findingsRouter = Router();
findingsRouter.patch('/:id', async (req, res, next) => {
  try {
    const { review_status, edited_revision, reviewer_note } = req.body || {};
    if (review_status && !['pending', 'accepted', 'rejected', 'edited'].includes(review_status)) return res.status(400).json({ error: 'Bad review_status' });
    const { rows } = await query(
      `UPDATE findings SET review_status = COALESCE($2, review_status),
         edited_revision = COALESCE($3, edited_revision), reviewer_note = COALESCE($4, reviewer_note)
       WHERE id=$1 RETURNING *`,
      [Number(req.params.id), review_status ?? null, edited_revision ?? null, reviewer_note ?? null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});
