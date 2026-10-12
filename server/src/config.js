import 'dotenv/config';

const env = process.env;

export const EMBED_DIM = 768; // fixed so the DB column never changes between providers

export const config = {
  port: Number(env.PORT) || 4000,
  databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/contractdb',
  llmProvider: (env.LLM_PROVIDER || 'mock').toLowerCase(),
  embedProvider: (env.EMBED_PROVIDER || 'mock').toLowerCase(),
  openaiKey: env.OPENAI_API_KEY,
  geminiKey: env.GEMINI_API_KEY,
  anthropicKey: env.ANTHROPIC_API_KEY,
  groqKey: env.GROQ_API_KEY,
  openaiLlmModel: env.OPENAI_LLM_MODEL || 'gpt-4o-mini',
  openaiEmbedModel: env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
  geminiLlmModel: env.GEMINI_LLM_MODEL || 'gemini-2.5-flash',
  geminiEmbedModel: env.GEMINI_EMBED_MODEL || 'gemini-embedding-001',
  anthropicModel: env.ANTHROPIC_LLM_MODEL || 'claude-sonnet-5-5',
  groqModel: env.GROQ_LLM_MODEL || 'llama-3.3-70b-versatile',
  topK: Number(env.TOP_K) || 4,
  concurrency: Number(env.CONCURRENCY) || 3,
  minConfidence: Number(env.MIN_CONFIDENCE) || 0.6,
};

export function assertProviderKeys() {
  const need = [];
  if (config.llmProvider === 'openai' || config.embedProvider === 'openai') need.push(['OPENAI_API_KEY', config.openaiKey]);
  if (config.llmProvider === 'gemini' || config.embedProvider === 'gemini') need.push(['GEMINI_API_KEY', config.geminiKey]);
  if (config.llmProvider === 'anthropic') need.push(['ANTHROPIC_API_KEY', config.anthropicKey]);
  if (config.llmProvider === 'groq') need.push(['GROQ_API_KEY', config.groqKey]);
  const missing = need.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing env var(s): ${missing.join(', ')} (see server/.env)`);
  const okLlm = ['mock', 'openai', 'gemini', 'anthropic', 'groq'].includes(config.llmProvider);
  const okEmb = ['mock', 'openai', 'gemini'].includes(config.embedProvider);
  if (!okLlm) throw new Error(`Unknown LLM_PROVIDER "${config.llmProvider}"`);
  if (!okEmb) throw new Error(`Unknown EMBED_PROVIDER "${config.embedProvider}" (anthropic has no embeddings)`);
}