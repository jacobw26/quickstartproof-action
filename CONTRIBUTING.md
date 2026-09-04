# Contributing

QuickstartProof accepts narrowly scoped fixes that preserve its static,
offline, fail-closed boundary.

## Before opening a pull request

1. Use only synthetic or openly licensed fixtures. Never commit a credential,
   private repository path, customer source, contact detail, or production
   response.
2. Add a regression for every parser, matcher, renderer, path-containment, or
   runner change.
3. Run `npm run check`. It must rebuild `dist/index.js`, pass the full test
   suite, enforce the native-module allowlist, and prove byte-for-byte bundle
   parity.
4. Keep the default workflow permission at `contents: read`. Do not add a
   network call, telemetry, secret input, package installation, source upload,
   repository write, or execution of checked content.
5. Explain which conclusion is observed, inferred, or needs owner verification
   and why ambiguous input cannot become an aligned result.

Security reports belong in the private process described in `SECURITY.md`, not
in a public issue or pull request.
