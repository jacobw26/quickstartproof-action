"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const limits = require("../src/limits");
const {
  validateRepositoryPath,
  readBoundedRepositoryFile,
  discoverRepositoryPaths,
  resolveRepositoryInputs
} = require("../src/paths");
const { checkRepository } = require("../src/core");
const { warningAnnotation, errorAnnotation } = require("../src/commands");
const { parseCurl, parseQuickstart } = require("../src/markdown");
const { compare } = require("../src/matcher");
const { parseYamlSubset } = require("../src/yaml");
const { resolveLocalRef, validateLiteral } = require("../src/openapi");
const { EvidenceLedger } = require("../src/evidence");
const { renderMarkdown } = require("../src/renderer");

function temporaryRepository(t, prefix = "qsp-discovery-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeAlignedPair(root, quickstartPath, openapiPath) {
  fs.mkdirSync(path.dirname(path.join(root, quickstartPath)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, openapiPath)), { recursive: true });
  fs.writeFileSync(path.join(root, quickstartPath), "```bash\ncurl https://api.example.test/pets\n```\n");
  fs.writeFileSync(path.join(root, openapiPath), JSON.stringify({
    openapi: "3.1.0",
    servers: [{ url: "https://api.example.test" }],
    paths: { "/pets": { get: { responses: { 200: { description: "ok" } } } } }
  }));
}

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

test("path discovery is opt-in, while explicit paths retain precedence and behavior", (t) => {
  const root = temporaryRepository(t);
  writeAlignedPair(root, "docs/custom-guide.md", "api/spec.json");
  fs.writeFileSync(path.join(root, "quickstart.md"), "ambiguous if discovery ran");
  fs.mkdirSync(path.join(root, "other"));
  fs.writeFileSync(path.join(root, "other", "quickstart.mdx"), "second candidate");
  assert.throws(
    () => resolveRepositoryInputs(root, "", "", false),
    /paths are required unless discover-paths is true/
  );
  const checked = checkRepository({
    workspace: root,
    quickstartPath: "docs/custom-guide.md",
    openapiPath: "api/spec.json",
    discoverPaths: true
  });
  assert.equal(checked.result.state, "aligned-on-static-checks");
  assert.deepEqual(checked.result.inputs, {
    quickstartPath: "docs/custom-guide.md",
    openapiPath: "api/spec.json"
  });
});

test("opt-in discovery selects one nested canonical quickstart and OpenAPI file", (t) => {
  const root = temporaryRepository(t);
  writeAlignedPair(root, "docs/getting-started.mdx", "api/openapi.json");
  const selected = resolveRepositoryInputs(root, "", "", true);
  assert.deepEqual(selected, {
    quickstartPath: "docs/getting-started.mdx",
    openapiPath: "api/openapi.json",
    quickstartDiscovered: true,
    openapiDiscovered: true
  });
  assert.equal(checkRepository({ workspace: root, quickstartPath: "", openapiPath: "", discoverPaths: true }).result.state, "aligned-on-static-checks");
});

test("discovery accepts only the documented canonical quickstart names", (t) => {
  for (const fileName of ["quickstart.md", "quickstart.mdx", "getting-started.md", "getting-started.mdx"]) {
    const root = temporaryRepository(t, "qsp-canonical-");
    fs.writeFileSync(path.join(root, fileName), "content");
    assert.deepEqual(discoverRepositoryPaths(root, ["Quickstart"]), { Quickstart: fileName });
  }
  for (const fileName of ["getting_started.md", "gettingstarted.mdx"]) {
    const root = temporaryRepository(t, "qsp-noncanonical-");
    fs.writeFileSync(path.join(root, fileName), "content");
    assert.throws(() => discoverRepositoryPaths(root, ["Quickstart"]), /no canonical candidate/);
  }
});

test("discovered paths preserve repeated whitespace in results and warning sources", (t) => {
  const root = temporaryRepository(t, "qsp-spaced-path-");
  writeAlignedPair(root, "docs  v1/quickstart.md", "openapi.json");
  fs.writeFileSync(path.join(root, "docs  v1", "quickstart.md"), "```bash\ncurl https://api.example.test/missing\n```\n");
  const result = checkRepository({ workspace: root, quickstartPath: "", openapiPath: "", discoverPaths: true }).result;
  assert.equal(result.inputs.quickstartPath, "docs  v1/quickstart.md");
  const mismatch = result.evidence.find((item) => item.kind === "mismatch");
  assert.equal(mismatch.source.file, "docs  v1/quickstart.md");
  assert.match(warningAnnotation(mismatch), /^::warning file=docs  v1\/quickstart\.md,/);
});

test("legitimate path components beginning with two dots remain inside the repository", (t) => {
  const root = temporaryRepository(t, "qsp-dotdot-name-");
  writeAlignedPair(root, "..docs/quickstart.md", "openapi.json");
  assert.equal(checkRepository({
    workspace: root,
    quickstartPath: "..docs/quickstart.md",
    openapiPath: "openapi.json",
    discoverPaths: false
  }).result.state, "aligned-on-static-checks");
  assert.equal(checkRepository({
    workspace: root,
    quickstartPath: "",
    openapiPath: "",
    discoverPaths: true
  }).result.state, "aligned-on-static-checks");
});

test("partial discovery searches only for the omitted input", (t) => {
  const root = temporaryRepository(t, "qsp-partial-");
  writeAlignedPair(root, "docs/custom.md", "api/openapi.json");
  fs.writeFileSync(path.join(root, "quickstart.md"), "unused canonical candidate");
  fs.writeFileSync(path.join(root, "docs", "getting-started.mdx"), "second unused canonical candidate");
  const selected = resolveRepositoryInputs(root, "docs/custom.md", "", true);
  assert.deepEqual(selected, {
    quickstartPath: "docs/custom.md",
    openapiPath: "api/openapi.json",
    quickstartDiscovered: false,
    openapiDiscovered: true
  });
  assert.equal(checkRepository({ workspace: root, quickstartPath: "docs/custom.md", openapiPath: "", discoverPaths: true }).result.state, "aligned-on-static-checks");
});

test("discovery fails closed on missing, ambiguous, symlinked, oversized, or over-budget candidates", (t) => {
  const missing = temporaryRepository(t, "qsp-missing-");
  assert.throws(() => discoverRepositoryPaths(missing, ["Quickstart"]), /no canonical candidate/);

  const ambiguous = temporaryRepository(t, "qsp-ambiguous-");
  fs.mkdirSync(path.join(ambiguous, "docs"));
  fs.writeFileSync(path.join(ambiguous, "quickstart.md"), "one");
  fs.writeFileSync(path.join(ambiguous, "docs", "getting-started.md"), "two");
  assert.throws(() => discoverRepositoryPaths(ambiguous, ["Quickstart"]), /multiple candidates/);

  const linked = temporaryRepository(t, "qsp-linked-");
  const target = path.join(linked, "guide.md");
  fs.writeFileSync(target, "target");
  try {
    fs.symlinkSync(target, path.join(linked, "quickstart.md"), "file");
    assert.throws(() => discoverRepositoryPaths(linked, ["Quickstart"]), /refuses a symlink candidate/);
  } catch (error) {
    if (!["EACCES", "EPERM", "UNKNOWN"].includes(error.code)) throw error;
  }

  const linkedDirectory = temporaryRepository(t, "qsp-linked-directory-");
  const outsideDirectory = temporaryRepository(t, "qsp-outside-directory-");
  fs.writeFileSync(path.join(outsideDirectory, "quickstart.md"), "outside");
  try {
    fs.symlinkSync(outsideDirectory, path.join(linkedDirectory, "docs"), "junction");
    assert.throws(() => discoverRepositoryPaths(linkedDirectory, ["Quickstart"]), /no canonical candidate/);
  } catch (error) {
    if (!["EACCES", "EPERM", "UNKNOWN"].includes(error.code)) throw error;
  }

  const oversized = temporaryRepository(t, "qsp-oversized-");
  fs.writeFileSync(path.join(oversized, "quickstart.md"), Buffer.alloc(limits.MAX_QUICKSTART_BYTES + 1));
  assert.throws(() => discoverRepositoryPaths(oversized, ["Quickstart"]), /exceeds the bounded size limit/);

  const files = temporaryRepository(t, "qsp-files-");
  fs.writeFileSync(path.join(files, "a.txt"), "a");
  fs.writeFileSync(path.join(files, "b.txt"), "b");
  assert.throws(() => discoverRepositoryPaths(files, ["Quickstart"], { maxFiles: 1 }), /1-file limit/);

  const entries = temporaryRepository(t, "qsp-entries-");
  fs.mkdirSync(path.join(entries, "a"));
  fs.mkdirSync(path.join(entries, "b"));
  assert.throws(() => discoverRepositoryPaths(entries, ["Quickstart"], { maxEntries: 1 }), /1-entry traversal limit/);

  const deep = temporaryRepository(t, "qsp-depth-");
  fs.mkdirSync(path.join(deep, "one", "two"), { recursive: true });
  assert.throws(() => discoverRepositoryPaths(deep, ["Quickstart"], { maxDepth: 1 }), /1-directory depth limit/);
});

test("the entry limit stops incremental directory enumeration before the remainder is read", (t) => {
  const root = temporaryRepository(t, "qsp-stream-bound-");
  for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(root, name), name);
  const originalOpen = fs.opendirSync;
  let reads = 0;
  let closes = 0;
  fs.opendirSync = (...args) => {
    const handle = originalOpen(...args);
    return {
      readSync() {
        reads += 1;
        return handle.readSync();
      },
      closeSync() {
        closes += 1;
        return handle.closeSync();
      }
    };
  };
  try {
    assert.throws(() => discoverRepositoryPaths(root, ["Quickstart"], { maxEntries: 1 }), /1-entry traversal limit/);
  } finally {
    fs.opendirSync = originalOpen;
  }
  assert.equal(reads, 2, "the iterator must stop as soon as the second entry exceeds the one-entry cap");
  assert.equal(closes, 1, "the bounded directory handle must close on failure");
});

test("workflow annotations are limited to high-confidence located mismatches and strictly escaped", () => {
  const annotation = warningAnnotation({
    kind: "mismatch",
    conclusion: "observed",
    check: "method,: %\r\n",
    message: "first%\r\n::error second",
    source: { file: "docs/a,b:c%.md", line: 7 }
  });
  assert.equal(
    annotation,
    "::warning file=docs/a%2Cb%3Ac%25.md,line=7,title=QuickstartProof%3A method%2C%3A %25%0D%0A::first%25%0D%0A::error second"
  );
  assert.equal(warningAnnotation({ kind: "unknown", conclusion: "needs-owner-verification", source: { file: "a.md", line: 1 } }), null);
  assert.equal(warningAnnotation({ kind: "mismatch", conclusion: "observed", source: { file: "a.md", line: null } }), null);
  assert.equal(errorAnnotation("bad%\r\nvalue"), "::error title=QuickstartProof%3A configuration::bad%25%0D%0Avalue");
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
