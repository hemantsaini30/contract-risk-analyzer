import { pool } from './pool.js';
import { EMBED_DIM } from '../config.js';

const SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS policies (
  id SERIAL PRIMARY KEY,
  policy_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  section TEXT,
  text TEXT NOT NULL,
  default_severity TEXT,
  mock_rule JSONB,
  source TEXT,
  embedding vector(${EMBED_DIM}),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || text)) STORED,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS policies_tsv_idx ON policies USING GIN (tsv);
CREATE INDEX IF NOT EXISTS policies_emb_idx ON policies USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS contracts (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL,
  full_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  error TEXT,
  clauses_total INT DEFAULT 0,
  clauses_done INT DEFAULT 0,
  llm_provider TEXT,
  embed_provider TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clauses (
  id SERIAL PRIMARY KEY,
  contract_id INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  idx INT NOT NULL,
  number TEXT,
  heading TEXT,
  text TEXT NOT NULL,
  start_char INT,
  end_char INT,
  retrieved JSONB
);
CREATE INDEX IF NOT EXISTS clauses_contract_idx ON clauses(contract_id);

CREATE TABLE IF NOT EXISTS findings (
  id SERIAL PRIMARY KEY,
  contract_id INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  clause_id INT NOT NULL REFERENCES clauses(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  contract_quote TEXT NOT NULL,
  policy_quote TEXT NOT NULL,
  contract_quote_start INT,
  contract_quote_end INT,
  policy_quote_start INT,
  policy_quote_end INT,
  reasoning TEXT,
  suggested_revision TEXT,
  confidence REAL,
  verified BOOLEAN DEFAULT false,
  needs_review BOOLEAN DEFAULT false,
  review_status TEXT DEFAULT 'pending',
  edited_revision TEXT,
  reviewer_note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS findings_contract_idx ON findings(contract_id);
`;

export async function initDb() {
  await pool.query(SQL);
}
