# Changelog

All notable changes to QuickstartProof are recorded here. Tagged releases
follow semantic versioning.

## 1.1.0 - 2026-09-04

- Added opt-in, canonical-name path discovery for omitted inputs with strict
  traversal, file-count, depth, selected-file size, ambiguity, and symlink
  boundaries. Exact-path workflows remain the default and bypass discovery.
- Hardened native GitHub workflow warnings for located high-confidence
  mismatches with explicit property/data escaping and no comment or write
  permissions.
- Added regressions for opt-in behavior, explicit-path compatibility,
  discovery fail-closed cases, annotations, and deterministic bundle parity.

## 1.0.0

- Added the zero-dependency Node 24 GitHub Action.
- Added bounded static comparison of one Markdown/MDX cURL quickstart with one
  same-repository OpenAPI 3.0–3.2 JSON/YAML document.
- Added source-linked annotations, a Markdown job summary, bounded JSON output,
  and the three non-certifying result states.
- Added 12 synthetic fixture repositories and adversarial regressions for
  traversal, symlink escape, ambiguous YAML/JSON, malformed references and
  shapes, Markdown injection, token-shaped leakage, shell constructs, bounds,
  and deterministic bundle parity.
