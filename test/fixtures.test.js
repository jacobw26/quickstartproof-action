"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { compare } = require("../src/matcher");
const { renderMarkdown } = require("../src/renderer");

const fixtures = path.resolve(__dirname, "..", "fixtures");
const manifest = JSON.parse(fs.readFileSync(path.join(fixtures, "manifest.json"), "utf8"));

for (const fixture of manifest) {
  test(`${fixture.id} returns ${fixture.expected}`, () => {
    const root = path.join(fixtures, fixture.id);
    const quickstartName = fixture.quickstart || "quickstart.md";
    const openapiName = fixture.openapi || "openapi.json";
    const trap = fixture.trap ? path.join(root, fixture.trap) : null;
    if (trap && fs.existsSync(trap)) fs.unlinkSync(trap);
    const result = compare(
      fs.readFileSync(path.join(root, quickstartName), "utf8"),
      fs.readFileSync(path.join(root, openapiName), "utf8"),
      { quickstartPath: quickstartName, openapiPath: openapiName }
    );
    assert.equal(result.state, fixture.expected);
    assert.ok(result.evidence.length > 0 && result.evidence.length <= 40);
    assert.ok(result.evidence.every((item) => ["observed", "inferred", "needs-owner-verification"].includes(item.conclusion)));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 48_000);
    assert.match(result.boundary, /never.*executed|No request.*executed/i);
    if (trap) assert.equal(fs.existsSync(trap), false, "malicious fixture must remain inert");
  });
}

test("a method mismatch preserves the exact quickstart source line", () => {
  const root = path.join(fixtures, "case-02");
  const result = compare(
    fs.readFileSync(path.join(root, "quickstart.md"), "utf8"),
    fs.readFileSync(path.join(root, "openapi.json"), "utf8"),
    { quickstartPath: "quickstart.md", openapiPath: "openapi.json" }
  );
  const mismatch = result.evidence.find((item) => item.kind === "mismatch");
  assert.equal(mismatch.source.file, "quickstart.md");
  assert.equal(mismatch.source.line, 4);
});

test("Markdown summary links only to a pinned full commit SHA", () => {
  const root = path.join(fixtures, "case-02");
  const result = compare(fs.readFileSync(path.join(root, "quickstart.md"), "utf8"), fs.readFileSync(path.join(root, "openapi.json"), "utf8"), {
    quickstartPath: "quickstart.md", openapiPath: "openapi.json"
  });
  const pinned = renderMarkdown(result, "example/widgets", "0123456789abcdef0123456789abcdef01234567");
  assert.match(pinned, /github\.com\/example\/widgets\/blob\/0123456789abcdef0123456789abcdef01234567\/quickstart\.md#L4/);
  const branch = renderMarkdown(result, "example/widgets", "main");
  assert.doesNotMatch(branch, /github\.com/);
});
