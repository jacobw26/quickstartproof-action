"use strict";

const { parseYamlSubset } = require("./yaml");
const {
  MAX_REF_DEPTH,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_PROPERTIES,
  MAX_ARRAY_ITEMS,
  MAX_ENUM_VALUES
} = require("./limits");

function assertNoDuplicateJsonKeys(text) {
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(text[cursor] || "")) cursor += 1; };
  const stringValue = () => {
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") cursor += 2;
      else if (text[cursor] === "\"") { cursor += 1; return JSON.parse(text.slice(start, cursor)); }
      else cursor += 1;
    }
    throw new Error("unterminated JSON string");
  };
  const value = () => {
    whitespace();
    if (text[cursor] === "{") return object();
    if (text[cursor] === "[") return array();
    if (text[cursor] === "\"") { stringValue(); return; }
    while (cursor < text.length && !/[\s,\]}]/.test(text[cursor])) cursor += 1;
  };
  const object = () => {
    cursor += 1;
    whitespace();
    const keys = new Set();
    if (text[cursor] === "}") { cursor += 1; return; }
    while (cursor < text.length) {
      whitespace();
      const key = stringValue();
      if (keys.has(key)) throw new Error("duplicate JSON object member");
      keys.add(key);
      whitespace();
      cursor += 1;
      value();
      whitespace();
      if (text[cursor] === "}") { cursor += 1; return; }
      cursor += 1;
    }
  };
  const array = () => {
    cursor += 1;
    whitespace();
    if (text[cursor] === "]") { cursor += 1; return; }
    while (cursor < text.length) {
      value();
      whitespace();
      if (text[cursor] === "]") { cursor += 1; return; }
      cursor += 1;
    }
  };
  value();
}

function parseOpenApi(text, filePath) {
  let document;
  try {
    if (filePath.toLowerCase().endsWith(".json")) {
      document = JSON.parse(text);
      assertNoDuplicateJsonKeys(text);
    } else document = parseYamlSubset(text);
  } catch (error) {
    return { ok: false, reason: `OpenAPI could not be parsed safely: ${error.message}` };
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, reason: "OpenAPI root must be an object" };
  }
  if (!/^3\.(?:0|1|2)(?:\.|$)/.test(String(document.openapi || ""))) {
    return { ok: false, reason: "Only OpenAPI 3.0, 3.1, and 3.2 are supported" };
  }
  if (!document.paths || typeof document.paths !== "object" || Array.isArray(document.paths)) {
    return { ok: false, reason: "OpenAPI paths are missing" };
  }
  return { ok: true, document, version: String(document.openapi) };
}

function decodePointerPart(value) {
  if (/~(?:[^01]|$)/.test(value)) throw new Error("invalid JSON Pointer escape");
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalRef(document, value, seen = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, complete: true };
  if (!value.$ref) return { value, complete: true };
  if (typeof value.$ref !== "string" || !value.$ref.startsWith("#/")) {
    return { value: null, complete: false, reason: "external OpenAPI references are outside the MVP boundary" };
  }
  if (depth >= MAX_REF_DEPTH || seen.has(value.$ref)) {
    return { value: null, complete: false, reason: "the OpenAPI reference chain is cyclic or too deep" };
  }
  let target = document;
  try {
    for (const part of value.$ref.slice(2).split("/").map(decodePointerPart)) {
      if (!target || typeof target !== "object" || !Object.prototype.hasOwnProperty.call(target, part)) {
        return { value: null, complete: false, reason: `internal reference ${value.$ref} was not found` };
      }
      target = target[part];
    }
  } catch {
    return { value: null, complete: false, reason: "the internal OpenAPI reference is not a valid JSON Pointer" };
  }
  const nextSeen = new Set(seen);
  nextSeen.add(value.$ref);
  const resolved = resolveLocalRef(document, target, nextSeen, depth + 1);
  if (!resolved.complete) return resolved;
  const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
  if (typeof resolved.value === "boolean") {
    if (Object.keys(siblings).length > 0) return { value: null, complete: false, reason: "siblings of a boolean reference require owner verification" };
    return { value: resolved.value, complete: true };
  }
  if (!resolved.value || typeof resolved.value !== "object" || Array.isArray(resolved.value)) {
    return { value: null, complete: false, reason: "the internal OpenAPI reference does not resolve to an object" };
  }
  return { value: { ...resolved.value, ...siblings }, complete: true };
}

function matchingPaths(paths, actualPath) {
  const actual = actualPath.split("/").filter(Boolean);
  const candidates = [];
  for (const template of Object.keys(paths)) {
    const parts = template.split("/").filter(Boolean);
    if (parts.length !== actual.length) continue;
    let score = 0;
    let matches = true;
    for (let index = 0; index < parts.length; index += 1) {
      if (/^\{[^{}]+\}$/.test(parts[index])) score += 1;
      else if (parts[index] !== actual[index]) { matches = false; break; }
    }
    if (matches) candidates.push({ template, score });
  }
  return candidates.sort((a, b) => a.score - b.score || a.template.localeCompare(b.template));
}

function operationFor(document, pathname, method) {
  const candidates = matchingPaths(document.paths, pathname);
  if (candidates.length === 0) return { found: false, reason: "path-not-found" };
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    return { found: false, ambiguous: true, reason: "multiple OpenAPI path templates match the documented URL" };
  }
  const template = candidates[0].template;
  const pathItemResolved = resolveLocalRef(document, document.paths[template]);
  if (!pathItemResolved.complete) return { found: false, ambiguous: true, reason: pathItemResolved.reason };
  const pathItem = pathItemResolved.value;
  if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) {
    return { found: false, ambiguous: true, template, reason: "the matching OpenAPI path item is not an object" };
  }
  const operationKey = method.toLowerCase();
  const rawOperation = Object.prototype.hasOwnProperty.call(pathItem, operationKey) ? pathItem[operationKey] : null;
  if (!rawOperation) return { found: false, template, reason: "method-not-found" };
  const operationResolved = resolveLocalRef(document, rawOperation);
  if (!operationResolved.complete) return { found: false, ambiguous: true, template, reason: operationResolved.reason };
  const operation = operationResolved.value;
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    return { found: false, ambiguous: true, template, reason: "the matching OpenAPI operation is not an object" };
  }
  if ((Object.prototype.hasOwnProperty.call(pathItem, "parameters") && !Array.isArray(pathItem.parameters))
    || (Object.prototype.hasOwnProperty.call(operation, "parameters") && !Array.isArray(operation.parameters))) {
    return { found: false, ambiguous: true, template, reason: "OpenAPI parameters must be arrays" };
  }
  const parameters = [];
  for (const raw of [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
    const resolved = resolveLocalRef(document, raw);
    if (!resolved.complete) return { found: false, ambiguous: true, template, reason: resolved.reason };
    if (resolved.value && typeof resolved.value === "object") parameters.push(resolved.value);
  }
  return { found: true, template, operation, pathItem, parameters };
}

function literalServers(document, operationResult) {
  const values = operationResult.operation?.servers || operationResult.pathItem?.servers || document.servers || [];
  if (!Array.isArray(values)) return { values: [], ambiguous: true };
  const servers = values.map((item) => item?.url).filter((url) => typeof url === "string");
  if (servers.some((url) => /\{[^{}]+\}/.test(url))) return { values: servers, ambiguous: true };
  return { values: servers, ambiguous: false };
}

function requestSchema(document, operation) {
  if (!Object.prototype.hasOwnProperty.call(operation, "requestBody")) return { schema: null, required: false, complete: true };
  if (!operation.requestBody || typeof operation.requestBody !== "object" || Array.isArray(operation.requestBody)) {
    return { schema: null, required: false, complete: false, reason: "requestBody must be an object or reference" };
  }
  const body = resolveLocalRef(document, operation.requestBody);
  if (!body.complete) return { schema: null, required: Boolean(operation.requestBody.required), complete: false, reason: body.reason };
  const content = body.value?.content;
  if (!content || typeof content !== "object") return { schema: null, required: Boolean(body.value?.required), complete: false, reason: "request body media type is not described" };
  const media = Object.prototype.hasOwnProperty.call(content, "application/json")
    ? content["application/json"]
    : Object.prototype.hasOwnProperty.call(content, "application/*+json")
      ? content["application/*+json"]
      : null;
  if (!media || typeof media !== "object" || !Object.prototype.hasOwnProperty.call(media, "schema")) {
    return { schema: null, required: Boolean(body.value?.required), complete: false, reason: "literal JSON request schema is unavailable" };
  }
  const schema = resolveLocalRef(document, media.schema);
  return { schema: schema.value, required: Boolean(body.value?.required), complete: schema.complete, reason: schema.reason };
}

function responseSchema(document, operation, status) {
  const responses = operation.responses;
  if (!responses || typeof responses !== "object") return { schema: null, complete: false, reason: "responses are not described" };
  const response = Object.prototype.hasOwnProperty.call(responses, String(status))
    ? responses[String(status)]
    : Object.prototype.hasOwnProperty.call(responses, "default")
      ? responses.default
      : null;
  if (!response) return { schema: null, complete: false, reason: `response ${status} is not described` };
  const resolvedResponse = resolveLocalRef(document, response);
  if (!resolvedResponse.complete) return { schema: null, complete: false, reason: resolvedResponse.reason };
  const content = resolvedResponse.value?.content;
  const media = content && typeof content === "object" && Object.prototype.hasOwnProperty.call(content, "application/json")
    ? content["application/json"]
    : content && typeof content === "object" && Object.prototype.hasOwnProperty.call(content, "application/*+json")
      ? content["application/*+json"]
      : null;
  if (!media || typeof media !== "object" || !Object.prototype.hasOwnProperty.call(media, "schema")) {
    return { schema: null, complete: false, reason: `response ${status} has no JSON schema` };
  }
  const schema = resolveLocalRef(document, media.schema);
  return { schema: schema.value, complete: schema.complete, reason: schema.reason };
}

function validateLiteral(document, schemaInput, value, location = "$", depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH) return [{ kind: "unknown", location, message: "schema nesting exceeded the bounded validator" }];
  const resolved = resolveLocalRef(document, schemaInput);
  if (!resolved.complete) return [{ kind: "unknown", location, message: resolved.reason }];
  if (resolved.value === true) return [];
  if (resolved.value === false) return [{ kind: "mismatch", location, message: "the boolean schema rejects every literal value" }];
  if (!resolved.value || typeof resolved.value !== "object" || Array.isArray(resolved.value)) {
    return [{ kind: "unknown", location, message: "the schema is not an object or boolean schema" }];
  }
  const schema = resolved.value;
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.allOf) || schema.not || schema.if) {
    return [{ kind: "unknown", location, message: "composed or conditional schemas require owner verification" }];
  }
  if (schema.nullable && value === null) return [];
  let effectiveType = schema.type;
  if (Array.isArray(effectiveType)) {
    const options = effectiveType.filter((type) => type !== "null");
    if (value === null && effectiveType.includes("null")) return [];
    if (options.length !== 1) return [{ kind: "unknown", location, message: "multi-type schemas require owner verification" }];
    effectiveType = options[0];
  }
  const type = effectiveType || (schema.properties ? "object" : null);
  const actualType = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (type && type !== actualType && !(type === "number" && (actualType === "number" || actualType === "integer"))) {
    return [{ kind: "mismatch", location, message: `expected ${type}, found ${actualType}` }];
  }
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length > MAX_ENUM_VALUES) return [{ kind: "unknown", location, message: "the enum exceeds the bounded validator" }];
    const serializedValue = JSON.stringify(value);
    if (!schema.enum.some((item) => JSON.stringify(item) === serializedValue)) {
      return [{ kind: "mismatch", location, message: "literal value is outside the documented enum" }];
    }
  }
  if (type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    if (Object.keys(properties).length > MAX_SCHEMA_PROPERTIES) return [{ kind: "unknown", location, message: "schema has too many properties for the bounded validator" }];
    const valueKeys = Object.keys(value);
    if (valueKeys.length > MAX_SCHEMA_PROPERTIES) return [{ kind: "unknown", location, message: "the literal object exceeds the bounded validator" }];
    if (schema.required != null && !Array.isArray(schema.required)) return [{ kind: "unknown", location, message: "schema required must be a bounded string list" }];
    if (Array.isArray(schema.required) && (schema.required.length > MAX_SCHEMA_PROPERTIES || schema.required.some((item) => typeof item !== "string"))) {
      return [{ kind: "unknown", location, message: "schema required must be a bounded string list" }];
    }
    const issues = [];
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) issues.push({ kind: "mismatch", location: `${location}.${required}`, message: "required property is missing" });
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) issues.push(...validateLiteral(document, properties[key], child, `${location}.${key}`, depth + 1));
      else if (schema.additionalProperties === false) issues.push({ kind: "mismatch", location: `${location}.${key}`, message: "property is not described" });
    }
    return issues;
  }
  if (type === "array" && Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) return [{ kind: "unknown", location, message: "the literal array exceeds the bounded validator" }];
    if (schema.items) return value.flatMap((item, index) => validateLiteral(document, schema.items, item, `${location}[${index}]`, depth + 1));
  }
  return [];
}

module.exports = {
  parseOpenApi,
  resolveLocalRef,
  matchingPaths,
  operationFor,
  literalServers,
  requestSchema,
  responseSchema,
  validateLiteral,
  assertNoDuplicateJsonKeys
};
