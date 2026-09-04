"use strict";

function escapeTable(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/([|`*_[\]])/g, "\\$1")
    .replace(/[\r\n]+/g, " ");
}

function repositoryLink(repository, sha, file, line) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9a-f]{40}$/i.test(sha)) return null;
  const label = `${escapeTable(file)}:${line}`;
  const encodedPath = String(file).split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
  return `[${label}](https://github.com/${repository}/blob/${sha}/${encodedPath}#L${line})`;
}

function renderMarkdown(result, repository = "", sha = "") {
  const title = result.state === "aligned-on-static-checks"
    ? "Aligned on bounded static checks"
    : result.state === "changes-found"
      ? "Changes found"
      : "Insufficient public input";
  const lines = [
    "# QuickstartProof",
    "",
    `**${title}** — ${result.counts.checkedRequests} request(s), ${result.counts.mismatches} mismatch(es), ${result.counts.needsOwnerVerification} owner-verification item(s).`,
    "",
    "| Result | Basis | Check | Evidence | Source |",
    "| --- | --- | --- | --- | --- |"
  ];
  for (const item of result.evidence) {
    const icon = item.kind === "match" ? "PASS" : item.kind === "mismatch" ? "CHANGE" : "UNKNOWN";
    const linked = item.source.line ? repositoryLink(repository, sha, item.source.file, item.source.line) : null;
    const source = linked || escapeTable(`${item.source.file}${item.source.line ? `:${item.source.line}` : ""}`);
    lines.push(`| ${icon} | ${escapeTable(item.conclusion)} | ${escapeTable(item.check)} | ${escapeTable(item.message)} | ${source} |`);
  }
  lines.push("", `> ${result.boundary}`, "");
  return lines.join("\n");
}

module.exports = { renderMarkdown, escapeTable, repositoryLink };
