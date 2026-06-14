/**
 * Thin client for the Cysic Minimax chat completions API.
 *
 * Base URL: https://token-ai.cysic.xyz/v1   (OpenAI-compatible)
 * Model:    "minimax-m3" (default; override via CYSIC_MODEL)
 * Auth:     Authorization: Bearer ${CYSIC_API_KEY}
 *
 * Uses Node 18+ global fetch. No axios / node-fetch.
 */

const DEFAULT_BASE_URL = "https://token-ai.cysic.xyz/v1";
const DEFAULT_MODEL = "minimax-m3";
const DEFAULT_TIMEOUT_MS = 60000;

function getConfig() {
  return {
    apiKey: process.env.CYSIC_API_KEY || "",
    baseUrl: (process.env.CYSIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: process.env.CYSIC_MODEL || DEFAULT_MODEL,
    timeoutMs: parseInt(process.env.CYSIC_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Make a chat completion request.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [opts]
 * @param {string} [opts.model]         - override model
 * @param {number} [opts.temperature]   - sampling temperature
 * @param {number} [opts.maxTokens]     - max output tokens
 * @param {string} [opts.responseFormat] - 'json' to request JSON mode
 * @param {number} [opts.timeoutMs]     - request timeout
 * @returns {Promise<{content: string, raw: object}>}
 */
async function chat(messages, opts) {
  const cfg = getConfig();
  if (!cfg.apiKey) {
    throw new Error(
      "CYSIC_API_KEY is not set. Set it in your environment (or .env) " +
        "before running the auditor. See .env.example."
    );
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("chat(): messages must be a non-empty array");
  }

  const model = (opts && opts.model) || cfg.model;
  const temperature = (opts && typeof opts.temperature === "number") ? opts.temperature : 0.2;
  const maxTokens = (opts && typeof opts.maxTokens === "number") ? opts.maxTokens : 4096;
  const timeoutMs = (opts && typeof opts.timeoutMs === "number") ? opts.timeoutMs : cfg.timeoutMs;
  const responseFormat = (opts && opts.responseFormat === "json") ? "json" : null;

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (responseFormat === "json") {
    body.response_format = { type: "json_object" };
  }

  const url = `${cfg.baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: "application/json",
        "User-Agent": "zk-circuit-auditor-mcp/0.1.0",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      const e = new Error(`Cysic API request timed out after ${timeoutMs}ms`);
      e.code = "ETIMEDOUT";
      throw e;
    }
    const e = new Error(`Cysic API network error: ${err && err.message ? err.message : err}`);
    e.code = "ENETWORK";
    throw e;
  }
  clearTimeout(timer);

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    const err = new Error(
      `Cysic API returned non-JSON (status ${res.status}): ${text.slice(0, 500)}`
    );
    err.status = res.status;
    throw err;
  }

  if (!res.ok) {
    const msg =
      (data && data.error && (data.error.message || data.error)) ||
      `Cysic API error status ${res.status}`;
    const err = new Error(`Cysic API error: ${msg}`);
    err.status = res.status;
    err.raw = data;
    throw err;
  }

  if (!data || !data.choices || !data.choices.length) {
    throw new Error("Cysic API returned an empty completion (no choices).");
  }
  const choice = data.choices[0];
  const content =
    (choice && choice.message && typeof choice.message.content === "string"
      ? choice.message.content
      : "") || "";

  return { content, raw: data };
}

/**
 * Strip ```json ... ``` fences (or generic ``` ... ```) from a model
 * response. Models occasionally wrap JSON in code fences even when
 * response_format=json_object is set.
 */
function stripCodeFences(s) {
  if (typeof s !== "string") return s;
  let out = s.trim();
  const fencedJson = out.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedJson) return fencedJson[1].trim();
  if (out.startsWith("```")) {
    out = out.replace(/^```(?:json)?\s*/i, "");
    if (out.endsWith("```")) out = out.slice(0, -3);
    return out.trim();
  }
  return out;
}

/**
 * Run a chat completion and parse the response as JSON.
 * Throws a clear error if the model output is not parseable JSON.
 */
async function chatJSON(messages, opts) {
  const opts2 = Object.assign({}, opts || {}, { responseFormat: "json" });
  const { content, raw } = await chat(messages, opts2);
  const cleaned = stripCodeFences(content);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const err = new Error(
      "Model did not return valid JSON. Raw content: " +
        (content ? content.slice(0, 1000) : "<empty>")
    );
    err.raw = raw;
    err.parseError = e && e.message;
    throw err;
  }
  return { data: parsed, raw, content: cleaned };
}

module.exports = {
  chat,
  chatJSON,
  stripCodeFences,
  getConfig,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
};
