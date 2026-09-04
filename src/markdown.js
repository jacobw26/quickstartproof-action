"use strict";

const { MAX_SNIPPETS, MAX_STEPS } = require("./limits");

const HTTP_METHODS = new Set(["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"]);

function shellTokens(command) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      token += char === "\n" ? " " : char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (/[;|&<>\r\n]/.test(char)) return { tokens, ambiguous: true, reason: "shell control syntax is outside the static boundary" };
    else if (/\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
    } else token += char;
  }
  if (escaped || quote) return { tokens, ambiguous: true, reason: "unclosed shell quoting or escaping" };
  if (token) tokens.push(token);
  return { tokens, ambiguous: false };
}

function parseCurl(command, line) {
  const normalized = command.replace(/\\\r?\n/g, " ").trim();
  if (!/^curl(?:\s|$)/i.test(normalized)) return null;
  if (/\$\(|`|\$\{|<\(|>\(/.test(normalized)) {
    return { line, ambiguous: true, reason: "dynamic shell syntax is not evaluated" };
  }
  const tokenized = shellTokens(normalized);
  if (tokenized.ambiguous) return { line, ambiguous: true, reason: tokenized.reason || "ambiguous shell syntax" };
  const args = tokenized.tokens.slice(1);
  let method = null;
  let rawUrl = null;
  let data = null;
  const headers = Object.create(null);
  const unsupported = [];
  let dataCount = 0;

  const takeValue = (index) => (index + 1 < args.length ? args[index + 1] : null);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "-X" || value === "--request") {
      method = takeValue(index);
      if (method == null) unsupported.push("request-without-value");
      index += 1;
    } else if (value.startsWith("--request=")) method = value.slice(10);
    else if (["-H", "--header"].includes(value)) {
      const header = takeValue(index);
      index += 1;
      if (!header || !header.includes(":")) unsupported.push("header-without-name");
      else {
        const separator = header.indexOf(":");
        headers[header.slice(0, separator).trim().toLowerCase()] = header.slice(separator + 1).trim();
      }
    } else if (value.startsWith("--header=")) {
      const header = value.slice(9);
      const separator = header.indexOf(":");
      if (separator < 1) unsupported.push("header-without-name");
      else headers[header.slice(0, separator).trim().toLowerCase()] = header.slice(separator + 1).trim();
    } else if (["-d", "--data", "--data-raw", "--data-binary"].includes(value)) {
      data = takeValue(index);
      dataCount += 1;
      if (data == null) unsupported.push("data-without-value");
      index += 1;
    } else if (/^--data(?:-raw|-binary)?=/.test(value)) {
      data = value.slice(value.indexOf("=") + 1);
      dataCount += 1;
    }
    else if (value === "--url") {
      rawUrl = takeValue(index);
      if (rawUrl == null) unsupported.push("url-without-value");
      index += 1;
    } else if (value.startsWith("--url=")) rawUrl = value.slice(6);
    else if (value.startsWith("-") && !["-s", "-S", "-sS", "--silent", "--show-error", "-L", "--location"].includes(value)) unsupported.push(value.split("=", 1)[0].slice(0, 40));
    else if (/^https?:\/\//i.test(value) || value.startsWith("/")) {
      if (rawUrl) unsupported.push("additional-positional-url");
      else rawUrl = value;
    } else unsupported.push("unexpected-positional-argument");
  }

  if (!rawUrl || /\$|\{|\}|\[|\]/.test(rawUrl)) return { line, ambiguous: true, reason: "the request URL is missing or dynamic" };
  if (dataCount > 1) unsupported.push("multiple-request-bodies");
  if (data && data.startsWith("@")) return { line, ambiguous: true, reason: "file-backed request bodies are outside the static boundary" };
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl, "https://quickstartproof.invalid");
  } catch {
    return { line, ambiguous: true, reason: "the request URL is not a literal HTTP path" };
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) return { line, ambiguous: true, reason: "only literal HTTP(S) URLs are supported" };

  let jsonBody = null;
  let bodyError = null;
  if (data != null) {
    try {
      jsonBody = JSON.parse(data);
    } catch {
      bodyError = "the request body is not literal JSON";
    }
  }
  const normalizedMethod = String(method || (data != null ? "POST" : "GET")).toUpperCase();
  if (!HTTP_METHODS.has(normalizedMethod)) unsupported.push("unsupported-http-method");
  return {
    line,
    method: normalizedMethod,
    rawUrl,
    absolute: /^https?:\/\//i.test(rawUrl),
    origin: /^https?:\/\//i.test(rawUrl) ? parsedUrl.origin : null,
    pathname: parsedUrl.pathname,
    queryNames: [...new Set(parsedUrl.searchParams.keys())],
    headers,
    dataPresent: data != null,
    jsonBody,
    bodyError,
    unsupported: [...new Set(unsupported)],
    ambiguous: unsupported.length > 0,
    reason: unsupported.length ? `unsupported cURL options: ${unsupported.join(", ")}` : null
  };
}

function parseQuickstart(markdown) {
  const lines = markdown.split(/\r?\n/);
  const snippets = [];
  const jsonExamples = [];
  const headings = [];
  const stepNumbers = [];
  const localReferences = new Set();
  let fence = null;

  const finishFence = () => {
    const content = fence.lines.join("\n").trim();
    if (/^(?:bash|sh|shell|zsh|console|terminal)?$/.test(fence.language) && /^\s*curl(?:\s|$)/im.test(content)) {
      const curlOffset = fence.lines.findIndex((entry) => /^\s*curl(?:\s|$)/i.test(entry));
      const curl = parseCurl(fence.lines.slice(curlOffset).join("\n"), fence.start + Math.max(0, curlOffset));
      if (curl && snippets.length <= MAX_SNIPPETS) snippets.push(curl);
    } else if (fence.language === "json" && content && jsonExamples.length < MAX_SNIPPETS) {
      let value = null;
      let error = null;
      try { value = JSON.parse(content); } catch { error = "invalid literal JSON"; }
      const nearby = lines.slice(Math.max(0, fence.start - 5), fence.start - 1).join(" ");
      const status = nearby.match(/\b(?:response|status)\D{0,12}([1-5]\d\d)\b/i)?.[1] || null;
      jsonExamples.push({ line: fence.start, value, error, status });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      const closing = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        finishFence();
        fence = null;
      } else fence.lines.push(line);
      continue;
    }

    const opening = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)[^\r\n]*$/);
    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length, language: opening[2].toLowerCase(), start: index + 2, lines: [] };
      continue;
    }

    const heading = line.match(/^#{2,4}\s+(.+)/);
    if (heading) {
      headings.push({ line: index + 1, text: heading[1].trim() });
      const step = heading[1].match(/^step\s+(\d+)\b/i);
      if (step) stepNumbers.push({ number: Number(step[1]), line: index + 1 });
    }
    for (const match of line.matchAll(/`((?:\.\.\/|\.\/)[^`\s]+)`/g)) localReferences.add(match[1]);
  }

  const sequenceMismatch = stepNumbers.some((step, index) => step.number !== index + 1);
  return {
    snippets,
    snippetOverflow: snippets.length > MAX_SNIPPETS,
    headings,
    stepCount: stepNumbers.length || headings.filter((entry) => /^(?:\d+[.)]|step\b)/i.test(entry.text)).length,
    stepOverflow: (stepNumbers.length || headings.length) > MAX_STEPS,
    sequenceMismatch,
    sequenceLine: stepNumbers.find((step, index) => step.number !== index + 1)?.line || null,
    localReferences: [...localReferences].slice(0, 20),
    jsonExamples: jsonExamples.slice(0, MAX_SNIPPETS)
  };
}

module.exports = { parseQuickstart, parseCurl, shellTokens };
