"use strict";

const { MAX_FINDINGS, MAX_MESSAGE_LENGTH, MAX_JSON_BYTES } = require("./limits");

const CONCLUSIONS = new Set(["observed", "inferred", "needs-owner-verification"]);
const KINDS = new Set(["match", "mismatch", "unknown"]);

function redactSecrets(value) {
  return String(value ?? "")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [REDACTED]");
}

function clean(value, maximum = MAX_MESSAGE_LENGTH) {
  return redactSecrets(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function cleanPath(value) {
  return redactSecrets(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240);
}

class EvidenceLedger {
  constructor(quickstartPath, openapiPath) {
    this.quickstartPath = cleanPath(quickstartPath);
    this.openapiPath = cleanPath(openapiPath);
    this.items = [];
    this.truncated = false;
  }

  add({ check, kind, conclusion, message, line = null }) {
    if (this.items.length >= MAX_FINDINGS) {
      this.truncated = true;
      return;
    }
    if (!KINDS.has(kind) || !CONCLUSIONS.has(conclusion)) throw new TypeError("Invalid evidence classification");
    const safeLine = Number.isInteger(line) && line > 0 ? line : null;
    this.items.push({
      id: `qsp-${String(this.items.length + 1).padStart(3, "0")}`,
      check: clean(check, 64),
      kind,
      conclusion,
      message: clean(message),
      source: safeLine ? { file: this.quickstartPath, line: safeLine } : { file: this.openapiPath, line: null }
    });
  }

  result(metadata = {}) {
    const mismatchCount = this.items.filter((item) => item.kind === "mismatch").length;
    const unknownCount = this.items.filter((item) => item.kind === "unknown").length + (this.truncated ? 1 : 0);
    const state = mismatchCount > 0
      ? "changes-found"
      : unknownCount > 0
        ? "insufficient-public-input"
        : "aligned-on-static-checks";
    const result = {
      schemaVersion: "1.0",
      state,
      counts: {
        checkedRequests: Number(metadata.checkedRequests || 0),
        findings: this.items.length,
        mismatches: mismatchCount,
        needsOwnerVerification: unknownCount
      },
      inputs: { quickstartPath: this.quickstartPath, openapiPath: this.openapiPath },
      evidence: this.items,
      truncated: this.truncated,
      boundary: "Static comparison only. No request, command, code block, repository script, or external reference was executed. This is not a correctness, security, compliance, or performance certification."
    };
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) throw new Error("Bounded result exceeded its safety limit");
    return result;
  }
}

module.exports = { EvidenceLedger, clean, redactSecrets };
