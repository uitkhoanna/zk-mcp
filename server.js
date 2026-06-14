#!/usr/bin/env node
/**
 * zk-circuit-auditor-mcp
 *
 * MCP server (stdio transport) that audits zero-knowledge circuits
 * (Circom, Noir, Halo2) for soundness and constraint bugs using the
 * Cysic Minimax model.
 *
 * Run:    node server.js
 * Config: see .env.example for CYSIC_API_KEY.
 *
 * Tools exposed:
 *   - audit_circuit(source, lang?)
 *   - check_constraint(source, concern)
 *   - explain_circuit(source, lang?)
 *   - suggest_constraints(source, lang?)
 */

"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const z = require("zod");

const auditor = require("./src/auditor");

const SERVER_NAME = "zk-circuit-auditor-mcp";
const SERVER_VERSION = "0.1.0";

function makeServer() {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // ---------- audit_circuit ----------
  server.tool(
    "audit_circuit",
    "Audit a ZK circuit (Circom, Noir, or Halo2) for soundness and constraint bugs. " +
      "Returns structured findings, a summary, and a 0-100 soundnessScore. " +
      "Each finding is tagged with a ZK Weakness Classification id (ZKWC-001..015).",
    {
      source: z.string().min(1).describe("The full circuit source code as a string."),
      lang: z
        .enum(["circom", "noir", "halo2"])
        .optional()
        .describe("Source language. If omitted, the auditor auto-detects from the source."),
    },
    async ({ source, lang }) => {
      try {
        const result = await auditor.auditCircuit(source, lang);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `audit_circuit failed: ${err && err.message ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ---------- check_constraint ----------
  server.tool(
    "check_constraint",
    "Targeted check for a single reviewer's concern (e.g. 'is the output `out` fully constrained?'). " +
      "Returns a verdict (sound/unsound/inconclusive), an explanation, and any findings.",
    {
      source: z.string().min(1).describe("The full circuit source code as a string."),
      concern: z
        .string()
        .min(1)
        .describe("The reviewer's specific concern, expressed as a question or statement."),
    },
    async ({ source, concern }) => {
      try {
        const result = await auditor.checkConstraint(source, concern);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `check_constraint failed: ${err && err.message ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ---------- explain_circuit ----------
  server.tool(
    "explain_circuit",
    "Plain-English explanation of a ZK circuit: what it proves, its public/private signals, " +
      "and a signal -> constraint map. Useful for onboarding reviewers.",
    {
      source: z.string().min(1).describe("The full circuit source code as a string."),
      lang: z
        .enum(["circom", "noir", "halo2"])
        .optional()
        .describe("Source language. If omitted, the auditor auto-detects from the source."),
    },
    async ({ source, lang }) => {
      try {
        const result = await auditor.explainCircuit(source, lang);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `explain_circuit failed: ${err && err.message ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ---------- suggest_constraints ----------
  server.tool(
    "suggest_constraints",
    "Propose the minimal set of additional constraints (or, in Noir/Halo2, code-level additions) " +
      "to make the circuit sound. Returns code snippets tagged with ZK Weakness Classification ids.",
    {
      source: z.string().min(1).describe("The full circuit source code as a string."),
      lang: z
        .enum(["circom", "noir", "halo2"])
        .optional()
        .describe("Source language. If omitted, the auditor auto-detects from the source."),
    },
    async ({ source, lang }) => {
      try {
        const result = await auditor.suggestConstraints(source, lang);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `suggest_constraints failed: ${err && err.message ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  return server;
}

async function main() {
  // Lightweight startup banner on stderr (stdout is the MCP transport).
  if (process.env.CYSIC_API_KEY) {
    process.stderr.write(
      `[${SERVER_NAME}] starting; model=${process.env.CYSIC_MODEL || "minimax-m3"}, ` +
        `base=${process.env.CYSIC_BASE_URL || "https://token-ai.cysic.xyz/v1"}\n`
    );
  } else {
    process.stderr.write(
      `[${SERVER_NAME}] WARNING: CYSIC_API_KEY is not set. Tools will fail until it is.\n`
    );
  }

  const server = makeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[${SERVER_NAME}] fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
