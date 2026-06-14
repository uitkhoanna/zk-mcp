# zk-circuit-auditor-mcp — Demo Transcript

This is a worked example of the `audit_circuit` tool against the
intentionally-buggy `examples/UnsafeMultiplier.circom`.

## Setup

```bash
# 1. install dependencies
npm install

# 2. set the API key (do NOT commit it)
export CYSIC_API_KEY="sk-..."

# 3. start the server (stdio transport; configured by your MCP client)
npm start
```

## Tool call

Tool: `audit_circuit`

```json
{
  "source": "<contents of examples/UnsafeMultiplier.circom>",
  "lang": "circom"
}
```

## Expected output (abridged)

The auditor runs the 4-pass pipeline (recon → constraint extraction →
soundness check → scoring) on the Cysic Minimax model. The full
response is JSON like this:

```json
{
  "findings": [
    {
      "severity": "critical",
      "category": "under-constrained",
      "title": "Output signal 'out' is not pinned by any constraint",
      "signal": "out",
      "line": 28,
      "weaknessId": "ZKWC-001",
      "description": "`out` is assigned via `<-- a * b;` (witness-only) and has no matching `===` constraint. The prover may choose any value for `out` while still satisfying `pub === out`.",
      "fix": "Replace `out <-- a * b;` with `out <== a * b;` (or add `out === a * b;` as a separate constraint)."
    },
    {
      "severity": "high",
      "category": "missing-constraint",
      "title": "Witness assignment without matching constraint",
      "signal": "out",
      "line": 28,
      "weaknessId": "ZKWC-008",
      "description": "Circom 2.x `<--` is a witness assignment only and adds NO constraint. The author appears to have intended `out === a * b` (commented out in the source).",
      "fix": "Add `out === a * b;` directly under the `<--` assignment."
    },
    {
      "severity": "high",
      "category": "unconstrained",
      "title": "Signal 'sum' is assigned but never constrained",
      "signal": "sum",
      "line": 36,
      "weaknessId": "ZKWC-002",
      "description": "`sum` is set with `sum <-- a + b;` and never used. This is a dead signal — either remove it or pin it with a constraint that is part of the proof.",
      "fix": "Either delete `signal intermediate sum;` and the assignment, or add `sum === a + b;`."
    },
    {
      "severity": "medium",
      "category": "missing-range-check",
      "title": "Public input 'pub' is not range-checked",
      "signal": "pub",
      "weaknessId": "ZKWC-003",
      "description": "Without a bit-decomposition / range check, a malicious prover can submit a public value outside the expected integer range and exploit the wraparound.",
      "fix": "Add a Num2Bits / range-check sub-template on `pub` if it is supposed to fit in N bits."
    }
  ],
  "summary": "4 finding(s): 1 critical, 2 high, 1 medium, 0 low, 0 info. The `out` signal is unconstrained and prover-chosen. Fix by replacing `<--` with `<==` (or adding a matching `===`) and removing the dangling `sum` signal.",
  "soundnessScore": 61,
  "meta": {
    "language": "circom",
    "publicSignals": ["pub", "out"],
    "privateSignals": ["a", "b"],
    "intent": "Prove knowledge of factors a, b such that a*b == pub, exposing out as the product.",
    "constraints": {
      "signals": [
        { "name": "pub", "visibility": "public", "constraints": ["pub === out"], "unconstrained": false },
        { "name": "a",   "visibility": "private", "constraints": [], "unconstrained": true,  "notes": "Used in unconstrained assignment" },
        { "name": "b",   "visibility": "private", "constraints": [], "unconstrained": true,  "notes": "Used in unconstrained assignment" },
        { "name": "out", "visibility": "output",  "constraints": [], "unconstrained": true,  "notes": "Assigned via <-- with no ===" },
        { "name": "sum", "visibility": "intermediate", "constraints": [], "unconstrained": true, "notes": "Dead / dangling" }
      ],
      "danglingSignals": ["sum"]
    }
  }
}
```

## What this proves

- The auditor caught the **classic under-constrained output** bug
  (ZKWC-001) — `out` has no `===` constraint and is prover-chosen.
- It also caught the **<-- without ===** (ZKWC-008), the **dangling
  signal** (ZKWC-002), and the **missing range check on a public
  input** (ZKWC-003).
- `soundnessScore` reflects a circuit that compiles and accepts valid
  witnesses, but silently accepts invalid ones too.

A *fixed* version of this circuit (replace `<-- a * b` with
`<== a * b`, drop the dangling `sum`) should produce an empty findings
array and `soundnessScore: 100`.
