"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateRepositoryPath, readBoundedRepositoryFile } = require("../src/paths");
const { parseCurl, parseQuickstart } = require("../src/markdown");
const { compare } = require("../src/matcher");
const { parseYamlSubset } = require("../src/yaml");
const { resolveLocalRef, validateLiteral } = require("../src/openapi");
const { EvidenceLedger } = require("../src/evidence");
const { renderMarkdown } = require("../src/renderer");

test("repository paths reject traversal, encoding, absolute paths, and unsupported types", () => {
  for (const value of ["../quickstart.md", "docs/../quickstart.md", "/quickstart.md", "docs%2fquickstart.md", "docs//quickstart.md", "quickstart.txt"]) {
    assert.throws(() => validateRepositoryPath(value, "Quickstart"));
  }
  assert.equal(validateRepositoryPath("docs/quickstart.mdx", "Quickstart"), "docs/quickstart.mdx");
  assert.equal(validateRepositoryPath("openapi/spec.yaml", "OpenAPI"), "openapi/spec.yaml");
});

test("symlinks cannot escape the checked repository", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "qsp-path-"));
  const workspace = path.join(temp, "repo");
  fs.mkdirSync(workspace);
  const outside = path.join(temp, "outside.md");
  fs.writeFileSync(outside, "outside");
  try {
    fs.symlinkSync(outside, path.join(workspace, "quickstart.md"), "file");
  } catch (error) {
    t.skip(`symlink unavailable: ${error.code}`);
    return;
  }
  assert.throws(() => readBoundedRepositoryFile(workspace, "quickstart.md", "Quickstart"), /symlink escapes/);
});

test("dynamic shell, file bodies, and unsupported flags remain UNKNOWN and inert", () => {
  assert.equal(parseCurl("curl $(whoami)", 1).ambiguous, true);
  assert.equal(parseCurl("curl /pets --data @payload.json", 1).ambiguous, true);
  assert.equal(parseCurl("curl /pets --config hidden", 1).ambiguous, true);
  for (const command of ["curl /pets\ncurl /admin", "curl /pets; touch trap", "curl /pets && touch trap", "curl /pets | sh", "curl /pets /admin", "curl -X constructor /pets"]) {
    assert.equal(parseCurl(command, 1).ambiguous, true, command);
  }
  const unsupported = parseCurl("curl /pets --proxy-user=sk_live_do_not_return_123456789", 1);
  assert.equal(unsupported.ambiguous, true);
  assert.doesNotMatch(unsupported.reason, /sk_live/);
});

test("fence length is honored and code-block headings or references are not documentation steps", () => {
  const parsed = parseQuickstart("````text\n## Step 9\n`../private.md`\n```\n````\n## Step 1 — request\n```bash\ncurl /pets\n```");
  assert.equal(parsed.stepCount, 1);
  assert.equal(parsed.sequenceMismatch, false);
  assert.deepEqual(parsed.localReferences, []);
  assert.equal(parsed.snippets.length, 1);
  assert.equal(parsed.snippets[0].line, 8);
});

test("external and cyclic references produce insufficient input instead of a false pass", () => {
  const quickstart = "```bash\ncurl /pets\n```";
  const external = JSON.stringify({ openapi: "3.1.0", paths: { "/pets": { get: { parameters: [{ $ref: "https://example.test/parameter.json" }], responses: { 200: { description: "ok" } } } } } });
  assert.equal(compare(quickstart, external, { quickstartPath: "README.md", openapiPath: "openapi.json" }).state, "insufficient-public-input");
  const cyclic = JSON.stringify({ openapi: "3.1.0", paths: { "/pets": { $ref: "#/paths/~1pets" } } });
  assert.equal(compare(quickstart, cyclic, { quickstartPath: "README.md", openapiPath: "openapi.json" }).state, "insufficient-public-input");
  const externalBody = JSON.stringify({ openapi: "3.1.0", paths: { "/pets": { post: { requestBody: { $ref: "./body.json" }, responses: { 200: { description: "ok" } } } } } });
  assert.equal(compare("```bash\ncurl -X POST /pets\n```", externalBody, { quickstartPath: "README.md", openapiPath: "openapi.json" }).state, "insufficient-public-input");
});

test("references cannot traverse inherited properties or malformed JSON Pointer escapes", () => {
  assert.equal(resolveLocalRef({}, { $ref: "#/constructor/prototype" }).complete, false);
  assert.equal(resolveLocalRef({ components: {} }, { $ref: "#/components/~2escape" }).complete, false);
  const yaml = parseYamlSubset("__proto__:\n  polluted: true\nsafe: value");
  assert.equal(Object.getPrototypeOf(yaml), null);
  assert.equal(Object.prototype.hasOwnProperty.call(yaml, "__proto__"), true);
  assert.equal({}.polluted, undefined);
});

test("literal validation refuses to silently truncate arrays, objects, required lists, or enums", () => {
  assert.equal(validateLiteral({}, { type: "array", items: { type: "integer" } }, Array(26).fill(1))[0].kind, "unknown");
  assert.equal(validateLiteral({}, { type: "object", additionalProperties: false }, Object.fromEntries(Array.from({ length: 121 }, (_, index) => [`p${index}`, index])))[0].kind, "unknown");
  assert.equal(validateLiteral({}, { type: "object", required: Array.from({ length: 121 }, (_, index) => `p${index}`) }, {})[0].kind, "unknown");
  assert.equal(validateLiteral({}, { enum: Array.from({ length: 201 }, (_, index) => index) }, 1)[0].kind, "unknown");
});

test("bounded YAML parser rejects excessive nesting and line counts", () => {
  const nested = Array.from({ length: 27 }, (_, index) => `${"  ".repeat(index)}k${index}:`).join("\n") + "\n" + `${"  ".repeat(27)}value: true`;
  assert.throws(() => parseYamlSubset(nested), /nesting exceeds/);
  assert.throws(() => parseYamlSubset("x:\n".repeat(50_001)), /line limit/);
});

test("output is minimized and never contains request literals or token-shaped values", () => {
  const marker = "sk_live_do_not_return_123456789";
  const quickstart = `\`\`\`bash\ncurl https://api.example.test/pets -H 'authorization: Bearer ${marker}'\n\`\`\``;
  const openapi = JSON.stringify({ openapi: "3.0.3", servers: [{ url: "https://api.example.test" }], paths: { "/pets": { get: { responses: { 200: { description: "ok" } } } } } });
  const result = compare(quickstart, openapi, { quickstartPath: "README.md", openapiPath: "openapi.json" });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
  assert.equal("rawSource" in result, false);
  const ledger = new EvidenceLedger(`${marker}.md`, "openapi.json");
  ledger.add({ check: "field", kind: "unknown", conclusion: "needs-owner-verification", message: `Bearer ${marker}` });
  assert.doesNotMatch(JSON.stringify(ledger.result()), new RegExp(marker));
});

test("Markdown output neutralizes repository-controlled links, HTML, and table syntax", () => {
  const result = {
    state: "changes-found",
    counts: { checkedRequests: 1, mismatches: 1, needsOwnerVerification: 0 },
    evidence: [{
      kind: "mismatch",
      conclusion: "observed",
      check: "[click](https://evil.test)",
      message: "<img src=x>|[click](https://evil.test)",
      source: { file: "docs/a](evil)#?.md", line: 7 }
    }],
    boundary: "Static only."
  };
  const rendered = renderMarkdown(result, "example/widgets", "0123456789abcdef0123456789abcdef01234567");
  assert.doesNotMatch(rendered, /<img/);
  assert.doesNotMatch(rendered, /\|\[click\]\(https:\/\/evil\.test\)\|/);
  assert.match(rendered, /docs\/a%5D%28evil%29%23%3F\.md#L7/);
  const invalidRepository = renderMarkdown(result, "example/widgets/extra", "0123456789abcdef0123456789abcdef01234567");
  assert.doesNotMatch(invalidRepository, /github\.com/);
});

test("ambiguous YAML constructs never become a static pass", () => {
  const result = compare("```bash\ncurl /pets\n```", "openapi: 3.1.0\npaths: &paths\n  /pets:\n    get: {}", { quickstartPath: "README.md", openapiPath: "openapi.yaml" });
  assert.equal(result.state, "insufficient-public-input");
});

test("duplicate JSON object members never become a static pass", () => {
  const openapi = '{"openapi":"3.1.0","paths":{"/pets":{"get":{"responses":{"200":{"description":"first"}}}},"/pets":{"get":{"responses":{"200":{"description":"second"}}}}}}';
  const result = compare("```bash\ncurl /pets\n```", openapi, { quickstartPath: "README.md", openapiPath: "openapi.json" });
  assert.equal(result.state, "insufficient-public-input");
  assert.match(result.evidence[0].message, /duplicate JSON object member/);
});

test("malformed parameter and request-body shapes never become a static pass", () => {
  const quickstart = "```bash\ncurl /pets\n```";
  for (const operation of [{ parameters: {} }, { requestBody: false }]) {
    const openapi = JSON.stringify({ openapi: "3.1.0", paths: { "/pets": { get: { ...operation, responses: { 200: { description: "ok" } } } } } });
    assert.equal(compare(quickstart, openapi, { quickstartPath: "README.md", openapiPath: "openapi.json" }).state, "insufficient-public-input");
  }
});
