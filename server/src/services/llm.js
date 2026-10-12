import { z } from 'zod';
import { config } from '../config.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';
import { mockAnalyze } from './mockLlm.js';

/* Strict output contract. Anything that does not match is rejected and retried. */
export const findingSchema = z.object({
  policy_id: z.string().min(3),
  severity: z.enum(['Low', 'Medium', 'High', 'Critical']),
  contract_quote: z.string().min(5),
  policy_quote: z.string().min(5),
  reasoning: z.string().min(10),
  suggested_revision: z.string().min(10),
  confidence: z.number().min(0).max(1),
});
export const resultSchema = z.object({ findings: z.array(findingSchema) });

class ApiError extends Error {
  constructor(status, body) {
    super(`LLM API ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

async function post(url, body, headers) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const raw = await res.text();
  if (!res.ok) throw new ApiError(res.status, raw);
  return JSON.parse(raw);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Rate limiting (so free tiers do not return 429):
   LLM_MAX_PER_MINUTE=3  -> at most 3 LLM requests in any rolling 60 seconds (sliding window).
                            The first 3 go out immediately, then calls wait for the oldest to age out.
   LLM_MIN_INTERVAL_MS   -> alternative: a fixed gap between requests (used only if the setting above is not set).
   Both are counted per server process. Retries after a 429 also count. */
const MAX_PER_MIN = Number(process.env.LLM_MAX_PER_MINUTE || 0);
const WINDOW_MS = Number(process.env.LLM_WINDOW_MS || 60_000); // only changed in tests
const MIN_INTERVAL = Number(process.env.LLM_MIN_INTERVAL_MS ?? (config.llmProvider === 'gemini' ? 6500 : config.llmProvider === 'groq' ? 2500 : 0));
const stamps = [];
let nextSlot = 0;
async function pace() {
  if (MAX_PER_MIN) {
    while (true) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] >= WINDOW_MS) stamps.shift();
      if (stamps.length < MAX_PER_MIN) { stamps.push(now); return; }
      const wait = stamps[0] + WINDOW_MS - now + 50;
      if (wait > 2000) console.log(`[llm] limit of ${MAX_PER_MIN} requests/minute reached. Waiting ${Math.ceil(wait / 1000)}s...`);
      await sleep(wait);
    }
  }
  if (!MIN_INTERVAL) return;
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL;
  if (wait) await sleep(wait);
}

function retryDelayMs(err) {
  let secs = 20;
  const g = err.body.match(/retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s/) || err.body.match(/retry in (\d+(?:\.\d+)?)s/i);
  const q = err.body.match(/try again in (\d+(?:\.\d+)?)\s*(ms|s)\b/i); // Groq: "Please try again in 7.5s" / "580ms"
  if (g) secs = Number(g[1]);
  else if (q) secs = q[2].toLowerCase() === 'ms' ? Number(q[1]) / 1000 : Number(q[1]);
  return Math.min(Math.ceil(secs * 1000) + 1000, 90_000);
}

/** Calls the provider, waiting and retrying on rate limits (429) and server errors (5xx). */
async function callWithRetry(call, system, user) {
  let rateRetries = 0;
  let serverRetries = 0;
  while (true) {
    await pace();
    try {
      return await call(system, user);
    } catch (e) {
      if (e.status === 429) {
        if (/PerDay|per day/i.test(e.body)) {
          throw new Error('Daily free-tier quota is used up. Wait until tomorrow, try another model in server/.env, or enable billing with your provider.');
        }
        if (++rateRetries > 6) throw e;
        const wait = retryDelayMs(e);
        console.log(`[llm] rate limited (429). Waiting ${Math.round(wait / 1000)}s then retrying (${rateRetries}/6)...`);
        await sleep(wait);
      } else if (e.status >= 500 && ++serverRetries <= 3) {
        await sleep(2000 * serverRetries);
      } else {
        throw e; // 400/401/403/404 etc: a retry will not help
      }
    }
  }
}

async function callOpenAI(system, user) {
  const d = await post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: config.openaiLlmModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    },
    { Authorization: `Bearer ${config.openaiKey}` }
  );
  return d.choices[0].message.content;
}

async function callGroq(system, user) {
  const d = await post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: config.groqModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    },
    { Authorization: `Bearer ${config.groqKey}` }
  );
  return d.choices[0].message.content;
}

async function callGemini(system, user) {
  const d = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiLlmModel}:generateContent?key=${config.geminiKey}`,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }
  );
  return d.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
}

async function callAnthropic(system, user) {
  const d = await post(
    'https://api.anthropic.com/v1/messages',
    {
      model: config.anthropicModel,
      max_tokens: 2000,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    },
    { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' }
  );
  return d.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

const CALLERS = { openai: callOpenAI, gemini: callGemini, anthropic: callAnthropic, groq: callGroq };

/** Pull the first {...} JSON object out of a string (handles ```json fences). */
export function extractJson(raw) {
  const cleaned = raw.replace(/```json|```/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in model output');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Analyse ONE clause against its retrieved policies.
 * Returns { findings: [...] } validated against the schema (retries up to 3 times).
 */
export async function analyzeClause(clause, policies) {
  if (config.llmProvider === 'mock') return resultSchema.parse(mockAnalyze(clause, policies));

  const call = CALLERS[config.llmProvider];
  let user = buildUserPrompt(clause, policies);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await callWithRetry(call, SYSTEM_PROMPT, user); // network/rate-limit problems are handled (or thrown) here
    try {
      return resultSchema.parse(extractJson(raw)); // only bad JSON / wrong schema triggers a re-prompt
    } catch (e) {
      lastErr = e;
      user = `${buildUserPrompt(clause, policies)}\n\nYour previous answer was invalid (${String(e.message).slice(0, 200)}). Return ONLY valid JSON matching the schema.`;
    }
  }
  throw new Error(`LLM output failed validation after 3 attempts: ${lastErr?.message}`);
}