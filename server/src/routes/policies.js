import { Router } from 'express';
import multer from 'multer';
import { query, toVector } from '../db/pool.js';
import { config } from '../config.js';
import { extractText } from '../services/parser.js';
import { splitPolicies } from '../services/splitter.js';
import { embed } from '../services/embeddings.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
export const policiesRouter = Router();

policiesRouter.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query('SELECT policy_id, title, section, text, default_severity, source FROM policies ORDER BY policy_id');
    res.json(rows);
  } catch (e) { next(e); }
});

/** Upload a policy document. Each rule must start with an ID like "POL-NDA-019 Title. Rule text..." */
policiesRouter.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const text = await extractText(req.file.buffer, req.file.originalname);
    const chunks = splitPolicies(text);
    if (!chunks.length) return res.status(400).json({ error: 'No rules found. Each rule must start with an ID like "POL-NDA-019".' });
    const vectors = await embed(chunks.map((c) => `${c.title}. ${c.text}`));
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      await query(
        `INSERT INTO policies (policy_id, title, text, default_severity, source, embedding)
         VALUES ($1,$2,$3,NULL,$4,$5::vector)
         ON CONFLICT (policy_id) DO UPDATE SET title=$2, text=$3, source=$4, embedding=$5::vector`,
        [c.policy_id, c.title, c.text, req.file.originalname, toVector(vectors[i])]
      );
    }
    await query(`INSERT INTO meta(key,value) VALUES ('embed_provider',$1) ON CONFLICT (key) DO UPDATE SET value=$1`, [config.embedProvider]);
    res.json({ imported: chunks.length, ids: chunks.map((c) => c.policy_id) });
  } catch (e) { next(e); }
});

policiesRouter.delete('/:policyId', async (req, res, next) => {
  try {
    await query('DELETE FROM policies WHERE policy_id=$1', [req.params.policyId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});