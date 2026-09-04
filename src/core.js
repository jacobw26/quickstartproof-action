"use strict";

const { compare } = require("./matcher");
const { readBoundedRepositoryFile, resolveRepositoryInputs } = require("./paths");
const { renderMarkdown } = require("./renderer");

function checkRepository(options) {
  const selected = resolveRepositoryInputs(
    options.workspace,
    options.quickstartPath,
    options.openapiPath,
    options.discoverPaths === true
  );
  const quickstart = readBoundedRepositoryFile(options.workspace, selected.quickstartPath, "Quickstart", {
    rejectSymlinks: selected.quickstartDiscovered
  });
  const openapi = readBoundedRepositoryFile(options.workspace, selected.openapiPath, "OpenAPI", {
    rejectSymlinks: selected.openapiDiscovered
  });
  const result = compare(quickstart.text, openapi.text, {
    quickstartPath: quickstart.repositoryPath,
    openapiPath: openapi.repositoryPath
  });
  return {
    result,
    markdown: renderMarkdown(result, options.repository, options.sha)
  };
}

module.exports = { checkRepository, compare, renderMarkdown };
