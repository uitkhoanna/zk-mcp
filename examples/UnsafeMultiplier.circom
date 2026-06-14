pragma circom 2.1.6;

// UnsafeMultiplier.circom
//
// This circuit is INTENDED to prove that the prover knows two factors
// a and b whose product equals a public value `pub`. The author wanted
// the circuit to expose a single `out` that is constrained to a*b.
//
// It contains MULTIPLE soundness bugs that real Circom code has shipped
// with in the wild. Use this as a demo for the auditor:
//
//   audit_circuit(source = <contents of this file>)
//
// Expected findings include ZKWC-001 (under-constrained output),
// ZKWC-008 (<-- without matching ===), ZKWC-002 (unconstrained signal),
// and ZKWC-003 (missing range check).
//
// Fix: replace `<-- a * b` with `out <== a * b;` (or add
// `out === a * b;` as a separate constraint) and remove the dangling
// `intermediate sum;` or pin it with a constraint.

template UnsafeMultiplier() {
    // Public input (declared but used unsafely below).
    signal input pub;

    // Private inputs.
    signal input a;
    signal input b;

    // Declared as a witness-only assignment — `<--` does NOT add a
    // constraint. The compiler will not complain.
    signal output out;
    out <-- a * b;

    // The author *intended* this constraint but forgot it. Because
    // `<--` is witness-only, `out` is fully prover-chosen.
    // out === a * b;  // <-- intentionally missing

    // A dangling intermediate signal: assigned but never constrained.
    signal intermediate sum;
    sum <-- a + b;

    // The "public binding" only weakly ties `pub` to a*b. It does NOT
    // pin `out` at all, and `pub` itself is not range-checked.
    pub === out;
}

component main { public [pub] } = UnsafeMultiplier();
