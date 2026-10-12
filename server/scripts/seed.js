// Loads data/policies.json -> embeds each rule -> stores text + vector in Postgres (pgvector).
// Re-run this whenever you change policies.json OR switch EMBED_PROVIDER.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertProviderKeys } from '../src/config.js';
import { initDb } from '../src/db/init.js';
import { pool, query, toVector } from '../src/db/pool.js';
import { embed } from '../src/services/embeddings.js';
import { locateQuote } from '../src/utils/text.js';

assertProviderKeys();
const dir = path.dirname(fileURLToPath(import.meta.url));
const policies = JSON.parse(await fs.readFile(path.join(dir, '../data/policies.json'), 'utf8'));

await initDb();
console.log(`Embedding ${policies.length} policies with provider "${config.embedProvider}" ...`);
const vectors = await embed(policies.map((p) => `${p.title}. ${p.text}`));

for (let i = 0; i < policies.length; i++) {
  const p = policies[i];
  await query(
    `INSERT INTO policies (policy_id, title, section, text, default_severity, mock_rule, source, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,'policies.json',$7::vector)
     ON CONFLICT (policy_id) DO UPDATE SET title=$2, section=$3, text=$4, default_severity=$5, mock_rule=$6, embedding=$7::vector`,
    [p.policy_id, p.title, p.section, p.text, p.default_severity, JSON.stringify(p.mock_rule ?? null), toVector(vectors[i])]
  );
}
await query(`INSERT INTO meta(key,value) VALUES ('embed_provider',$1) ON CONFLICT (key) DO UPDATE SET value=$1`, [config.embedProvider]);

const { rows } = await query('SELECT COUNT(*)::int AS n FROM policies');
console.log(`Done. ${rows[0].n} policies in the database.`);
await pool.end();
