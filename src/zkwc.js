/**
 * ZK Weakness Classification (ZKWC) taxonomy.
 *
 * Each weakness has a stable id (e.g. "ZKWC-001") used to tag findings
 * returned by the auditor. This gives standardized, professional labels
 * the same way the model/auditor report issues.
 *
 * The taxonomy focuses on the #1 ZK bug class: under-constrained signals,
 * plus the related constraint / soundness failure modes that compilers
 * do not catch on their own.
 */

const ZKWEAK = [
  {
    id: "ZKWC-001",
    title: "Under-constrained output signal",
    description:
      "A signal declared as `output` is not fully constrained by the " +
      "constraint system. The prover can choose any value that satisfies " +
      "the partial constraints, allowing fake proofs.",
  },
  {
    id: "ZKWC-002",
    title: "Unconstrained signal (signal declared but no constraints)",
    description:
      "A signal is computed or assigned but has no constraints that " +
      "tie it to other signals. Such signals are prover-chosen.",
  },
  {
    id: "ZKWC-003",
    title: "Missing range check",
    description:
      "A numeric signal is used in arithmetic (mod p, or in Noir/Halo2 " +
      "field) without bounding it to its intended domain. The prover " +
      "can wrap around the modulus and produce a valid-looking witness.",
  },
  {
    id: "ZKWC-004",
    title: "Missing boolean / bit constraint",
    description:
      "A signal that is meant to be 0/1 is used in additions or " +
      "multiplications without being forced to 0 or 1. Classic example: " +
      "`b*b === b` is required for a binary bit.",
  },
  {
    id: "ZKWC-005",
    title: "Nondeterminism / aliasing",
    description:
      "The same signal is constrained against two unrelated expressions, " +
      "or two signals are equal-constrained but the prover can satisfy " +
      "both with one clever assignment. Often appears as a <-- / <== alias.",
  },
  {
    id: "ZKWC-006",
    title: "Unsafe component reuse / template instantiation",
    description:
      "A sub-component is reused (multiple instances) without an " +
      "uniqueness / linking constraint, so a prover can swap witnesses " +
      "between instances.",
  },
  {
    id: "ZKWC-007",
    title: "Dangling / dead signal",
    description:
      "A signal is declared and assigned but never used in any " +
      "constraint or output. Indicates a missing constraint or dead code.",
  },
  {
    id: "ZKWC-008",
    title: "Assignment without constraint (<-- without ===)",
    description:
      "In Circom 1.x, `<--` is an assignment (witness generation only), " +
      "while `===` is a constraint. Forgetting the matching `===` leaves " +
      "the value unconstrained even though the compiler accepts it.",
  },
  {
    id: "ZKWC-009",
    title: "Public input not bound to private witness",
    description:
      "A public input is declared but never appears in any constraint, " +
      "or is only used in a quadratic identity that does not pin its value.",
  },
  {
    id: "ZKWC-010",
    title: "Incomplete conditional / if-then-else soundness",
    description:
      "An `if (cond) x else y` is implemented but only the truthy " +
      "branch is constrained; the falsy branch can be a prover-chosen " +
      "witness. Both branches must be constrained.",
  },
  {
    id: "ZKWC-011",
    title: "Lookup / permutation argument misuse",
    description:
      "A lookup, permutation, or shuffle is used but the soundness " +
      "precondition (e.g. multiset equality, table inclusion) is not " +
      "enforced, allowing the prover to substitute arbitrary values.",
  },
  {
    id: "ZKWC-012",
    title: "Division by zero / modular inverse risk",
    description:
      "An expression relies on a modular inverse (or division) of a " +
      "signal that may be 0, so the prover can bypass constraints by " +
      "setting that signal to 0 (which usually has no well-defined " +
      "inverse in the field).",
  },
  {
    id: "ZKWC-013",
    title: "Cross-language translation / library mismatch",
    description:
      "When porting a circuit between Circom <-> Noir <-> Halo2 the " +
      "arithmetic semantics, field modulus, or constraint generator " +
      "differ. An off-by-one in range or a sign mismatch can leave the " +
      "ported circuit unsound even though the original was sound.",
  },
  {
    id: "ZKWC-014",
    title: "Weak hash / Pedersen / MiMC parameterization",
    description:
      "Cryptographic primitives (MiMC, Pedersen, Poseidon) are " +
      "instantiated with parameters (round count, constants, key) that " +
      "weaken security. The constraint system itself is sound but the " +
      "primitive is not.",
  },
  {
    id: "ZKWC-015",
    title: "Trusted setup / toxic waste exposure",
    description:
      "The circuit relies on a CRS whose entropy / toxic waste is not " +
      "discarded, or uses a per-circuit setup that a malicious party " +
      "could have generated.",
  },
];

const BY_ID = Object.fromEntries(ZKWEAK.map((w) => [w.id, w]));

function listWeaknesses() {
  return ZKWEAK.map((w) => ({ id: w.id, title: w.title }));
}

function getWeakness(id) {
  return BY_ID[id] || null;
}

function isValidWeaknessId(id) {
  return Object.prototype.hasOwnProperty.call(BY_ID, id);
}

module.exports = {
  ZKWEAK,
  listWeaknesses,
  getWeakness,
  isValidWeaknessId,
};
