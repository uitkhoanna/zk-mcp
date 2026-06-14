/**
 * Audit logic + multi-pass orchestration.
 *
 * Pipeline (per ARCHITECTURE.md):
 *   1. recon / intent     -> infer what the circuit claims to prove
 *   2. constraint extract -> build a signal -> constraint map
 *   3. soundness check    -> compare (1) vs (2), find intent/constraint gap
 *   4. scoring            -> compute a 0-100 soundnessScore
 *
 * Also exposes: explainCircuit, checkConstraint, suggestConstraints.
 */

const cysic = require("./cysicClient");
const p = require("./prompts");
const { isValidWeaknessId, listWeaknesses } = require("./zkwc");

const SUPPORTED_LANGS = ["circom", "noir", "halo2"];
const MAX_SOURCE_LEN = 200_000; // 200 KB of source per audit

function detectLang(source, lang) {
  if (lang && SUPPORTED_LANGS.includes(lang)) return lang;
  const s = String(source || "");
  if (/\bpragma\s+circom\b/i.test(s) || /signal\s+(input|output|intermediate)\b/i.test(s)) {
    return "circom";
  }
  if (/\buse\s+dep::|fn\s+main\s*\(|assert\s*\(/.test(s) && /noir_stdlib|noir_/i.test(s)) {
    return "noir";
  }
  if (/halo2|halo2_gadgets|Region|FloorPlanner|configure\(|meta\./.test(s)) {
    return "halo2";
  }
  return "circom";
}

function validateSource(source) {
  if (typeof source !== "string") {
    throw new Error("source must be a string");
  }
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error("source is empty");
  }
  if (trimmed.length > MAX_SOURCE_LEN) {
    throw new Error(
      `source is too large (${trimmed.length} chars). ` +
        `Maximum is ${MAX_SOURCE_LEN} chars.`
    );
  }
  return trimmed;
}

function validateLang(lang) {
  if (!lang) return "circom";
  if (!SUPPORTED_LANGS.includes(lang)) {
    throw new Error(
      `Unsupported language '${lang}'. Use one of: ${SUPPORTED_LANGS.join(", ")}`
    );
  }
  return lang;
}

const SEVERITIES = ["critical", "high", "medium", "low", "info"];

function normalizeFinding(f) {
  if (!f || typeof f !== "object") return null;
  const severity = SEVERITIES.includes(f.severity) ? f.severity : "medium";
  const weaknessId = isValidWeaknessId(f.weaknessId) ? f.weaknessId : null;
  const out = {
    severity,
    category: typeof f.category === "string" ? f.category : "unspecified",
    title: typeof f.title === "string" ? f.title : "Untitled finding",
    description:
      typeof f.description === "string" ? f.description : "",
    fix: typeof f.fix === "string" ? f.fix : "",
    weaknessId,
  };
  if (typeof f.signal === "string" && f.signal.trim()) out.signal = f.signal;
  if (typeof f.line === "number" && Number.isFinite(f.line)) out.line = f.line;
  if (typeof f.location === "string" && f.location.trim()) out.location = f.location;
  return out;
}

function normalizeFindings(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const f of arr) {
    const n = normalizeFinding(f);
    if (n) out.push(n);
  }
  return out;
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

function severityCounts(findings) {
  const c = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    if (c[f.severity] !== undefined) c[f.severity]++;
  }
  return c;
}

function buildSummary(findings, reconSummary) {
  const c = severityCounts(findings);
  const parts = [];
  parts.push(
    `${findings.length} finding(s): ${c.critical} critical, ${c.high} high, ` +
      `${c.medium} medium, ${c.low} low, ${c.info} info.`
  );
  if (reconSummary && typeof reconSummary === "string") {
    parts.push("Intent: " + reconSummary);
  }
  if (findings.length === 0) {
    parts.push("No weaknesses detected by the auditor.");
  }
  return parts.join(" ");
}

/**
 * Run the full 4-pass audit.
 * Returns a structured result that maps directly to the
 * audit_circuit tool's JSON contract.
 */
async function auditCircuit(source, lang) {
  const src = validateSource(source);
  const lg = validateLang(lang);
  const messages = (userPrompts) => [
    { role: "system", content: p.SYSTEM_PROMPT },
    { role: "user", content: userPrompts },
  ];

  // Pass 1: recon / intent
  const reconRes = await cysic.chatJSON(messages(p.reconUserPrompt(src, lg)), {
    temperature: 0.1,
  });
  const recon = {
    intent: typeof reconRes.data.intent === "string" ? reconRes.data.intent : "",
    publicSignals: Array.isArray(reconRes.data.publicSignals)
      ? reconRes.data.publicSignals.filter((s) => typeof s === "string")
      : [],
    privateSignals: Array.isArray(reconRes.data.privateSignals)
      ? reconRes.data.privateSignals.filter((s) => typeof s === "string")
      : [],
    summary: typeof reconRes.data.summary === "string" ? reconRes.data.summary : "",
  };

  // Pass 2: constraint extraction
  let constraints = { signals: [], danglingSignals: [] };
  try {
    const cRes = await cysic.chatJSON(
      messages(p.constraintExtractionUserPrompt(src, lg, recon)),
      { temperature: 0.1 }
    );
    if (cRes.data && Array.isArray(cRes.data.signals)) {
      constraints.signals = cRes.data.signals
        .filter((s) => s && typeof s === "object")
        .map((s) => ({
          name: typeof s.name === "string" ? s.name : "",
          visibility: ["public", "private", "intermediate", "output"].includes(s.visibility)
            ? s.visibility
            : "intermediate",
          constraints: Array.isArray(s.constraints)
            ? s.constraints.filter((x) => typeof x === "string")
            : [],
          unconstrained: Boolean(s.unconstrained),
          notes: typeof s.notes === "string" ? s.notes : "",
        }));
    }
    if (cRes.data && Array.isArray(cRes.data.danglingSignals)) {
      constraints.danglingSignals = cRes.data.danglingSignals.filter(
        (s) => typeof s === "string"
      );
    }
  } catch (e) {
    // Constraint extraction is auxiliary; continue even if it fails.
    constraints.error = e && e.message;
  }

  // Pass 3: soundness check
  const soundRes = await cysic.chatJSON(
    messages(p.soundnessUserPrompt(src, lg, recon, constraints)),
    { temperature: 0.2 }
  );
  const findings = normalizeFindings(
    Array.isArray(soundRes.data.findings) ? soundRes.data.findings : []
  );

  // Pass 4: scoring
  let soundnessScore = localScore(findings);
  let scoreSummary = "";
  try {
    const sRes = await cysic.chatJSON(
      [
        { role: "system", content: p.SYSTEM_PROMPT },
        { role: "user", content: p.scoringUserPrompt(findings) },
      ],
      { temperature: 0.0 }
    );
    if (
      sRes.data &&
      typeof sRes.data.soundnessScore === "number" &&
      Number.isFinite(sRes.data.soundnessScore)
    ) {
      soundnessScore = Math.max(0, Math.min(100, Math.round(sRes.data.soundnessScore)));
    }
    if (sRes.data && typeof sRes.data.summary === "string") {
      scoreSummary = sRes.data.summary;
    }
  } catch (e) {
    // Fall back to local scoring.
    scoreSummary = "Local scoring used (model scoring call failed: " + e.message + ")";
  }

  const summary = scoreSummary || buildSummary(findings, recon.summary);

  return {
    findings,
    summary,
    soundnessScore,
    meta: {
      language: lg,
      publicSignals: recon.publicSignals,
      privateSignals: recon.privateSignals,
      intent: recon.intent,
      constraints,
    },
  };
}

/**
 * Targeted check for a single concern (e.g. "is `out` fully constrained?").
 */
async function checkConstraint(source, concern) {
  const src = validateSource(source);
  if (typeof concern !== "string" || !concern.trim()) {
    throw new Error("concern must be a non-empty string");
  }
  const lg = detectLang(src, null);
  const messages = [
    { role: "system", content: p.SYSTEM_PROMPT },
    { role: "user", content: p.targetedCheckUserPrompt(src, lg, concern) },
  ];
  const res = await cysic.chatJSON(messages, { temperature: 0.1 });
  const data = res.data || {};
  const verdict = ["sound", "unsound", "inconclusive"].includes(data.verdict)
    ? data.verdict
    : "inconclusive";
  const findings = normalizeFindings(
    Array.isArray(data.findings) ? data.findings : []
  );
  return {
    concern: typeof data.concern === "string" ? data.concern : concern,
    verdict,
    explanation:
      typeof data.explanation === "string" ? data.explanation : "",
    findings,
    meta: { language: lg },
  };
}

/**
 * Plain-English explanation of a circuit.
 */
async function explainCircuit(source, lang) {
  const src = validateSource(source);
  const lg = validateLang(lang);
  const messages = [
    { role: "system", content: p.SYSTEM_PROMPT },
    { role: "user", content: p.explainUserPrompt(src, lg) },
  ];
  const res = await cysic.chatJSON(messages, { temperature: 0.2 });
  const data = res.data || {};
  return {
    summary: typeof data.summary === "string" ? data.summary : "",
    publicSignals: Array.isArray(data.publicSignals) ? data.publicSignals : [],
    privateSignals: Array.isArray(data.privateSignals) ? data.privateSignals : [],
    signalToConstraintMap: Array.isArray(data.signalToConstraintMap)
      ? data.signalToConstraintMap
      : [],
    reviewerNotes: Array.isArray(data.reviewerNotes)
      ? data.reviewerNotes.filter((s) => typeof s === "string")
      : [],
    meta: { language: lg },
  };
}

/**
 * Suggest the minimal set of additional constraints to make the
 * circuit sound. Returns code snippets in the same language as source.
 */
async function suggestConstraints(source, lang) {
  const src = validateSource(source);
  const lg = validateLang(lang);
  // Lightweight recon: intent only, to ground the suggestions.
  let recon = {};
  try {
    const reconRes = await cysic.chatJSON(
      [
        { role: "system", content: p.SYSTEM_PROMPT },
        { role: "user", content: p.reconUserPrompt(src, lg) },
      ],
      { temperature: 0.1 }
    );
    recon = {
      intent: typeof reconRes.data.intent === "string" ? reconRes.data.intent : "",
      publicSignals: Array.isArray(reconRes.data.publicSignals)
        ? reconRes.data.publicSignals
        : [],
      privateSignals: Array.isArray(reconRes.data.privateSignals)
        ? reconRes.data.privateSignals
        : [],
      summary: typeof reconRes.data.summary === "string" ? reconRes.data.summary : "",
    };
  } catch (_e) {
    // Continue without recon if the model call fails.
  }
  const messages = [
    { role: "system", content: p.SYSTEM_PROMPT },
    { role: "user", content: p.suggestConstraintsUserPrompt(src, lg, recon) },
  ];
  const res = await cysic.chatJSON(messages, { temperature: 0.2 });
  const suggestions = Array.isArray(res.data && res.data.suggestions)
    ? res.data.suggestions
        .map((s) => {
          if (!s || typeof s !== "object") return null;
          const out = {
            weaknessId: isValidWeaknessId(s.weaknessId) ? s.weaknessId : null,
            title: typeof s.title === "string" ? s.title : "",
            rationale: typeof s.rationale === "string" ? s.rationale : "",
            codeSnippet: typeof s.codeSnippet === "string" ? s.codeSnippet : "",
            location: typeof s.location === "string" ? s.location : "",
          };
          return out;
        })
        .filter(Boolean)
    : [];
  return {
    suggestions,
    meta: { language: lg, intent: recon.intent || "" },
  };
}

module.exports = {
  auditCircuit,
  checkConstraint,
  explainCircuit,
  suggestConstraints,
  detectLang,
  SUPPORTED_LANGS,
  listWeaknesses,
};
