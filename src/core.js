"use strict";

const { compare } = require("./matcher");
const { readBoundedRepositoryFile } = require("./paths");
const { renderMarkdown } = require("./renderer");

function checkRepository(options) {
  const quickstart = readBoundedRepositoryFile(options.workspace, options.quickstartPath, "Quickstart");
  const openapi = readBoundedRepositoryFile(options.workspace, options.openapiPath, "OpenAPI");
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
