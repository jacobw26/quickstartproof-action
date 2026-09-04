"use strict";

const { MAX_YAML_DEPTH, MAX_YAML_LINES } = require("./limits");

class YamlSubsetError extends Error {
  constructor(message, line) {
    super(`${message}${line ? ` (line ${line})` : ""}`);
    this.name = "YamlSubsetError";
    this.line = line || null;
  }
}

function stripComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "#" && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index).trimEnd();
  }
  return value.trimEnd();
}

function splitKeyValue(value, line) {
  let quote = null;
  let braces = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "[" || char === "{") braces += 1;
    else if (char === "]" || char === "}") braces -= 1;
    else if (char === ":" && braces === 0) {
      return [value.slice(0, index).trim(), value.slice(index + 1).trim()];
    }
  }
  throw new YamlSubsetError("Expected a mapping entry", line);
}

function unquote(value) {
  if (value.startsWith("\"") && value.endsWith("\"")) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function parseScalar(value, line) {
  if (value === "") return undefined;
  if (/^[>|]/.test(value)) throw new YamlSubsetError("Block scalars are not supported in the bounded parser", line);
  if (/[*&!][^\s]*/.test(value)) throw new YamlSubsetError("YAML anchors, aliases, and tags require owner verification", line);
  if (/^(?:null|~)$/i.test(value)) return null;
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    try {
      return JSON.parse(value.replace(/'/g, "\""));
    } catch {
      throw new YamlSubsetError("Inline YAML collections must use JSON-compatible quoting", line);
    }
  }
  return unquote(value);
}

function normalizeLines(text) {
  if (/^\s*---\s*$/m.test(text) || /^\s*\.\.\.\s*$/m.test(text)) {
    throw new YamlSubsetError("Multi-document YAML is outside the MVP boundary");
  }
  if (/\t/.test(text)) throw new YamlSubsetError("Tabs are not accepted for YAML indentation");
  let lineCount = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineCount += 1;
    if (lineCount > MAX_YAML_LINES) throw new YamlSubsetError("The YAML document exceeds the bounded line limit");
  }
  return text.split(/\r?\n/).map((raw, index) => {
    const content = stripComment(raw);
    return {
      line: index + 1,
      indent: content.match(/^ */)[0].length,
      text: content.trim()
    };
  }).filter((entry) => entry.text);
}

function parseYamlSubset(text) {
  const lines = normalizeLines(text);
  if (lines.length === 0) throw new YamlSubsetError("The OpenAPI file is empty");

  function parseBlock(start, indent, depth = 0) {
    if (depth > MAX_YAML_DEPTH) throw new YamlSubsetError("YAML nesting exceeds the bounded parser depth", lines[start]?.line);
    if (lines[start].indent !== indent) throw new YamlSubsetError("Unexpected indentation", lines[start].line);
    const sequence = lines[start].text.startsWith("-");
    const output = sequence ? [] : Object.create(null);
    let cursor = start;

    while (cursor < lines.length) {
      const entry = lines[cursor];
      if (entry.indent < indent) break;
      if (entry.indent > indent) throw new YamlSubsetError("Unexpected indentation", entry.line);
      if (sequence !== entry.text.startsWith("-")) break;

      if (sequence) {
        const itemText = entry.text.slice(1).trim();
        if (!itemText) {
          if (!lines[cursor + 1] || lines[cursor + 1].indent <= indent) {
            output.push(null);
            cursor += 1;
          } else {
            const parsed = parseBlock(cursor + 1, lines[cursor + 1].indent, depth + 1);
            output.push(parsed.value);
            cursor = parsed.next;
          }
          continue;
        }

        if (itemText.includes(":")) {
          const [rawKey, rawValue] = splitKeyValue(itemText, entry.line);
          const item = Object.create(null);
          const key = unquote(rawKey);
          if (!key || Object.prototype.hasOwnProperty.call(item, key)) throw new YamlSubsetError("Invalid mapping key", entry.line);
          if (rawValue) item[key] = parseScalar(rawValue, entry.line);
          else if (lines[cursor + 1] && lines[cursor + 1].indent > indent) {
            const parsed = parseBlock(cursor + 1, lines[cursor + 1].indent, depth + 1);
            item[key] = parsed.value;
            cursor = parsed.next - 1;
          } else item[key] = {};

          if (lines[cursor + 1] && lines[cursor + 1].indent > indent) {
            const parsed = parseBlock(cursor + 1, lines[cursor + 1].indent, depth + 1);
            if (!parsed.value || Array.isArray(parsed.value) || typeof parsed.value !== "object") {
              throw new YamlSubsetError("Sequence mapping continuation must be a mapping", lines[cursor + 1].line);
            }
            for (const [continuedKey, continuedValue] of Object.entries(parsed.value)) {
              if (Object.prototype.hasOwnProperty.call(item, continuedKey)) throw new YamlSubsetError("Duplicate mapping key", lines[cursor + 1].line);
              item[continuedKey] = continuedValue;
            }
            cursor = parsed.next - 1;
          }
          output.push(item);
          cursor += 1;
          continue;
        }

        output.push(parseScalar(itemText, entry.line));
        cursor += 1;
        continue;
      }

      const [rawKey, rawValue] = splitKeyValue(entry.text, entry.line);
      const key = unquote(rawKey);
      if (!key || Object.prototype.hasOwnProperty.call(output, key)) throw new YamlSubsetError("Duplicate or empty mapping key", entry.line);
      if (rawValue) {
        output[key] = parseScalar(rawValue, entry.line);
        cursor += 1;
      } else if (lines[cursor + 1] && lines[cursor + 1].indent > indent) {
        const parsed = parseBlock(cursor + 1, lines[cursor + 1].indent, depth + 1);
        output[key] = parsed.value;
        cursor = parsed.next;
      } else {
        output[key] = {};
        cursor += 1;
      }
    }
    return { value: output, next: cursor };
  }

  return parseBlock(0, lines[0].indent).value;
}

module.exports = { parseYamlSubset, YamlSubsetError };
