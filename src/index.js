"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { checkRepository } = require("./core");
const { warningAnnotation, errorAnnotation } = require("./commands");
const { clean } = require("./evidence");

function input(name, fallback = "") {
  const envName = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  return process.env[envName] || fallback;
}

function appendCommandFile(filePath, content) {
  if (!filePath) return;
  fs.appendFileSync(filePath, `${content}\n`, { encoding: "utf8" });
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  let marker;
  do marker = `qsp_${crypto.randomUUID().replace(/-/g, "")}`;
  while (String(value).split(/\r?\n/).includes(marker));
  appendCommandFile(outputFile, `${name}<<${marker}\n${value}\n${marker}`);
}

function booleanInput(name, fallback) {
  const value = input(name, fallback).trim().toLowerCase();
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

function run() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const failOnChanges = booleanInput("fail-on-changes", "false");
  const discoverPaths = booleanInput("discover-paths", "false");
  const checked = checkRepository({
    workspace,
    quickstartPath: input("quickstart-path"),
    openapiPath: input("openapi-path"),
    discoverPaths,
    repository: process.env.GITHUB_REPOSITORY || "",
    sha: process.env.GITHUB_SHA || ""
  });
  const serialized = JSON.stringify(checked.result);
  const runnerTemp = process.env.RUNNER_TEMP || path.join(os.tmpdir(), "quickstartproof");
  if (!fs.existsSync(runnerTemp) && !process.env.RUNNER_TEMP) fs.mkdirSync(runnerTemp, { recursive: true });
  const realRunnerTemp = fs.realpathSync(runnerTemp);
  if (!fs.statSync(realRunnerTemp).isDirectory()) throw new Error("RUNNER_TEMP must identify an existing directory");
  const resultDirectory = fs.mkdtempSync(path.join(realRunnerTemp, "quickstartproof-"));
  const resultFile = path.join(resultDirectory, "result.json");
  fs.writeFileSync(resultFile, `${JSON.stringify(checked.result, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  appendCommandFile(process.env.GITHUB_STEP_SUMMARY, checked.markdown);
  for (const item of checked.result.evidence) {
    const annotation = warningAnnotation(item);
    if (annotation) process.stdout.write(`${annotation}\n`);
  }
  setOutput("state", checked.result.state);
  setOutput("result-json", serialized);
  setOutput("result-file", resultFile);
  process.stdout.write(`QuickstartProof: ${checked.result.state}; ${checked.result.counts.mismatches} change(s), ${checked.result.counts.needsOwnerVerification} unknown(s).\n`);
  if (failOnChanges && checked.result.state === "changes-found") process.exitCode = 1;
}

try { run(); } catch (error) {
  const message = clean(error?.message || "QuickstartProof could not complete", 300);
  process.stderr.write(`${errorAnnotation(message)}\n`);
  process.exitCode = 1;
}
