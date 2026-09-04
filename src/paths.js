"use strict";

const fs = require("node:fs");
const path = require("node:path");
const limits = require("./limits");

function validateRepositoryPath(value, kind) {
  if (typeof value !== "string") throw new Error(`${kind} path is required`);
  const candidate = value.trim().replace(/\\/g, "/");
  if (!candidate || candidate.length > 240 || candidate.startsWith("/") || candidate.includes("%") || /[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new Error(`${kind} path must be a plain repository-relative path`);
  }
  const parts = candidate.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`${kind} path cannot traverse directories`);
  const allowed = kind === "Quickstart" ? /\.(?:md|mdx)$/i : /\.(?:json|ya?ml)$/i;
  if (!allowed.test(candidate)) throw new Error(`${kind} file type is outside the MVP boundary`);
  return candidate;
}

function readBoundedRepositoryFile(workspace, inputPath, kind) {
  const repositoryPath = validateRepositoryPath(inputPath, kind);
  const root = fs.realpathSync(workspace);
  const absolute = path.resolve(root, ...repositoryPath.split("/"));
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${kind} path escapes the repository`);
  const real = fs.realpathSync(absolute);
  const realRelative = path.relative(root, real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error(`${kind} symlink escapes the repository`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`${kind} path must identify one file`);
  const maximum = kind === "Quickstart" ? limits.MAX_QUICKSTART_BYTES : limits.MAX_OPENAPI_BYTES;
  if (stat.size > maximum) throw new Error(`${kind} file exceeds the bounded size limit`);
  return { repositoryPath, text: fs.readFileSync(real, "utf8") };
}

module.exports = { validateRepositoryPath, readBoundedRepositoryFile };
