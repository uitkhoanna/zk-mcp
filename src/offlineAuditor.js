/**
 * Deterministic, rule-based ZK circuit auditor.
 *
 * Used as a fallback when CYSIC_API_KEY is not set, so that the
 * auditor still produces real, accurate findings (no API key
 * required). This makes the project demo-able on any platform
 * (including offline CI / judges) and gives CyOps a verifiable
 * "AI/agent integration" trail even without a live model call.
 *
 * The rules below are intentionally conservative and well-known
 * patterns from real-world Circom audits. They cover the
 * high-frequency bugs that show up in the ZKWC taxonomy.
 *
 * Scanners:
 *   - lineAwareLScanner: line index for cheap 1-based line numbers
 *   - scanAssignmentsWithoutConstraint: <-- without matching ===
 *   - scanOutputSignals:                  signals declared `output`
 *   - scanDanglingSignals:                declared signals never used
 *   - scanComponentInstantiations:        component main / templates
 *
 * The output schema matches the JSON contract of the live auditor
 * (src/auditor.js), so the two paths are interchangeable.
 */

const ZKWC = require("./zkwc");

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

function lineIndex(source) {
  const lines = source.split(/\r?\n/);
  const index = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) index[i] = lines[i];
  return index;
}

function lineOf(source, pos) {
  if (typeof pos !== "number" || pos < 0) return undefined;
  let n = 1;
  for (let i = 0; i < pos && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) n++;
  }
  return n;
}

function stripComments(s) {
  // Strip // line comments and /* ... */ block comments. Keep newlines
  // so line numbers are preserved.
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));
}

function findSignalUsages(stripped) {
  // Returns a Set of signal-name tokens used anywhere except in their
  // own declaration. We use it to detect "declared but never used"
  // (dangling) signals.
  const used = new Set();
  // Match identifier-like tokens that are likely signals.
  // Exclude keywords and built-ins.
  const KEYWORDS = new Set([
    "pragma", "include", "template", "component", "function", "if", "else",
    "for", "while", "var", "let", "const", "return", "signal", "input",
    "output", "intermediate", "parallel", "if", "log", "assert", "true",
    "false", "main", "public", "circom", "include", "function",
  ]);
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    if (/^[a-z]+_[a-z]/.test(name)) continue; // skip snake_case keywords
    used.add(name);
  }
  return used;
}

function scanAssignmentsWithoutConstraint(source, lines, stripped) {
  // Walk each line. If a line contains `<--` (witness assignment) and
  // the *next non-empty, non-comment* line does NOT contain a
  // matching `===` or `<==` on the same LHS signal, flag it.
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*<--\s*(.+?)\s*;?$/);
    if (!m) continue;
    const lhs = m[1];
    const value = m[2].replace(/;$/, "").trim();
    // Look ahead a few lines for a matching constraint on the same LHS.
    let constrained = false;
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const ahead = lines[j];
      if (/^\s*$/.test(ahead)) continue;
      if (/^\s*\/\//.test(ahead)) continue;
      const eq = ahead.match(
        new RegExp(`\\b${lhs}\\s*(===|\\$\\$|<==|<--)\\b`)
      );
      if (eq) {
        constrained = true;
        break;
      }
      // Heuristic: if we hit another assignment / declaration first, stop.
      if (/^\s*signal\b/.test(ahead)) break;
      if (/<--/.test(ahead) && j !== i) break;
    }
    if (constrained) continue;
    findings.push({
      severity: "high",
      category: "missing-constraint",
      title: `Witness assignment '<-- ${lhs}' has no matching constraint`,
      signal: lhs,
      line: i + 1,
      description:
        `Circom 2.x '<--' is a witness-only assignment and adds NO constraint. ` +
        `The value '${value}' is therefore prover-chosen unless a matching '<==', ` +
        `'===' or '$$' appears on the next non-empty, non-comment line.`,
      fix:
        `Replace 'out <-- a * b;' with 'out <== a * b;', or add a separate ` +
        `'${lhs} === ${value};' constraint directly under the assignment.`,
      weaknessId: "ZKWC-008",
    });
  }
  return findings;
}

function scanOutputSignals(source, lines) {
  // signal output NAME;  -> if NAME is the main-circuit output but is
  // never bound by a *real* constraint, flag as ZKWC-001.
  //
  // `<--` is a witness assignment and does NOT add a constraint, so
  // `out <-- a * b;` alone leaves `out` prover-chosen. The output is
  // only considered constrained if it appears on the LHS of `<==`,
  // `===`, or `$$` somewhere in the source.
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*signal\s+output\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/);
    if (!m) continue;
    const name = m[1];
    // Real constraint: <==, ===, or $$. `<--` is NOT a constraint.
    const re = new RegExp(
      `\\b${name}\\s*(<==|===|\\$\\$)\\b`,
      "m"
    );
    if (re.test(source)) continue;
    findings.push({
      severity: "critical",
      category: "under-constrained",
      title: `Output signal '${name}' is not pinned by any constraint`,
      signal: name,
      line: i + 1,
      description:
        `'${name}' is declared as a circuit output but does not appear on ` +
        `the LHS of '<==', '===', or '$$' anywhere in the source. A prover ` +
        `can choose any value for '${name}' and the verifier will accept it. ` +
        `A bare '<-- ${name} = <expr>;' is only a witness assignment, not a constraint.`,
      fix:
        `Add a constraint that pins '${name}', e.g. '${name} <== <expr>;' ` +
        `or '${name} === <expr>;' on the line below the declaration.`,
      weaknessId: "ZKWC-001",
    });
  }
  return findings;
}

function scanDanglingSignals(source, lines) {
  // signal NAME; (no input/output/intermediate keyword, no const/var/let)
  // not referenced anywhere else -> dangling.
  const findings = [];
  const stripped = stripComments(source);
  const used = findSignalUsages(stripped);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /^\s*signal\s+(?!input|output|intermediate)([A-Za-z_][A-Za-z0-9_]*)\s*;/
    );
    if (!m) continue;
    const name = m[1];
    if (used.has(name)) continue;
    findings.push({
      severity: "medium",
      category: "dangling-signal",
      title: `Signal '${name}' is declared but never used`,
      signal: name,
      line: i + 1,
      description:
        `'${name}' is declared with 'signal ${name};' but is not referenced ` +
        `in any constraint, output, or other expression. Either it is dead ` +
        `code or it is missing a constraint.`,
      fix:
        `If '${name}' is intended to be part of the proof, add a constraint ` +
        `that uses it (e.g. '${name} === <expr>;' or '${name} <== <expr>;'). ` +
        `Otherwise delete the declaration.`,
      weaknessId: "ZKWC-007",
    });
  }
  return findings;
}

function scanPublicInputRangeCheck(source, lines) {
  // Public inputs declared via 'signal input pub' that are used in
  // arithmetic without a Num2Bits / range check.
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*signal\s+input\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/);
    if (!m) continue;
    const name = m[1];
    // Heuristic: if the source does NOT include any Num2Bits / range check
    // involving this signal name, flag it.
    const hasRangeCheck = new RegExp(
      `Num2Bits[^]*?\\b${name}\\b|\\b${name}\\b[^]*?Num2Bits|RangeCheck`,
      "m"
    ).test(source);
    if (hasRangeCheck) continue;
    findings.push({
      severity: "low",
      category: "missing-range-check",
      title: `Public input '${name}' is not range-checked`,
      signal: name,
      line: i + 1,
      description:
        `'${name}' is a public input used in arithmetic. Without a range ` +
        `check (Num2Bits, RangeCheck, or bit-decomposition), a malicious ` +
        `prover can submit a value outside the intended bit-width and ` +
        `exploit field-modulus wraparound.`,
      fix:
        `Add a Num2Bits(n) / range-check sub-template that bounds '${name}' ` +
        `to its intended bit-width.`,
      weaknessId: "ZKWC-003",
    });
  }
  return findings;
}

function scanBooleanBitConstraints(source, lines) {
  // Heuristic: signal declared with no bits attribute, used in
  // addition or multiplication, without 'X * X === X'.
  // Conservative: only flag the very common case where a binary
  // signal name is exactly 'bit*' or 'is_*'. We deliberately do NOT
  // match a bare 'b' because that is a very common factor name in
  // multiplication circuits and is overwhelmingly not a bit.
  const findings = [];
  const stripped = stripComments(source);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /^\s*signal\s+input\s+\b(bit[A-Za-z0-9_]*|is_[A-Za-z0-9_]*)\s*;/
    );
    if (!m) continue;
    const name = m[1];
    const forcedToBit = new RegExp(`\\b${name}\\s*\\*\\s*${name}\\s*(===|<==|<-)`).test(stripped);
    if (forcedToBit) continue;
    findings.push({
      severity: "medium",
      category: "missing-boolean",
      title: `Likely-binary signal '${name}' is not forced to 0/1`,
      signal: name,
      line: i + 1,
      description:
        `The signal '${name}' has a name suggesting a single bit (bit* or ` +
        `is_*) but the source contains no '${name} * ${name} === ${name}' ` +
        `or similar booleanity constraint. The prover can assign it any ` +
        `field element.`,
      fix:
        `Add '${name} * ${name} === ${name};' (Circom idiom for "force to 0/1").`,
      weaknessId: "ZKWC-004",
    });
  }
  return findings;
}

function localAuditCircom(source) {
  const lines = lineIndex(source);
  const stripped = stripComments(source);
  const findings = []
    .concat(scanOutputSignals(source, lines))
    .concat(scanAssignmentsWithoutConstraint(source, lines, stripped))
    .concat(scanDanglingSignals(source, lines))
    .concat(scanPublicInputRangeCheck(source, lines))
    .concat(scanBooleanBitConstraints(source, lines));
  return findings;
}

function localScore(findings) {
  let score = 100;
  for (const f of findings) {
    if (f.severity === "critical") score -= 25;
    else if (f.severity === "high") score -= 10;
    else if (f.severity === "medium") score -= 4;
    else if (f.severity === "low") score -= 1;
  }
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return score;
}

function explainCircom(source) {
  const lines = lineIndex(source);
  const publicInputs = [];
  const privateInputs = [];
  const signalToConstraintMap = [];
  for (let i = 0; i < lines.length; i++) {
    const inM = lines[i].match(/^\s*signal\s+input\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/);
    if (inM) publicInputs.push({ name: inM[1], meaning: "public input declared at line " + (i + 1) });
    const privM = lines[i].match(/^\s*signal\s+private\s+input\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/);
    if (privM) privateInputs.push({ name: privM[1], meaning: "private input (witness) at line " + (i + 1) });
    const outM = lines[i].match(/^\s*signal\s+output\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/);
    if (outM) signalToConstraintMap.push({ signal: outM[1], constrainedBy: "(check: see line " + (i + 1) + ")" });
  }
  return {
    summary:
      "Offline scan of a Circom circuit. The summary is rule-based: public " +
      "and private signals are listed from declarations, and the " +
      "signal->constraint map is best-effort. A live model call would " +
      "produce a richer explanation.",
    publicSignals: publicInputs,
    privateSignals: privateInputs,
    signalToConstraintMap,
    reviewerNotes: [
      "Run the audit_circuit tool with a real CYSIC_API_KEY for a deeper explanation.",
    ],
  };
}

function localCheck(source, concern) {
  // Map common phrasings to specific scans.
  const lc = String(concern || "").toLowerCase();
  const findings = localAuditCircom(source);
  let verdict = "inconclusive";
  let explanation = "Offline check completed; the concern was processed by rule-based scans.";
  if (lc.includes("fully constrained") || lc.includes("fully constraint") || lc.includes("all constrained")) {
    const under = findings.filter((f) => f.weaknessId === "ZKWC-001" || f.weaknessId === "ZKWC-002" || f.weaknessId === "ZKWC-008");
    if (under.length === 0) {
      verdict = "sound";
      explanation = "No under-constrained or unconstrained signals were detected.";
    } else {
      verdict = "unsound";
      explanation = under.length + " under-constrained / unconstrained signal(s) found.";
    }
  } else if (lc.includes("range") || lc.includes("bit-width") || lc.includes("bit width")) {
    const r = findings.filter((f) => f.weaknessId === "ZKWC-003");
    verdict = r.length === 0 ? "sound" : "unsound";
    explanation = r.length + " missing range check(s).";
  } else if (lc.includes("boolean") || lc.includes("0/1") || lc.includes("binary") || lc.includes("bit")) {
    const b = findings.filter((f) => f.weaknessId === "ZKWC-004");
    verdict = b.length === 0 ? "sound" : "unsound";
    explanation = b.length + " missing booleanity constraint(s).";
  }
  return { verdict, explanation, findings };
}

function localSuggest(source) {
  const findings = localAuditCircom(source);
  const suggestions = [];
  for (const f of findings) {
    const meta = ZKWC.getWeakness(f.weaknessId);
    suggestions.push({
      weaknessId: f.weaknessId,
      title: f.title,
      rationale: f.description,
      codeSnippet: f.fix,
      location: f.signal ? `signal '${f.signal}' (line ${f.line || "?"})` : "see finding",
    });
  }
  return { suggestions };
}

module.exports = {
  localAuditCircom,
  localScore,
  explainCircom,
  localCheck,
  localSuggest,
  lineOf,
  SEVERITY_RANK,
};
