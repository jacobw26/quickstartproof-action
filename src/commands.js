"use strict";

function escapeCommandData(value) {
  return String(value ?? "")
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function escapeCommandProperty(value) {
  return escapeCommandData(value)
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

function warningAnnotation(item) {
  if (item?.kind !== "mismatch" || !["observed", "inferred"].includes(item.conclusion)) return null;
  if (!item.source || typeof item.source.file !== "string" || !Number.isInteger(item.source.line) || item.source.line < 1) return null;
  const properties = [
    `file=${escapeCommandProperty(item.source.file)}`,
    `line=${item.source.line}`,
    `title=${escapeCommandProperty(`QuickstartProof: ${item.check}`)}`
  ];
  return `::warning ${properties.join(",")}::${escapeCommandData(item.message)}`;
}

function errorAnnotation(message) {
  return `::error title=${escapeCommandProperty("QuickstartProof: configuration")}::${escapeCommandData(message)}`;
}

module.exports = { escapeCommandData, escapeCommandProperty, warningAnnotation, errorAnnotation };
