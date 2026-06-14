# zk-circuit-auditor-mcp — Architecture

This document explains **how** the auditor works and **why** the
4-pass pipeline catches bugs that compilers do not.

## Module boundaries

```
                ┌─────────────────────────────────────────┐
                │              server.js                  │
                │  • Registers 4 MCP tools                │
                │  • Owns the StdioServerTransport        │
                │  • Owns no business logic               │
                └────────────┬────────────────────────────┘
                             │ tool handlers call into
                             ▼
                ┌─────────────────────────────────────────┐
                │            src/auditor.js               │
                │  • Multi-pass orchestration             │
                │  • Input validation & error handling    │
                │  • Severity normalization & scoring     │
                │  • Cross-references src/zkwc.js ids     │
                └────┬───────────────────┬────────────────┘
                     │                   │
                     │ builds prompts    │ references taxonomy
                     ▼                   ▼
        ┌────────────────────┐   ┌────────────────────────────┐
        │  src/prompts.js    │   │      src/zkwc.js           │
        │  • SYSTEM_PROMPT   │   │  • ZKWEAK[]                │
        │  • per-pass user   │   │  • isValidWeaknessId()     │
        │    prompts         │   │  • listWeaknesses()        │
        └─────────┬──────────┘   └────────────────────────────┘
                  │
                  │ messages + opts
                  ▼
        ┌─────────────────────────────────────────┐
        │          src/cysicClient.js            │
        │  • chat(messages, opts)                │
        │  • chatJSON(messages, opts)            │
        │  • stripCodeFences()                   │
        │  • AbortController-based timeout       │
        │  • Bearer-token auth header            │
        └────────────────────┬────────────────────┘
                             │ HTTPS
                             ▼
        ┌─────────────────────────────────────────┐
        │   Cysic Minimax API                     │
        │   POST /v1/chat/completions             │
        │   model: minimax-m3                     │
        └─────────────────────────────────────────┘
```

**`server.js`** is intentionally thin. It only knows about MCP
(tool registration + stdio transport) and zod schemas for tool
input validation. It never imports `node:fs`, `node:child_process`,
or any LLM client — all logic lives in `src/`.

**`src/auditor.js`** owns the audit logic. It composes prompts,
calls the Cysic client, normalizes model output, and produces the
final structured result. It is the only module that knows about
the multi-pass pipeline.

**`src/prompts.js`** is pure data. The system prompt and each
per-pass user prompt are exported as functions so the auditor can
inject the source and (for pass 2/3) the prior pass's structured
output as JSON.

**`src/zkwc.js`** is a static table of 15 weakness classes. The
auditor validates every model-supplied `weaknessId` against this
table before exposing it to the MCP client. This stops the model
from inventing categories that don't exist in our taxonomy.

**`src/cysicClient.js`** is a thin OpenAI-compatible client. It
reads `CYSIC_API_KEY`, `CYSIC_BASE_URL`, `CYSIC_MODEL`, and
`CYSIC_TIMEOUT_MS` from `process.env` with the documented defaults.
It uses Node 18+'s global `fetch` and an `AbortController` for
timeouts. There is no axios / node-fetch dependency.

## Data flow for `audit_circuit`

```
                source, lang?
                      │
                      ▼
            ┌───────────────────┐
            │   validateSource  │  throw on non-string / empty / > 200 KB
            │   validateLang    │  default = "circom" or auto-detect
            └─────────┬─────────┘
                      │
        ┌─────────────┴─────────────┐
        │   Pass 1: RECON / INTENT  │   model returns
        │   (reconUserPrompt)       │ ─▶ { intent, publicSignals,
        │                           │      privateSignals, summary }
        └─────────────┬─────────────┘
                      │
        ┌─────────────┴─────────────┐
        │   Pass 2: CONSTRAINT MAP  │   model returns
        │   (constraintExtraction   │ ─▶ { signals: [...],
        │    UserPrompt)            │      danglingSignals: [...] }
        └─────────────┬─────────────┘
                      │
        ┌─────────────┴─────────────┐
        │   Pass 3: SOUNDNESS CHECK │   model returns
        │   (soundnessUserPrompt)   │ ─▶ { findings: [ ... ] }
        │   compares (1) vs (2)     │   each finding normalized
        └─────────────┬─────────────┘   against src/zkwc.js
                      │
        ┌─────────────┴─────────────┐
        │   Pass 4: SCORING         │   model returns
        │   (scoringUserPrompt)     │ ─▶ { soundnessScore, summary }
        │   local fallback scoring  │   local score is the backup
        └─────────────┬─────────────┘
                      │
                      ▼
        ┌────────────────────────────┐
        │  assemble final result     │
        │  { findings, summary,      │
        │    soundnessScore,         │
        │    meta: { language,       │
        │             publicSignals, │
        │             privateSignals,│
        │             intent,        │
        │             constraints }  │
        └─────────────┬──────────────┘
                      │ JSON.stringify(_, null, 2)
                      ▼
                MCP tool response
```

## Why a 4-pass pipeline?

Compilers (Circom's `circom`, Noir's `nargo`, Halo2's `halo2`)
check the **constraint system** they are given. They cannot know
what the author *intended*. A circuit that compiles, runs on
valid inputs, and produces a valid proof can still be
**unsound** — accepting invalid witnesses — if the constraint
system is incomplete.

The 4-pass pipeline is designed to make this gap explicit:

1. **Pass 1: Recon / Intent.** *"What does this circuit claim to
   prove?"* The model summarizes intent in its own words,
   enumerates public and private signals, and gives a one-line
   intent statement. This is the ground truth the rest of the
   pipeline will compare against.

2. **Pass 2: Constraint extraction.** *"What constraints actually
   exist?"* The model walks the source and produces a structured
   map: for each signal, its visibility, the constraints that
   pin it, and whether it is unconstrained. This is the structural
   ground truth.

3. **Pass 3: Soundness check (intent vs constraints).** *"Where
   do they disagree?"* The model is given both (1) and (2) and is
   asked to find the gap. The 15 ZKWC categories guide the
   search. Each finding is normalized against `src/zkwc.js` so
   the client always sees a known id.

4. **Pass 4: Scoring.** *"How bad is it, on a 0-100 scale?"* A
   separate scoring prompt forces the model to apply a
   deterministic rubric (critical: −25, high: −10, medium: −4,
   low: −1, info: 0) so the score is comparable across audits.
   A `localScore` rule is the deterministic fallback if the
   scoring call fails.

### Why not a single prompt?

A single-prompt auditor conflates intent inference with
constraint enumeration, and the model tends to either
(a) hallucinate constraints it wishes existed or (b) report
the circuit as sound because it cannot keep all the signal
names straight. Splitting the pipeline into 4 focused passes
gives each pass a smaller context, more specific instructions,
and a JSON output that the next pass can directly consume. It
also matches how a human reviewer would structure the work:
read the circuit, write down what it claims, write down what
it actually enforces, compare, score.

### Why force JSON and strip fences?

The model occasionally wraps JSON in ` ```json ... ``` ` even
when `response_format: { type: "json_object" }` is set. The
client (`chatJSON`) always:

1. requests JSON mode,
2. strips ` ``` ` fences defensively,
3. surfaces a clear error if the model still did not return
   parseable JSON (the error includes the first 1000 chars of
   raw content for debugging).

This means the rest of the pipeline can trust the data.

## Error model

| Where it can fail           | What the auditor does                                |
| --------------------------- | ---------------------------------------------------- |
| Empty / huge source         | Throws a clear error from `validateSource`.          |
| Unsupported `lang`          | Throws from `validateLang` with the supported list.  |
| Missing `CYSIC_API_KEY`     | Throws from `cysicClient.chat` before any HTTP call. |
| Network / timeout           | `AbortController` fires, throws with `code: ETIMEDOUT` or `ENETWORK`. |
| Non-2xx response            | Throws with `status` and the API's error message.    |
| Non-JSON model output       | Throws with the first 1000 chars of raw content.     |
| Bad `weaknessId` from model | Silently dropped (auditor only accepts ids in `src/zkwc.js`). |
| Model `soundnessScore` not a number | Falls back to `localScore` (deterministic rubric). |
| `auditor.js` call fails     | Caught in the tool handler; MCP response is `isError: true` with a clear message. |

## Where to look first in the code

- Want to add a weakness class? — `src/zkwc.js`.
- Want to tune how the model reasons? — `src/prompts.js`.
- Want to change the scoring rubric? — `src/auditor.js#scoringUserPrompt`
  and `src/auditor.js#localScore` (fallback).
- Want to add a new tool? — register it in `server.js` and add
  the orchestration function to `src/auditor.js`.

## Why CommonJS, Node 18+ global `fetch`, and no bundler?

- **CommonJS** keeps the project zero-build. You `git clone`,
  `npm install`, and `node server.js`. No `tsc`, no `esbuild`,
  no `webpack`, no surprise CJS/ESM interop. Anyone can read
  the source line-by-line.
- **Node 18+ global `fetch`** means the only runtime dependency
  is the MCP SDK. No `axios`, no `node-fetch`, no undici. The
  Cysic API is OpenAI-compatible, so a stock `fetch` is enough.
- **No bundler** keeps the deploy story trivial: copy the
  directory, run `npm install --production`, and you're done.
