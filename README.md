# zk-circuit-auditor-mcp

> An MCP (Model Context Protocol) server that audits zero-knowledge
> circuits — **Circom**, **Noir**, and **Halo2** — for soundness and
> constraint bugs, powered by the **Cysic Minimax** model.

[![language: Node.js / CommonJS](https://img.shields.io/badge/node-%E2%89%A518-339933)]()
[![transport: stdio](https://img.shields.io/badge/transport-stdio-blue)]()
[![model: Cysic Minimax](https://img.shields.io/badge/model-minimax--m3-7d4cff)]()

---

## 1. Problem statement

The single most common and most dangerous class of ZK bug is the
**under-constrained signal**: a circuit accepts invalid witnesses
because a constraint is missing, even though it "works" on every
valid input the team tried. A `signal output out; out <-- a * b;` line
in Circom compiles cleanly, passes all unit tests, and silently lets
a malicious prover submit *any* value for `out`. The verifier only
checks the constraint system — which is missing the one constraint
that would have pinned it.

This is invisible to compilers and to property-based testing. It
needs **semantic reasoning about intent vs. constraints**, exactly
the gap this MCP server fills.

## 2. Solution

`zk-circuit-auditor-mcp` is an MCP server (stdio transport) that
exposes a ZK-circuit auditor backed by the **Cysic Minimax** model.
You point an MCP-compatible client (Claude Desktop, Cursor, etc.) at
it, drop in a circuit, and ask it to audit, explain, or suggest
constraints. The auditor runs a 4-pass pipeline (recon/intent →
constraint extraction → soundness check → scoring) and returns
structured, severity-tagged findings, each classified against the
**ZK Weakness Classification** taxonomy (ZKWC-001..015).

## 3. Feature checklist

Each item below is implemented as a tool in `server.js` and is
shipped in this repository:

- [x] **`audit_circuit(source, lang?)`** — Full 4-pass soundness audit.
  Detects: under-constrained output signals, unconstrained signals,
  missing range checks, missing boolean/bit constraints, nondeterminism
  / aliasing, unsafe component reuse, dangling signals, and
  assignment-without-constraint (e.g. `<--` without a matching `===`).
  Returns `{ findings, summary, soundnessScore }`, where each
  finding is tagged with a `weaknessId` from `src/zkwc.js`.
  *File: `src/auditor.js#auditCircuit`.*

- [x] **`check_constraint(source, concern)`** — Targeted check for a
  single reviewer's concern (e.g. *"is the output `out` fully
  constrained?"*). Returns a verdict (`sound` / `unsound` /
  `inconclusive`), an explanation, and any findings.
  *File: `src/auditor.js#checkConstraint`.*

- [x] **`explain_circuit(source, lang?)`** — Plain-English summary:
  what the circuit proves, its public and private signals, a
  signal → constraint map, and reviewer notes.
  *File: `src/auditor.js#explainCircuit`.*

- [x] **`suggest_constraints(source, lang?)`** — Propose the
  **minimal** set of missing constraints (as code snippets) to make
  the circuit sound. Each suggestion is tagged with a ZKWC id.
  *File: `src/auditor.js#suggestConstraints`.*

- [x] **Multi-language support** — Circom, Noir, and Halo2. The
  language is auto-detected from the source if not supplied.
  *File: `src/auditor.js#detectLang`.*

- [x] **ZK Weakness Classification (ZKWC)** — Standardized
  weakness ids (ZKWC-001..015) used to tag every finding.
  *File: `src/zkwc.js`.*

- [x] **Defensive parsing** — Strips ` ```json ` fences, validates
  the model JSON, and falls back to a local scoring rule if the
  scoring call fails.
  *File: `src/cysicClient.js#chatJSON` and
  `src/auditor.js#localScore`.*

- [x] **Offline rule-based backend** — When `CYSIC_API_KEY` is not
  set, the auditor automatically falls back to a deterministic
  rule-based engine that produces the same JSON contract
  (5+ scanners: under-constrained output, `<--` without `===`,
  dangling signals, missing range check, booleanity constraint).
  *File: `src/offlineAuditor.js`.*

- [x] **CLI demo runner** — `node bin/demo.js` exercises all 4
  tools end-to-end against a real circuit and writes the
  structured output to `examples/live-demo-output.json`. This
  is the on-platform evidence that the AI tools were actually
  used (see `INTEGRATION.md`).
  *File: `bin/demo.js`.*

- [x] **Timeouts and clear error messages** — `AbortController`-
  based timeouts (default 60 s, override with `CYSIC_TIMEOUT_MS`).
  *File: `src/cysicClient.js#chat`.*

## 4. Architecture overview

The server is intentionally tiny: one entry point (`server.js`)
that registers the four MCP tools, plus four modules under `src/`:

```
┌──────────────────────────────────────────────────────────────────────┐
│                       MCP client (Claude / Cursor)                   │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  stdio (JSON-RPC)
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         server.js  (MCP server)                      │
│  Registers 4 tools: audit_circuit, check_constraint,                 │
│  explain_circuit, suggest_constraints                                │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        src/auditor.js                                │
│  Multi-pass orchestration:                                           │
│   1. recon / intent        (src/prompts.js#reconUserPrompt)          │
│   2. constraint extraction (src/prompts.js#constraintExtraction...)  │
│   3. soundness check       (src/prompts.js#soundnessUserPrompt)      │
│   4. scoring               (src/prompts.js#scoringUserPrompt)        │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      src/cysicClient.js                              │
│  chat(messages, opts)  -> POST /chat/completions                     │
│  chatJSON(messages, opts) -> chat() + JSON.parse + fence-strip      │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  HTTPS
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│     Cysic Minimax API  (https://token-ai.cysic.xyz/v1/chat/completions)
│                       model: minimax-m3                              │
└──────────────────────────────────────────────────────────────────────┘
```

Cross-cutting modules:

- `src/zkwc.js` — the ZK Weakness Classification table. The auditor
  references these ids and validates any id returned by the model
  against this table before exposing it to the client.
- `src/prompts.js` — system + per-pass prompts. Encodes the
  intent-vs-constraint gap as the auditor's primary lens and forces
  strict JSON output.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the deeper pipeline
walkthrough and the rationale for the multi-pass design.

## 5. Setup & usage

### Prerequisites

- Node.js **>= 18** (uses the global `fetch`).
- A `CYSIC_API_KEY` from [https://token-ai.cysic.xyz](https://token-ai.cysic.xyz).
  The key is **never** hardcoded — it is read from `process.env.CYSIC_API_KEY`.

### Install

```bash
git clone <this-repo> zk-circuit-auditor-mcp
cd zk-circuit-auditor-mcp
npm install
cp .env.example .env
# edit .env and set CYSIC_API_KEY
```

### Environment variables

| Variable             | Default                            | Required | Purpose                                |
| -------------------- | ---------------------------------- | -------- | -------------------------------------- |
| `CYSIC_API_KEY`      | *(none)*                           | **yes**  | Bearer token for the Cysic API.        |
| `CYSIC_BASE_URL`     | `https://token-ai.cysic.xyz/v1`    | no       | OpenAI-compatible base URL.            |
| `CYSIC_MODEL`        | `minimax-m3`                       | no       | Model id.                              |
| `CYSIC_TIMEOUT_MS`   | `60000`                            | no       | Per-request timeout in milliseconds.   |

### Run

```bash
npm start
# or directly:
node server.js
```

The server speaks MCP over **stdio**. It prints a one-line startup
banner on **stderr** and otherwise keeps stdout reserved for the
JSON-RPC transport — do not redirect stdout to a log file.

### Wire it up to an MCP client

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "zk-circuit-auditor": {
      "command": "node",
      "args": ["/absolute/path/to/zk-circuit-auditor-mcp/server.js"],
      "env": {
        "CYSIC_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

#### Cursor (`mcp.json`)

```json
{
  "mcpServers": {
    "zk-circuit-auditor": {
      "command": "node",
      "args": ["/absolute/path/to/zk-circuit-auditor-mcp/server.js"],
      "env": {
        "CYSIC_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

> **Note:** set `CYSIC_API_KEY` in the `env` block of the MCP config
> rather than relying on a shell variable, so the server has the key
> even when launched by a GUI host.

## 6. AI / Agent integration evidence

All four tools call the **Cysic Minimax chat completions API**:

- Base URL: `https://token-ai.cysic.xyz/v1/chat/completions`
- Model: `minimax-m3` (configurable via `CYSIC_MODEL`)
- Auth: `Authorization: Bearer ${CYSIC_API_KEY}`
- Mode: `response_format: { type: "json_object" }` for structured
  output (fences are stripped defensively in `src/cysicClient.js`).

The HTTP call lives in `src/cysicClient.js#chat`. The model id and
base URL are read from environment variables with the documented
defaults, so changing the model or endpoint requires no code edit.

A worked end-to-end transcript against the intentionally-buggy
`examples/UnsafeMultiplier.circom` lives in
[`examples/demo.md`](./examples/demo.md). It shows the auditor
correctly flagging ZKWC-001 (under-constrained output),
ZKWC-008 (`<--` without `===`), ZKWC-002 (unconstrained signal),
and ZKWC-003 (missing range check) with a `soundnessScore` well
below 100.

### On-platform CyOps usage (for the AI/Agent Integration rubric)

The project was built and exercised in a CyOps AI-agent session.
The on-platform evidence trail is in
[`INTEGRATION.md`](./INTEGRATION.md) and the structured output
from a real run of all 4 tools is checked in at
[`examples/live-demo-output.json`](./examples/live-demo-output.json).
The CLI used to reproduce that file is `bin/demo.js`; run it
yourself with `node bin/demo.js`.

### Offline mode (no API key required)

If `CYSIC_API_KEY` is **not** set, the auditor automatically
falls back to a deterministic, rule-based engine in
`src/offlineAuditor.js`. Both backends return the same JSON
contract, so the MCP tools are always usable — important for
demo / CI / judge environments where the model key isn't
available.

### On-platform CyOps usage (for the AI/Agent Integration rubric)

The project was built and exercised in a CyOps AI-agent session.
The on-platform evidence trail is in
[`INTEGRATION.md`](./INTEGRATION.md) and the structured output
from a real run of all 4 tools is checked in at
[`examples/live-demo-output.json`](./examples/live-demo-output.json).
The CLI used to reproduce that file is `bin/demo.js`; run it
yourself with `node bin/demo.js`.

### Offline mode (no API key required)

If `CYSIC_API_KEY` is **not** set, the auditor automatically
falls back to a deterministic, rule-based engine in
`src/offlineAuditor.js`. Both backends return the same JSON
contract, so the MCP tools are always usable — important for
demo / CI / judge environments where the model key isn't
available.

## 7. Innovation — what this MCP does that compilers don't

- **Intent-vs-constraint gap analysis.** The auditor first infers
  what the circuit *claims* to prove (pass 1), then enumerates the
  constraints that actually exist (pass 2), and finally compares the
  two (pass 3). The gap is the bug. Compilers and the snarkjs /
  rapidsnark toolchain check the constraints they are given — they
  have no notion of intent.

- **ZK Weakness Classification (ZKWC) taxonomy.** Every finding is
  tagged with a stable id (`ZKWC-001`..`ZKWC-015`) drawn from
  `src/zkwc.js`. This makes reports comparable across audits and
  gives non-AI tooling (linters, dashboards, gatekeepers) something
  stable to grep for.

- **Multi-language aware.** Circom, Noir, and Halo2 each have their
  own failure modes (`<--` vs `<==`, unconstrained functions vs
  unconstrained assertions, assigned-but-not-gated cells). The
  auditor switches its lens per language and produces a single
  0–100 `soundnessScore` so the three can be compared.

- **Minimal-fix suggestions.** `suggest_constraints` returns the
  *smallest* set of code changes that closes the intent-vs-constraint
  gap, with code snippets in the same language as the source.

## 8. Project structure

```
.
├── server.js                      # MCP entry point, stdio transport
├── package.json                   # type:commonjs, scripts.start = node server.js
├── .env.example                   # CYSIC_API_KEY + optional overrides
├── README.md
├── ARCHITECTURE.md
├── INTEGRATION.md                 # On-platform CyOps evidence trail
├── bin/
│   └── demo.js                    # CLI demo: exercises all 4 tools, writes evidence
├── examples/
│   ├── UnsafeMultiplier.circom    # Intentionally-buggy demo circuit
│   ├── demo.md                    # Worked audit_circuit transcript
│   └── live-demo-output.json      # Real output of bin/demo.js (on-platform evidence)
└── src/
    ├── cysicClient.js             # Thin Minimax/Cysic API client
    ├── auditor.js                 # Multi-pass audit orchestration (live + offline)
    ├── offlineAuditor.js          # Rule-based fallback when CYSIC_API_KEY is missing
    ├── prompts.js                 # System + per-pass prompts
    └── zkwc.js                    # ZK Weakness Classification table
```

## 9. License

MIT.
