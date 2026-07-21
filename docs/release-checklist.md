# Release checklist

Black Box has not been published. Completing a source check is necessary but does not authorize a tag, package publication, signing operation, or update to `origin`.

## Automated source gates

The checked-in [CI workflow](../.github/workflows/ci.yml) defines three boundaries:

- formatting, lint, strict typechecking and unit tests on Ubuntu with Node.js 22.20.0;
- build and unit compatibility at the declared minimum Node.js 22.13.0;
- native dependency installation, production build, packaged CLI lifecycle, and two consecutive offline fallback rehearsals on current GitHub-hosted Ubuntu, macOS and Windows runners.

The matrix uses `fail-fast: false` so one platform cannot hide another platform's result. It grants only read access to repository contents and has no publish credentials or deployment step. A workflow file is not evidence that those jobs passed: record the run URL and immutable commit SHA after it executes on GitHub.

## Before a release candidate

Run the read-only aggregate preflight first:

```bash
npm run release:preflight
```

It runs the source gate, clean-installs the packed runtime set, audits dependencies, checks the candidate manifests, and rejects a dirty tree. Use `npm run --silent release:preflight -- --json` for a machine-readable report without npm's command banner. The command is expected to report blockers while the repository retains placeholder versions, private package flags, or incomplete publication metadata; it never changes those values.

- [ ] Start from a clean, reviewed commit.
- [ ] Run `npm ci` and `npm run check` locally.
- [ ] Run `npm audit --audit-level=high` and review the complete dependency tree.
- [ ] Run `npm run benchmark`; update measured claims only if the method and final source match.
- [ ] Run `npm run demo:offline` twice with external network access unavailable.
- [ ] Run `npm run package:smoke`; inspect the reported tarball names, file counts, and sizes.
- [ ] Confirm the demo repository still contains its test and both report artifacts were produced.
- [ ] Confirm CI passed on Ubuntu, macOS and Windows for the exact candidate SHA.
- [ ] Inspect the package tarballs from the package smoke test; reject secrets, local databases, logs, source maps, fixtures not intended for distribution, and missing runtime assets.
- [ ] Confirm the CLI tarball contains the project license and generated notices for every dependency embedded in the browser assets.
- [ ] Review `.bbx` share/forensic warnings, optional-AI consent copy, and supported/unsupported claims.
- [ ] Record known limitations and migration compatibility.
- [ ] Capture fallback screenshots/video from the exact candidate, if required for the release venue.

## Explicit release operations

These steps require separate authorization and configured signing/publishing identity:

- choose and apply the release version;
- create a signed tag;
- push the candidate commit and tag;
- publish the npm package with provenance;
- verify installation from the public registry on every claimed platform;
- publish release notes and immutable checksums.

Never infer permission to perform these operations from permission to build or commit locally.
