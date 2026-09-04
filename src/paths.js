"use strict";

const fs = require("node:fs");
const path = require("node:path");
const limits = require("./limits");

const DISCOVERY_NAMES = Object.freeze({
  Quickstart: /^(?:quickstart|getting-started)\.(?:md|mdx)$/i,
  OpenAPI: /^(?:openapi|swagger)\.(?:json|ya?ml)$/i
});

const IGNORED_DISCOVERY_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".cache", ".next", "build", "coverage", "dist", "node_modules", "vendor"
]);

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

function assertNoSymlinkComponents(root, repositoryPath, kind) {
  let current = root;
  for (const part of repositoryPath.split("/")) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${kind} discovered path cannot contain symlinks`);
  }
}

function escapesRepository(relative) {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function readBoundedRepositoryFile(workspace, inputPath, kind, options = {}) {
  const repositoryPath = validateRepositoryPath(inputPath, kind);
  const root = fs.realpathSync(workspace);
  const absolute = path.resolve(root, ...repositoryPath.split("/"));
  const relative = path.relative(root, absolute);
  if (!relative || escapesRepository(relative)) throw new Error(`${kind} path escapes the repository`);
  if (options.rejectSymlinks) assertNoSymlinkComponents(root, repositoryPath, kind);
  const real = fs.realpathSync(absolute);
  const realRelative = path.relative(root, real);
  if (escapesRepository(realRelative)) throw new Error(`${kind} symlink escapes the repository`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`${kind} path must identify one file`);
  const maximum = kind === "Quickstart" ? limits.MAX_QUICKSTART_BYTES : limits.MAX_OPENAPI_BYTES;
  if (stat.size > maximum) throw new Error(`${kind} file exceeds the bounded size limit`);
  return { repositoryPath, text: fs.readFileSync(real, "utf8") };
}

function discoveryKind(fileName) {
  for (const [kind, pattern] of Object.entries(DISCOVERY_NAMES)) {
    if (pattern.test(fileName)) return kind;
  }
  return null;
}

function tightenedLimit(value, maximum) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;
}

function discoverRepositoryPaths(workspace, requestedKinds, overrides = {}) {
  const kinds = new Set(requestedKinds);
  if (kinds.size === 0 || [...kinds].some((kind) => !DISCOVERY_NAMES[kind])) throw new Error("Discovery requires Quickstart and/or OpenAPI");
  const maximumDepth = tightenedLimit(overrides.maxDepth, limits.MAX_DISCOVERY_DEPTH);
  const maximumEntries = tightenedLimit(overrides.maxEntries, limits.MAX_DISCOVERY_ENTRIES);
  const maximumFiles = tightenedLimit(overrides.maxFiles, limits.MAX_DISCOVERY_FILES);
  const root = fs.realpathSync(workspace);
  if (!fs.statSync(root).isDirectory()) throw new Error("GITHUB_WORKSPACE must identify a directory");
  const found = Object.fromEntries([...kinds].map((kind) => [kind, []]));
  const queue = [{ absolute: root, repositoryPath: "", depth: 0 }];
  let queueIndex = 0;
  let entriesSeen = 0;
  let filesSeen = 0;

  while (queueIndex < queue.length) {
    const directory = queue[queueIndex];
    queueIndex += 1;
    const entries = [];
    const handle = fs.opendirSync(directory.absolute);
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        entriesSeen += 1;
        if (entriesSeen > maximumEntries) throw new Error(`Path discovery exceeded its ${maximumEntries}-entry traversal limit; configure exact paths`);
        entries.push(entry);
      }
    } finally {
      handle.closeSync();
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const repositoryPath = directory.repositoryPath ? `${directory.repositoryPath}/${entry.name}` : entry.name;
      const candidateKind = discoveryKind(entry.name);
      const absolute = path.join(directory.absolute, entry.name);

      if (entry.isSymbolicLink()) {
        if (candidateKind && kinds.has(candidateKind)) throw new Error(`${candidateKind} discovery refuses a symlink candidate; configure an exact regular-file path`);
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DISCOVERY_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        if (directory.depth >= maximumDepth) throw new Error(`Path discovery exceeded its ${maximumDepth}-directory depth limit; configure exact paths`);
        queue.push({ absolute, repositoryPath, depth: directory.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      filesSeen += 1;
      if (filesSeen > maximumFiles) throw new Error(`Path discovery exceeded its ${maximumFiles}-file limit; configure exact paths`);
      if (!candidateKind || !kinds.has(candidateKind)) continue;
      const repositoryCandidate = validateRepositoryPath(repositoryPath, candidateKind);
      const maximum = candidateKind === "Quickstart" ? limits.MAX_QUICKSTART_BYTES : limits.MAX_OPENAPI_BYTES;
      if (fs.statSync(absolute).size > maximum) throw new Error(`${candidateKind} discovery candidate exceeds the bounded size limit`);
      found[candidateKind].push(repositoryCandidate);
      if (found[candidateKind].length > 1) throw new Error(`${candidateKind} discovery found multiple candidates; configure one exact path`);
    }
  }

  for (const kind of kinds) {
    if (found[kind].length !== 1) throw new Error(`${kind} discovery found no canonical candidate; configure one exact path`);
  }
  return Object.fromEntries([...kinds].map((kind) => [kind, found[kind][0]]));
}

function resolveRepositoryInputs(workspace, quickstartPath, openapiPath, discoverPaths) {
  const quickstartProvided = typeof quickstartPath === "string" && quickstartPath.trim() !== "";
  const openapiProvided = typeof openapiPath === "string" && openapiPath.trim() !== "";
  const missingKinds = [];
  if (!quickstartProvided) missingKinds.push("Quickstart");
  if (!openapiProvided) missingKinds.push("OpenAPI");
  if (missingKinds.length > 0 && discoverPaths !== true) {
    throw new Error(`${missingKinds.join(" and ")} path${missingKinds.length > 1 ? "s are" : " is"} required unless discover-paths is true`);
  }
  const discovered = missingKinds.length > 0 ? discoverRepositoryPaths(workspace, missingKinds) : {};
  return {
    quickstartPath: quickstartProvided ? quickstartPath : discovered.Quickstart,
    openapiPath: openapiProvided ? openapiPath : discovered.OpenAPI,
    quickstartDiscovered: !quickstartProvided,
    openapiDiscovered: !openapiProvided
  };
}

module.exports = {
  validateRepositoryPath,
  readBoundedRepositoryFile,
  discoverRepositoryPaths,
  resolveRepositoryInputs
};
