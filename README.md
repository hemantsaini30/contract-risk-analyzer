# Contract Risk Analyzer

**A retrieval-augmented system that checks contract clauses against a company's own policy rules, flags conflicts by severity, and backs every finding with verified quotes.**

Instead of summarising a contract, it compares each clause with the relevant policy rules and reports conflicts together with the exact wording that causes them. A human reviewer accepts, edits or rejects every finding.

> **Stack:** React, Node.js/Express, PostgreSQL + pgvector, Gemini embeddings, Groq-hosted LLM.
> **Data:** all policies, contracts and test clauses are synthetic (a fictional company, "Northwind"). Accuracy on real contracts has not been measured.

<!-- Screenshots: docs/screenshots/check-clause.png, review.png, report.png -->

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Evaluation](#evaluation)
- [Findings from the evaluation](#findings-from-the-evaluation)
- [Getting started](#getting-started)
- [Project structure](#project-structure)
- [API](#api)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [License](#license)

---

## Features

- **Clause-level analysis.** Contracts (PDF, DOCX, TXT) are split into numbered clauses. Each clause is analysed on its own against only the most relevant policies.
- **Policy-grounded.** 49 policy rules (18 NDA, 31 supplier/services) are stored as text and 768-dimension vectors in PostgreSQL (pgvector).
- **Verifiable evidence.** The LLM must quote the clause and the policy. Code then checks that each quote exists in the source text. Findings with quotes that cannot be located are marked "evidence NOT verified".
- **Severity comes from the policy, not the model.** Each policy carries a severity (Low / Medium / High / Critical), because severity assigned by the LLM was inconsistent in early tests.
- **Contract-type-aware retrieval.** NDA clauses are checked only against NDA policies, and supplier clauses only against supplier policies. The type is detected from the contract title and can be overridden.
- **Suggested rewrites** that keep the commercial intent with the smallest change.
- **Human-in-the-loop review.** Side-by-side clause and policy with highlighted evidence, editable revisions, accept / edit / reject, and an HTML report export.
- **Check-a-clause page.** Paste a clause and get an instant verdict, or load a labeled example to see whether the system is right.
- **Evaluation harness.** 210 labeled clauses in five sets, measuring retrieval recall@k, precision, recall, F1, citation accuracy and false alarms.
- **Free-tier friendly.** Sliding-window rate limiter, retry with backoff, and on-disk caches for embeddings and LLM answers.
- **Offline mock mode.** The pipeline runs without API keys. A rule engine stands in for the LLM and covers only the original 18 NDA policies.

## How it works

```mermaid
flowchart LR
  A[Contract: PDF / DOCX / TXT] --> B[Parse + clause-aware split]
  B --> C[Embed each clause<br/>Gemini 768-d]
  C --> D[(pgvector<br/>49 policy vectors)]
  D -->|top-5 policies,<br/>filtered by contract type| E[LLM judge<br/>Groq]
  E --> F[Strict JSON schema<br/>zod + retries]
  F --> G[Quote verification<br/>exists in source?]
  G --> H[Human review UI]
  H --> I[HTML report]
```

1. **Setup (once).** Each policy is embedded and stored with its text, severity and contract types (`npm run seed`).
2. **Retrieval (per clause).** The clause is embedded temporarily and never stored. pgvector returns the closest policies by cosine similarity, restricted to the contract's type.
3. **Judgement.** The LLM receives the clause, the top-5 policies and a strict prompt defining when a clause is a violation, when it is compliant, and how to quote. Output is validated against a schema and retried if invalid.
4. **Verification.** Every quote is located in the clause or policy text, tolerating whitespace, curly quotes and `...` skips. Offsets are stored so the UI can highlight the evidence.
5. **Review.** A human accepts, edits or rejects each finding. The exported report includes the verified evidence.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, React Router |
| Backend | Node.js, Express |
| Database | PostgreSQL 16 + pgvector (HNSW index, cosine distance), full-text search |
| Embeddings | Gemini `gemini-embedding-001` (768 dimensions) |
| LLM | Groq `llama-3.3-70b-versatile` (OpenAI, Gemini and Anthropic adapters included) |
| Parsing | `pdf-parse`, `mammoth` (DOCX) |
| Validation | `zod` |

---

## Evaluation

### Protocol

Five synthetic labeled sets (210 clauses in total). Each clause lists the policies it violates, or none if it is compliant. A finding counts as correct only if it names the expected policy. A small number of defensible extra findings are marked `acceptable_extra` in the labels and are not counted as errors.

| Set | Clauses | Role |
|---|---|---|
| `dev2` | 48 | Development set (prompt, policy and retrieval changes were tuned against it) |
| `labeled` | 34 | Development set |
| `holdout` | 26 | Used for diagnosis, so it is development data now |
| `holdout2` | 52 | Used for diagnosis, so it is development data now |
| `holdout3` | 50 | **Clean held-out set. Run once, with no tuning afterwards** |

Configuration: Groq `llama-3.3-70b-versatile`, Gemini embeddings, vector retrieval, top-5 policies sent to the LLM.

### End-to-end detection

| Set | Clauses | Precision | Recall | F1 | Citation accuracy | Clean clauses flagged |
|---|---|---|---|---|---|---|
| **holdout3** (clean) | 50 | **100%** (27 findings) | **96.4%** | **98.2%** | 96.8% | 0 / 22 |
| dev2 | 48 | 87.5% | 96.6% | 91.8% | 97.2% | 2 / 20 |
| holdout2 | 52 | 85.7% | 96.8% | 90.9% | 97.4% | 2 / 23 |
| holdout | 26 | 93.8% | 88.2% | 90.9% | 93.8% | 0 / 10 |
| labeled (see note) | 34 | 82.1% | 100% | 90.2% | 96.7% | 3 / 12 |

Notes:

- **`labeled` has no contract type set on its clauses**, so NDA clauses were also checked against supplier policies. All of its false alarms trace back to this or to the "omission" error described below. Treat its numbers as a lower bound until the labels are typed and the set is re-run.
- Severity accuracy is about 100% by construction (it is read from the policy), so it is not reported as a result.
- With 25 to 30 expected findings per set, **one clause moves recall by about 3.5 points.** Read the numbers as ranges (roughly 90 to 98% F1 on in-distribution data), not as a single accuracy figure.
- The `holdout3` precision of 100% is based on 27 findings. A zero-error result on that few findings is consistent with a true precision well below 100%.

### Retrieval: did the right policy reach the LLM?

Retrieval is measured among policies of the clause's own contract type. Cells show **recall@1 / recall@5**; the LLM sees the top 5.

| Set | Vector | Keyword | Hybrid | Hybrid + rerank |
|---|---|---|---|---|
| dev2 | 86.2 / 96.6 | 72.4 / 86.2 | 79.3 / 93.1 | 65.5 / 89.7 |
| holdout3 | 82.1 / 100 | 50.0 / 82.1 | 75.0 / 96.4 | 50.0 / 92.9 |
| holdout2 | 87.1 / 100 | 74.2 / 93.5 | 80.6 / 100 | 71.0 / 93.5 |
| holdout | 76.5 / 100 | 41.2 / 82.4 | 64.7 / 94.1 | 35.3 / 88.2 |
| labeled | 78.3 / 100 | 78.3 / 91.3 | 82.6 / 95.7 | 78.3 / 95.7 |

### Reproducing the results

```bash
npm run eval --prefix server -- dev2               # development set
npm run eval --prefix server -- labeled
npm run eval --prefix server -- holdout
npm run eval --prefix server -- holdout2
npm run eval --prefix server -- holdout3           # clean set: run once, do not tune on it
npm run eval --prefix server -- dev2 retrieval     # retrieval table only (no LLM calls)
```

Finished clauses are cached, so an interrupted run resumes where it stopped. To ignore the cache, run the script directly (npm can swallow the flag):

```bash
cd server
node scripts/evaluate.js dev2 --fresh
```

---

## Findings from the evaluation

**Retrieval**

- **Plain vector search was the best retrieval mode.** It had the highest or tied-highest recall@5 on all five sets. Hybrid retrieval (vector + IDF-weighted keyword search merged with Reciprocal Rank Fusion) was close on some sets, and keyword search alone was the weakest at recall@5. The heuristic reranker had the lowest or tied-lowest recall@1 on all five sets, so it is disabled. Retrieval mode is a setting (`RETRIEVAL_MODE`), so this is reproducible.
- **Policy wording drives retrieval misses.** The NDA personal-data policy (`POL-NDA-007`) was missed by vector search on `dev2` ("employee records" versus "personal data"). Expanding the embedded policy text with related terms is on the roadmap.

**Model behaviour**

- **Confidence scores do not separate right from wrong.** Correct findings averaged 0.92 to 0.96 across sets, while false alarms averaged 0.84 to 0.96 (from 1 to 5 false alarms per set). Confidence thresholds therefore buy almost nothing, and reliability comes from retrieval, prompt rules and verification instead.
- **Remaining errors fall into four groups:**
  1. *Omission treated as violation.* The model flags a clause for not mentioning something the policy requires, even when the clause is about something else (for example a "written amendments" clause flagged for a fee-cap policy).
  2. *Numeric comparison mistakes.* For example, "not more than once a year" flagged against "at least once every twelve months".
  3. *Negation.* "The Receiving Party shall not ask any court for urgent relief" was judged compliant (the only miss on `holdout3`).
  4. *Multi-violation clauses.* A clause containing two violations had both missed on `holdout`.
- **Quote verification catches real problems.** In every set the model occasionally quoted policy text that does not exist (for example "Retention periods longer than thirty (30) days are not permitted"). Verification flags these instead of letting them through.

**Data and policy design**

- **Adding policies lowered precision on the older sets, and the cause was largely the data.** After growing from 18 to 49 policies, false alarms came mostly from policies that contradicted one another and from supplier rules being applied to NDA clauses. This led to contract-type metadata filtering and a rewrite of the conflicting policies. Precision on the older sets later improved (`holdout` 70.8% to 93.8%, `holdout2` 78.9% to 85.7%), but filtering, policy rewrites and prompt changes were made together, so the gain cannot be attributed to any one of them.
- **Severity lives with the policy.** It is a company decision, not a model guess.

---

## Getting started

**Requirements:** Node.js 18+ (20+ recommended), Docker Desktop (PostgreSQL + pgvector), a free [Gemini API key](https://aistudio.google.com) and a free [Groq API key](https://console.groq.com/keys). Mock mode needs no keys.

```bash
git clone <your-repo-url>
cd contract-risk-analyzer
npm run install:all          # root + server + client
npm run db:up                # PostgreSQL + pgvector in Docker
cp server/.env.example server/.env    # Windows: copy server\.env.example server\.env
# edit server/.env (see below)
npm run seed                 # embeds the 49 policies into pgvector
npm run dev                  # API on :4000, UI on http://localhost:5173
```

If port 5432 is already in use, change the left side of the port mapping in `docker-compose.yml` (for example `5433:5432`) and use the same port in `DATABASE_URL`.

### Configuration (`server/.env`)

```ini
DATABASE_URL=postgres://postgres:postgres@localhost:5432/contractdb

EMBED_PROVIDER=gemini          # mock | gemini | openai
GEMINI_API_KEY=your_key
LLM_PROVIDER=groq              # mock | groq | gemini | openai | anthropic
GROQ_API_KEY=your_key
GROQ_LLM_MODEL=llama-3.3-70b-versatile

RETRIEVAL_MODE=vector          # vector | keyword | hybrid | hybrid_rerank
TOP_K=5                        # policies sent to the LLM per clause
LLM_MAX_PER_MINUTE=5           # sliding-window limit (free tiers)
CONCURRENCY=1
```

Re-run `npm run seed` whenever you change `EMBED_PROVIDER` or edit `server/data/policies.json`. Model names change over time; if you get a 404, update the model variable.

### Verify the install

1. `http://localhost:4000/api/health` shows `"policies":49`.
2. `npm run smoke` (mock mode) uploads the three sample NDAs and checks that the planted issues are found.
3. In the UI, open **Check a clause**, load example `C01` and run it. It should flag `POL-NDA-001`.
4. On **Contracts**, open `04_acme_services_agreement.txt`. It is detected as a supplier agreement and should flag about 11 planted issues.

## Project structure

```
docker-compose.yml                PostgreSQL + pgvector
server/
  data/policies.json              49 synthetic policy rules (contract types, severities)
  data/contracts/                 4 sample contracts (3 NDAs as DOCX/PDF/TXT, 1 services agreement)
  data/eval/                      labeled clause sets (labeled, holdout, dev2, holdout2, holdout3)
  scripts/                        seed.js, evaluate.js, smoke.js, buildSamples.js
  src/index.js                    Express app
  src/routes/                     contracts, policies, check (single clause), findings (review)
  src/services/
    parser.js                     PDF / DOCX / TXT to text
    splitter.js                   clause-aware splitting (by clause numbers)
    embeddings.js                 Gemini / OpenAI / mock embeddings, disk cache, retry
    retrieval.js                  pgvector search, keyword search, fusion, contract-type filter
    prompts.js                    system prompt: violation rules, severity rubric, examples
    llm.js                        provider adapters, JSON extraction, schema validation, rate limiting
    verify.js                     quote verification and evidence offsets
    contractType.js               contract type detection
    analyzer.js                   per-contract pipeline
    report.js                     HTML report export
client/src/pages/                 Check, Dashboard (contracts), Review, Policies
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Provider settings, policy count, warnings |
| POST | `/api/check` | Analyse one clause: `{ clause, contract_type }` |
| GET | `/api/check/examples` | Labeled development examples |
| POST | `/api/contracts` | Upload a contract (multipart: `file`, `contract_type`) |
| POST | `/api/contracts/from-sample` | Analyse a bundled sample |
| GET | `/api/contracts/:id` | Contract, clauses, findings |
| POST | `/api/contracts/:id/reanalyze` | Re-run, optionally with a new `contract_type` |
| GET | `/api/contracts/:id/report` | HTML report download |
| PATCH | `/api/findings/:id` | Accept / edit / reject a finding |
| GET / POST | `/api/policies`, `/api/policies/upload` | List policies; import `POL-XXX-000 Title. Rule...` documents |

## Limitations

- **All data is synthetic and small.** Test clauses are single sentences written in the same style as the policies, so the results show the pipeline works on clean, isolated clauses. They do not predict accuracy on long, messy, real contracts.
- Clauses are judged one at a time. Cross-clause logic (for example "see clause 7", or a liability cap whose carve-outs sit in another section) is not followed.
- Only two contract families are supported (NDA, supplier/services). The type detector is a keyword heuristic on the title.
- The model still has known weaknesses (omission, negation, numeric comparison, multi-violation clauses; see above), so every finding needs human review.
- No page numbers (clauses are referenced by clause number and character offsets), no OCR for scanned PDFs, no authentication or multi-user support.
- The PDF parser (`pdf-parse`) is old and may fail on some modern PDFs.
- Mock mode is a rule engine, not an AI, and covers only the original 18 NDA policies.
- Evaluation runs on the Groq free tier, which is rate limited to 5 requests per minute, so a full set takes several minutes.
- Findings are AI-assisted drafts, not legal advice.

## Roadmap

- Fix the "omission is not a violation" prompt rule and re-measure on `dev2`.
- Add `contract_type` to every clause in `labeled` and re-run it.
- Add negation, waiver and multi-violation clauses to the development sets.
- Expand policy text with related terms to fix paraphrase misses (for example "employee records" versus "personal data").
- Compare the free model against a stronger paid model on the same evaluation to isolate the model effect.
- Build a new held-out set of longer, multi-sentence clauses from realistic contracts.
- Include neighbouring clauses and headings as context for the judge.
- Add a real cross-encoder reranker and a second verification pass.
- Page-level references, OCR, PDF/DOCX report export, authentication.

## License

MIT