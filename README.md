# Contract Risk Analyzer (PERN · RAG · pgvector)

Compares contract clauses against your company's policies, flags conflicts by severity, and **proves every finding with verified quotes** from both the contract and the policy.
Stack: **PostgreSQL + pgvector · Express · React · Node.js** (all JavaScript).

```
Upload contract → split into clauses → embed clause → hybrid search policies (pgvector + keyword)
→ LLM returns strict JSON → verify quotes exist in the sources → human review → export report
```

---------------------------------------------------------------------

## 1. What you need

| Tool | Version | Check with |
|---|---|---|
| Node.js | 18 or newer (20+ recommended) | `node -v` |
| Docker Desktop | any recent | `docker -v` (runs PostgreSQL + pgvector for you) |

No Docker? See "Database without Docker" in section 9.
**No API keys needed to start**: the default "mock" mode runs the whole pipeline offline.

## 2. Unzip and install

```bash
unzip contract-risk-analyzer.zip        # Windows: right-click → Extract All
cd contract-risk-analyzer
npm run install:all                     # installs root + server + client (1–3 min)
```

## 3. Start the database and load the policies

```bash
npm run db:up        # starts PostgreSQL + pgvector in Docker (wait ~10 seconds)
npm run seed         # embeds the 18 sample policies and stores them in the DB
```
Expected: `Done. 18 policies in the database.`

## 4. Run the app

```bash
npm run dev
```
- API: http://localhost:4000/api/health
- UI: **http://localhost:5173**

## 5. Check that it works (checklist)

**A. API health.** Open http://localhost:4000/api/health. You should see
`{"ok":true,"llmProvider":"mock","embedProvider":"mock","policies":18,"warning":null}`

**B. Automatic test.** With the app running, open a second terminal:
```bash
npm run smoke
```
Expected:
```
PASS 01_apex_dynamics_nda.docx: 13 clauses, 9 findings
PASS 02_globex_nda.pdf: 14 clauses, 7 findings
PASS 03_initech_nda.txt: 13 clauses, 1 findings
All checks passed.
```
(Lines like `Warning: Ignoring invalid character ... in hex string` come from the PDF library and are harmless.)

**C. In the browser** (http://localhost:5173):
1. Click a sample, e.g. `01_apex_dynamics_nda.docx`. A progress bar runs, then findings appear.
2. You should see 2 Critical (liability, indemnity), 3 High... sorted by severity. Each card shows the contract clause on the left and the policy on the right, with the evidence **highlighted**, a green "evidence verified" tag, reasoning, and an editable suggested revision.
3. Click **Accept / Save edited revision / Reject** on a finding. The status changes and persists after refresh.
4. Click **Export report**: an HTML file downloads (open it → Print → Save as PDF).
5. `03_initech_nda.txt` should show only ONE finding (exclusivity). It is a mostly-clean contract with deliberate traps that must NOT be flagged.
6. **Policies** tab lists the 18 rules.

**D. Accuracy evaluation.**
```bash
npm run eval
```
Prints retrieval recall@k for vector / keyword / hybrid / hybrid+rerank, plus precision, recall, F1, severity accuracy, citation accuracy and false alarms on 33 labeled clauses. In mock mode expect F1 around 95% with exactly two misses (C32, C33), which are deliberately "hard" paraphrases a rule engine cannot catch. A real LLM should catch them.

## 6. Using a real LLM and real embeddings

Create `server/.env` (copy `server/.env.example`) and set, for example:

```
LLM_PROVIDER=openai          # or gemini | anthropic
EMBED_PROVIDER=openai        # or gemini   (Anthropic has no embeddings API)
OPENAI_API_KEY=sk-...
```
Then **re-seed** (the vectors must be regenerated whenever the embedding provider changes):
```bash
npm run seed
npm run eval      # now measures the real thing
```
The health banner warns you if you forget to re-seed. Model names are in `.env`; update them if your provider has newer ones.
Note: the OpenAI / Gemini / Anthropic code paths follow each provider's documented REST API but were not run with live keys when this project was built. If one errors, the message from the provider is shown in the server log. Mock mode is fully tested.

## 7. Where everything lives

```
docker-compose.yml                  PostgreSQL + pgvector
server/
  data/policies.json                18 fictional company policy rules (+ machine rules used by mock mode)
  data/contracts/                   3 sample NDAs (DOCX, PDF, TXT) + expected.json (the planted issues)
  data/contracts_src/               text sources for the samples (npm run samples in /server rebuilds them)
  data/eval/labeled_clauses.json    33 labeled clauses (ground truth for evaluation)
  scripts/seed.js | evaluate.js | smoke.js | buildSamples.js
  src/index.js                      Express app
  src/routes/                       REST endpoints (contracts, policies, findings/review)
  src/services/
    parser.js                       PDF/DOCX/TXT → text
    splitter.js                     clause-aware splitting (by clause numbers, not token size)
    embeddings.js                   mock / OpenAI / Gemini embeddings
    retrieval.js                    pgvector + IDF keyword search + RRF fusion + rerank
    prompts.js                      system prompt, severity rubric, output contract
    llm.js                          provider calls, JSON extraction, zod validation, retries
    mockLlm.js                      offline rule engine (stand-in for an LLM)
    verify.js                       quote verification (the anti-hallucination step)
    analyzer.js                     orchestrates the whole pipeline per contract
    report.js                       HTML export
client/src/                         React UI (Dashboard, Review, Policies pages)
```

## 8. How mistakes are reduced

1. Clause-level retrieval: the LLM only sees one clause + 4 policies, never the whole contract.
2. Hybrid retrieval (vectors + keywords) fused with Reciprocal Rank Fusion.
3. Strict JSON schema (zod); invalid output is retried with the error message.
4. "No conflict" is an explicitly allowed answer in the prompt.
5. Severity rubric with definitions in the prompt; temperature 0.
6. **Quote verification**: every contract quote and policy quote must exist verbatim in its source. Findings citing a policy that was not retrieved are dropped. Unverifiable quotes are flagged "evidence NOT verified" and routed to careful review.
7. Low-confidence findings are flagged for review. A human accepts, edits or rejects everything.
8. `npm run eval` measures all of the above so improvements are provable.

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot reach the API` in the UI | Server not running. Run `npm run dev` and read the server terminal. |
| `ECONNREFUSED 127.0.0.1:5432` | Database is not up. Run `npm run db:up`, wait 10 s. Check Docker Desktop is running. |
| `extension "vector" is not available` | You are using plain PostgreSQL. Use the Docker image in this repo, or a provider with pgvector. |
| Health says "No policies loaded" | Run `npm run seed`. |
| Health warns about embed provider mismatch | Run `npm run seed` again after changing `EMBED_PROVIDER`. |
| Port 4000 / 5173 / 5432 busy | Change `PORT` in `server/.env` (and the proxy target in `client/vite.config.js`), or stop the other program. |
| "No numbered clauses found" | The contract needs numbering like `1.`, `2.1`, or `Section 3`. |
| "Could not extract text" | The PDF is a scanned image. OCR is not included (see upgrades). |

**Database without Docker:** use a free hosted Postgres that supports pgvector (Neon or Supabase), run `CREATE EXTENSION vector;`, and put its connection string in `server/.env` as `DATABASE_URL=...`.

## 10. Known limitations (honest list)

- Mock mode is a rule engine, not AI. Its scores only prove the plumbing works; judge accuracy with a real LLM + `npm run eval`.
- Mock embeddings are lexical (hashed words), not semantic. Real embeddings change retrieval numbers, and hybrid search should then show its advantage.
- The "rerank" step is a lightweight heuristic, not a cross-encoder model.
- No page numbers yet (clauses are referenced by clause number and character offsets).
- No login / multi-user. No OCR. The PDF parser (`pdf-parse`) is old and may fail on some modern PDFs.
- Findings are AI-assisted drafts, not legal advice.
