"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const entry = path.resolve(__dirname, "..", "src", "index.js");

function baseFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qsp-runner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const runnerTemp = path.join(root, "runner-temp");
  fs.mkdirSync(repository);
  fs.mkdirSync(runnerTemp);
  fs.writeFileSync(path.join(repository, "quickstart.md"), "```bash\ncurl https://api.example.test/pets -H 'authorization: Bearer sk_live_do_not_return_123456789'\n```\n");
  fs.writeFileSync(path.join(repository, "openapi.json"), JSON.stringify({
    openapi: "3.1.0",
    servers: [{ url: "https://api.example.test" }],
    paths: { "/pets": { get: { responses: { 200: { description: "ok" } } } } }
  }));
  return { root, repository, runnerTemp };
}

test("runner writes only command files and a unique bounded result under RUNNER_TEMP", (t) => {
  const fixture = baseFixture(t);
  const output = path.join(fixture.root, "output.txt");
  const summary = path.join(fixture.root, "summary.md");
  fs.writeFileSync(output, "");
  fs.writeFileSync(summary, "");
  const before = fs.readdirSync(fixture.repository).sort();
  const execution = spawnSync(process.execPath, [entry], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: fixture.repository,
      RUNNER_TEMP: fixture.runnerTemp,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_REPOSITORY: "example/widgets",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      "INPUT_QUICKSTART-PATH": "quickstart.md",
      "INPUT_OPENAPI-PATH": "openapi.json",
      "INPUT_FAIL-ON-CHANGES": "false"
    }
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(fs.readdirSync(fixture.repository).sort(), before);
  const commandOutput = fs.readFileSync(output, "utf8");
  const resultFile = commandOutput.match(/result-file<<([^\r\n]+)\r?\n([^\r\n]+)\r?\n\1/)?.[2];
  assert.ok(resultFile, commandOutput);
  assert.equal(path.relative(fs.realpathSync(fixture.runnerTemp), fs.realpathSync(resultFile)).startsWith(".."), false);
  assert.match(path.basename(path.dirname(resultFile)), /^quickstartproof-/);
  assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).state, "aligned-on-static-checks");
  for (const value of [execution.stdout, execution.stderr, commandOutput, fs.readFileSync(summary, "utf8"), fs.readFileSync(resultFile, "utf8")]) {
    assert.doesNotMatch(value, /sk_live_do_not_return/);
  }
});

test("runner rejects ambiguous boolean configuration before reading inputs or writing a result", (t) => {
  const fixture = baseFixture(t);
  const execution = spawnSync(process.execPath, [entry], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: fixture.repository,
      RUNNER_TEMP: fixture.runnerTemp,
      "INPUT_QUICKSTART-PATH": "quickstart.md",
      "INPUT_OPENAPI-PATH": "openapi.json",
      "INPUT_FAIL-ON-CHANGES": "yes"
    }
  });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /fail-on-changes must be true or false/);
  assert.deepEqual(fs.readdirSync(fixture.runnerTemp), []);
});

test("runner discovers omitted canonical paths only after explicit opt-in", (t) => {
  const fixture = baseFixture(t);
  const output = path.join(fixture.root, "output.txt");
  fs.writeFileSync(output, "");
  const execution = spawnSync(process.execPath, [entry], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: fixture.repository,
      RUNNER_TEMP: fixture.runnerTemp,
      GITHUB_OUTPUT: output,
      "INPUT_QUICKSTART-PATH": "",
      "INPUT_OPENAPI-PATH": "",
      "INPUT_DISCOVER-PATHS": "true",
      "INPUT_FAIL-ON-CHANGES": "false"
    }
  });
  assert.equal(execution.status, 0, execution.stderr);
  const commandOutput = fs.readFileSync(output, "utf8");
  const resultFile = commandOutput.match(/result-file<<([^\r\n]+)\r?\n([^\r\n]+)\r?\n\1/)?.[2];
  assert.ok(resultFile, commandOutput);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, "utf8")).inputs, {
    quickstartPath: "quickstart.md",
    openapiPath: "openapi.json"
  });
});

test("runner fails closed when a path is omitted without discovery opt-in", (t) => {
  const fixture = baseFixture(t);
  const execution = spawnSync(process.execPath, [entry], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: fixture.repository,
      RUNNER_TEMP: fixture.runnerTemp,
      "INPUT_QUICKSTART-PATH": "",
      "INPUT_OPENAPI-PATH": "openapi.json",
      "INPUT_DISCOVER-PATHS": "false",
      "INPUT_FAIL-ON-CHANGES": "false"
    }
  });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /Quickstart path is required unless discover-paths is true/);
  assert.deepEqual(fs.readdirSync(fixture.runnerTemp), []);
});

test("runner emits a native warning only for a located high-confidence mismatch", (t) => {
  const fixture = baseFixture(t);
  fs.writeFileSync(path.join(fixture.repository, "openapi.json"), JSON.stringify({
    openapi: "3.1.0",
    paths: { "/widgets": { get: { responses: { 200: { description: "ok" } } } } }
  }));
  const execution = spawnSync(process.execPath, [entry], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: fixture.repository,
      RUNNER_TEMP: fixture.runnerTemp,
      "INPUT_QUICKSTART-PATH": "quickstart.md",
      "INPUT_OPENAPI-PATH": "openapi.json",
      "INPUT_DISCOVER-PATHS": "false",
      "INPUT_FAIL-ON-CHANGES": "false"
    }
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /::warning file=quickstart\.md,line=2,title=QuickstartProof%3A path::/);
  assert.equal((execution.stdout.match(/::warning /g) || []).length, 1);
});

test("runner rejects an ambiguous discovery switch before traversal", (t) => {
  const fixture = baseFixture(t);
  const execution = spawnSync(process.execPath, [entry], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: fixture.repository,
      RUNNER_TEMP: fixture.runnerTemp,
      "INPUT_QUICKSTART-PATH": "",
      "INPUT_OPENAPI-PATH": "",
      "INPUT_DISCOVER-PATHS": "yes",
      "INPUT_FAIL-ON-CHANGES": "false"
    }
  });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /discover-paths must be true or false/);
  assert.deepEqual(fs.readdirSync(fixture.runnerTemp), []);
});
