import express from 'express';
import cors from 'cors';
import { config, assertProviderKeys } from './config.js';
import { initDb } from './db/init.js';
import { query } from './db/pool.js';
import { policiesRouter } from './routes/policies.js';
import { contractsRouter, findingsRouter } from './routes/contracts.js';
import { checkRouter } from './routes/check.js';

assertProviderKeys();
await initDb();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (_req, res) => {
  const { rows: [{ n }] } = await query('SELECT COUNT(*)::int AS n FROM policies');
  const { rows: m } = await query(`SELECT value FROM meta WHERE key='embed_provider'`);
  const seeded = m[0]?.value;
  res.json({
    ok: true,
    llmProvider: config.llmProvider,
    embedProvider: config.embedProvider,
    policies: n,
    warning: n === 0 ? 'No policies loaded. Run: npm run seed' : seeded && seeded !== config.embedProvider
      ? `Policies were embedded with "${seeded}" but EMBED_PROVIDER is "${config.embedProvider}". Re-run: npm run seed` : null,
  });
});

app.use('/api/policies', policiesRouter);
app.use('/api/contracts', contractsRouter);
app.use('/api/findings', findingsRouter);
app.use('/api/check', checkRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(config.port, () => {
  console.log(`API on http://localhost:${config.port}  (LLM=${config.llmProvider}, embeddings=${config.embedProvider})`);
});