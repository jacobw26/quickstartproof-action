"use strict";

const { EvidenceLedger } = require("./evidence");
const { parseQuickstart } = require("./markdown");
const {
  parseOpenApi,
  operationFor,
  literalServers,
  requestSchema,
  responseSchema,
  validateLiteral
} = require("./openapi");

function parameterSets(parameters) {
  const result = { path: [], query: [], header: [] };
  for (const parameter of parameters) {
    const location = parameter?.in;
    if (!Object.prototype.hasOwnProperty.call(result, location) || typeof parameter?.name !== "string") continue;
    result[location].push({ name: parameter.name, required: Boolean(parameter.required) });
  }
  return result;
}

function serverMatchesRequest(server, snippet) {
  let parsed;
  try { parsed = new URL(server, snippet.origin || "https://quickstartproof.invalid"); } catch { return null; }
  if (snippet.absolute && parsed.origin !== snippet.origin) return false;
  const base = parsed.pathname.replace(/\/$/, "");
  return !base || base === "/" || snippet.pathname === base || snippet.pathname.startsWith(`${base}/`);
}

function operationPathForRequest(document, snippet) {
  const candidates = [snippet.pathname];
  const rootServers = Array.isArray(document.servers) ? document.servers : [];
  for (const item of rootServers) {
    if (typeof item?.url !== "string" || /\{[^{}]+\}/.test(item.url)) continue;
    let parsed;
    try { parsed = new URL(item.url, snippet.origin || "https://quickstartproof.invalid"); } catch { continue; }
    if (snippet.absolute && parsed.origin !== snippet.origin) continue;
    const base = parsed.pathname.replace(/\/$/, "");
    if (base && base !== "/" && (snippet.pathname === base || snippet.pathname.startsWith(`${base}/`))) {
      candidates.push(snippet.pathname.slice(base.length) || "/");
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    const result = operationFor(document, candidate, snippet.method);
    if (result.found || result.reason === "method-not-found" || result.ambiguous) return { ...result, comparedPath: candidate };
  }
  return { ...operationFor(document, snippet.pathname, snippet.method), comparedPath: snippet.pathname };
}

function compare(quickstartText, openapiText, options) {
  const ledger = new EvidenceLedger(options.quickstartPath, options.openapiPath);
  const quickstart = parseQuickstart(quickstartText);
  const parsedApi = parseOpenApi(openapiText, options.openapiPath);
  if (!parsedApi.ok) {
    ledger.add({ check: "openapi-parse", kind: "unknown", conclusion: "needs-owner-verification", message: parsedApi.reason });
    return ledger.result({ checkedRequests: 0 });
  }
  const document = parsedApi.document;
  ledger.add({ check: "openapi-version", kind: "match", conclusion: "observed", message: `OpenAPI ${parsedApi.version} is inside the supported 3.0–3.2 boundary.` });

  if (quickstart.stepOverflow) {
    ledger.add({ check: "step-boundary", kind: "unknown", conclusion: "needs-owner-verification", message: "The quickstart exceeds the 10-step MVP limit." });
  }
  if (quickstart.sequenceMismatch) {
    ledger.add({ check: "step-order", kind: "mismatch", conclusion: "observed", message: "Numbered step headings are not sequential from Step 1.", line: quickstart.sequenceLine });
  } else if (quickstart.stepCount > 0) {
    ledger.add({ check: "step-order", kind: "match", conclusion: "observed", message: `${quickstart.stepCount} numbered step heading(s) appear in sequence.` });
  }
  if (quickstart.snippetOverflow) {
    ledger.add({ check: "request-boundary", kind: "unknown", conclusion: "needs-owner-verification", message: "The quickstart exceeds the three-request MVP limit." });
  }
  if (quickstart.snippets.length === 0) {
    ledger.add({ check: "curl-discovery", kind: "unknown", conclusion: "needs-owner-verification", message: "No supported cURL fence was found." });
    return ledger.result({ checkedRequests: 0 });
  }

  const operationResults = [];
  for (const snippet of quickstart.snippets.slice(0, 3)) {
    if (snippet.ambiguous) {
      ledger.add({ check: "curl-parse", kind: "unknown", conclusion: "needs-owner-verification", message: snippet.reason || "The cURL request contains unsupported syntax.", line: snippet.line });
      operationResults.push(null);
      continue;
    }
    const found = operationPathForRequest(document, snippet);
    if (!found.found) {
      ledger.add({
        check: found.reason === "method-not-found" ? "method" : "path",
        kind: found.ambiguous ? "unknown" : "mismatch",
        conclusion: found.ambiguous ? "needs-owner-verification" : "observed",
        message: found.reason === "method-not-found"
          ? `${snippet.method} is not described for ${found.template}.`
          : found.reason === "path-not-found"
            ? `${snippet.pathname} does not match an OpenAPI path.`
            : found.reason,
        line: snippet.line
      });
      operationResults.push(null);
      continue;
    }
    operationResults.push(found);
    ledger.add({ check: "method-path", kind: "match", conclusion: "observed", message: `${snippet.method} ${snippet.pathname} matches ${found.template}.`, line: snippet.line });

    const servers = literalServers(document, found);
    if (servers.ambiguous) {
      ledger.add({ check: "server", kind: "unknown", conclusion: "needs-owner-verification", message: "Templated or non-list server configuration cannot be compared statically.", line: snippet.line });
    } else if (servers.values.length > 0) {
      const comparisons = servers.values.map((server) => serverMatchesRequest(server, snippet));
      if (comparisons.includes(true)) ledger.add({ check: "server", kind: "match", conclusion: "observed", message: "The documented request is consistent with a literal OpenAPI server URL.", line: snippet.line });
      else if (comparisons.every((value) => value === false)) ledger.add({ check: "server", kind: "mismatch", conclusion: "observed", message: "The request base URL does not match a literal OpenAPI server URL.", line: snippet.line });
      else ledger.add({ check: "server", kind: "unknown", conclusion: "needs-owner-verification", message: "The OpenAPI server URL could not be compared safely.", line: snippet.line });
    } else if (snippet.absolute) {
      ledger.add({ check: "server", kind: "unknown", conclusion: "needs-owner-verification", message: "The cURL example has an absolute host, but OpenAPI has no literal server URL.", line: snippet.line });
    }

    const params = parameterSets(found.parameters);
    const actualQuery = new Set(snippet.queryNames);
    const actualHeaders = new Set(Object.keys(snippet.headers));
    const templateNames = new Set([...found.template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]));
    for (const parameter of params.path.filter((item) => item.required)) {
      if (!templateNames.has(parameter.name)) ledger.add({ check: "path-parameter", kind: "mismatch", conclusion: "observed", message: `Required path parameter ${parameter.name} is absent from the path template.`, line: snippet.line });
    }
    for (const parameter of params.query.filter((item) => item.required)) {
      if (!actualQuery.has(parameter.name)) ledger.add({ check: "query-parameter", kind: "mismatch", conclusion: "observed", message: `Required query parameter ${parameter.name} is missing.`, line: snippet.line });
    }
    for (const parameter of params.header.filter((item) => item.required)) {
      if (!actualHeaders.has(parameter.name.toLowerCase())) ledger.add({ check: "header-parameter", kind: "mismatch", conclusion: "observed", message: `Required header ${parameter.name} is missing.`, line: snippet.line });
    }
    const definedQuery = new Set(params.query.map((item) => item.name));
    for (const name of actualQuery) {
      if (!definedQuery.has(name)) ledger.add({ check: "query-parameter", kind: "mismatch", conclusion: "observed", message: `Query parameter ${name} is not described for this operation.`, line: snippet.line });
    }
    const definedHeaders = new Set(params.header.map((item) => item.name.toLowerCase()));
    for (const name of actualHeaders) {
      if (!["accept", "content-type", "authorization", "user-agent"].includes(name) && !definedHeaders.has(name)) {
        ledger.add({ check: "header-parameter", kind: "mismatch", conclusion: "observed", message: `Header ${name} is not described for this operation.`, line: snippet.line });
      }
    }

    const body = requestSchema(document, found.operation);
    if (!body.complete) {
      ledger.add({ check: "request-body", kind: "unknown", conclusion: "needs-owner-verification", message: body.reason, line: snippet.line });
    } else if (body.required && !snippet.dataPresent) {
      ledger.add({ check: "request-body", kind: "mismatch", conclusion: "observed", message: "A required JSON request body is missing.", line: snippet.line });
    } else if (snippet.dataPresent && snippet.bodyError) {
      ledger.add({ check: "request-body", kind: "unknown", conclusion: "needs-owner-verification", message: snippet.bodyError, line: snippet.line });
    } else if (snippet.dataPresent && body.schema == null) {
      ledger.add({ check: "request-body", kind: "mismatch", conclusion: "observed", message: "The cURL example sends JSON, but this operation does not describe a JSON request body.", line: snippet.line });
    } else if (snippet.dataPresent && body.schema != null) {
      const issues = validateLiteral(document, body.schema, snippet.jsonBody);
      if (issues.length === 0) ledger.add({ check: "request-body", kind: "match", conclusion: "inferred", message: "The literal JSON request fits the bounded schema checks.", line: snippet.line });
      for (const issue of issues.slice(0, 8)) ledger.add({ check: "request-body", kind: issue.kind, conclusion: issue.kind === "unknown" ? "needs-owner-verification" : "observed", message: `${issue.location}: ${issue.message}`, line: snippet.line });
    }
  }

  for (let index = 0; index < quickstart.jsonExamples.length; index += 1) {
    const example = quickstart.jsonExamples[index];
    const operation = operationResults[index];
    if (example.error) {
      ledger.add({ check: "response-example", kind: "unknown", conclusion: "needs-owner-verification", message: example.error, line: example.line });
    } else if (!example.status || !operation) {
      ledger.add({ check: "response-example", kind: "unknown", conclusion: "needs-owner-verification", message: "A literal JSON example needs an explicit response status and a matched request.", line: example.line });
    } else {
      const response = responseSchema(document, operation.operation, example.status);
      if (!response.complete) ledger.add({ check: "response-example", kind: "unknown", conclusion: "needs-owner-verification", message: response.reason, line: example.line });
      else {
        const issues = validateLiteral(document, response.schema, example.value);
        if (issues.length === 0) ledger.add({ check: "response-example", kind: "match", conclusion: "inferred", message: `The literal JSON example fits the bounded ${example.status} response schema checks.`, line: example.line });
        for (const issue of issues.slice(0, 8)) ledger.add({ check: "response-example", kind: issue.kind, conclusion: issue.kind === "unknown" ? "needs-owner-verification" : "observed", message: `${issue.location}: ${issue.message}`, line: example.line });
      }
    }
  }

  for (const reference of quickstart.localReferences) {
    if (![options.quickstartPath, options.openapiPath, `./${options.quickstartPath}`, `./${options.openapiPath}`].includes(reference)) {
      ledger.add({ check: "local-reference", kind: "unknown", conclusion: "needs-owner-verification", message: `Referenced local file ${reference} was not read; exactly two configured inputs are allowed.` });
    }
  }
  return ledger.result({ checkedRequests: Math.min(quickstart.snippets.length, 3) });
}

module.exports = { compare, parameterSets, serverMatchesRequest };
