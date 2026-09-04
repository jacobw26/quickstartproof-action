# QuickstartProof Action

QuickstartProof is a zero-dependency JavaScript Action that statically compares exactly one local Markdown/MDX cURL quickstart with exactly one same-repository OpenAPI 3.0, 3.1, or 3.2 JSON/YAML document.

## Boundary

The Action:

- never executes cURL, shell blocks, SDK examples, repository scripts, lifecycle hooks, containers, or customer code;
- never accepts or reads a token, secret, password, credential, or API-key input;
- makes no network or telemetry request;
- never modifies repository contents or opens a pull request;
- reads only the two explicitly configured paths after rejecting absolute paths, traversal, encoded paths, unsupported extensions, oversize files, and symlinks escaping the checkout;
- resolves internal OpenAPI references only and returns `insufficient-public-input` for unsupported or ambiguous syntax;
- writes the JSON result only to the `result-json` output and `RUNNER_TEMP`, plus a Markdown job summary and high-confidence source annotations.

It is a static consistency check, not proof of API correctness, availability, security, privacy, compliance, performance, or commercial results.

## Usage

```yaml
name: quickstart proof
on:
  pull_request:
    paths:
      - "docs/quickstart.md"
      - "openapi/openapi.yaml"

permissions:
  contents: read

jobs:
  proof:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b163ceea73d27597364c9af683
      # Reviewed initial public commit; update deliberately after review.
      - uses: jacobw26/quickstartproof-action@948e16699651237e46c265763ade14010fbcbd36
        with:
          quickstart-path: docs/quickstart.md
          openapi-path: openapi/openapi.yaml
          fail-on-changes: "false"
```

The example pins the reviewed initial public commit. When upgrading, inspect the target commit and replace the SHA deliberately. The checkout Action is also pinned to a full commit SHA.

## Inputs

| Input | Required | Meaning |
| --- | --- | --- |
| `quickstart-path` | yes | One repository-relative `.md` or `.mdx` file, at most 512 KB. |
| `openapi-path` | yes | One repository-relative `.json`, `.yaml`, or `.yml` file, at most 2 MB. |
| `fail-on-changes` | no | Set `true` to fail the step on high-confidence mismatches. UNKNOWN does not masquerade as a pass. |

The MVP supports no more than 10 numbered/headed steps and three cURL requests. Dynamic shell, file-backed bodies, external `$ref`, YAML anchors/tags, and complex composed schemas return UNKNOWN where a safe conclusion is not possible.

## Outputs

- `state`: `aligned-on-static-checks`, `changes-found`, or `insufficient-public-input`;
- `result-json`: bounded JSON with no raw source content or request literals;
- `result-file`: the same JSON in the runner temporary directory.

Each evidence item has `match`, `mismatch`, or `unknown` plus exactly one basis: `observed`, `inferred`, or `needs-owner-verification`.

## Development

The package has no runtime or development dependencies and requires Node.js 24 or newer.

```text
npm run check
```

`npm run build` deterministically bundles the audited CommonJS modules into `dist/index.js`; `npm run check` also requires byte-for-byte source/bundle parity and an offline native-module allowlist. The test suite covers 12 fixed synthetic fixture repositories across OpenAPI 3.0/3.1/3.2, JSON/YAML, Markdown/MDX, internal references, mismatches, ambiguous input, path containment, result bounds, and malicious-looking blocks that would create a file if executed. The trap file must never appear.

## License and security

MIT licensed. Report a vulnerability through the private process in [SECURITY.md](SECURITY.md); do not include real secrets in a report or fixture.

For ordinary usage questions, see [SUPPORT.md](SUPPORT.md). Proposed changes
must follow [CONTRIBUTING.md](CONTRIBUTING.md), and release history is recorded
in [CHANGELOG.md](CHANGELOG.md).
