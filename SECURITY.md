# Security policy

## Supported version

Security fixes target the default branch and the latest supported tagged release.

## Private reporting

Use the repository's [private vulnerability-reporting form](https://github.com/jacobw26/quickstartproof-action/security/advisories/new). Do not open a public issue for an unpatched vulnerability.

Include the affected commit SHA, a minimal synthetic reproduction, and the expected boundary. Never include a real token, credential, private repository URL, customer data, or production source.

## Security invariants

- Checked content is data and is never executed.
- The Action has no network or telemetry code.
- There is no secret/token input.
- Only two contained, bounded local files are read.
- Ambiguity returns `insufficient-public-input`, never a silent pass.
- Generated release code must match reviewed source byte-for-byte through `npm run check`.
