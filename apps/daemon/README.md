# `@blackbox/daemon`

The local capture, query, archive, and analysis service used by Black Box.

The daemon owns the byte-faithful OpenAI-compatible proxy, authenticated local
control/query API, SQLite evidence journal, browser assets, normalization,
sessionization, reporting, and archive/retention services.

This package exists to support the Black Box runtime and is not the normal entry
point. Install and invoke
[`@blackbox/cli`](https://www.npmjs.com/package/@blackbox/cli); the CLI manages the
daemon lifecycle and private control token.

## Security boundary

The control and cockpit listener is loopback-only. The recorder proxy also binds to
loopback by default and requires an explicit opt-in for non-loopback use. Do not
expose the control listener, copy its token into logs, or treat the daemon as a
sandbox for the wrapped process.

## Project links

- [Black Box repository](https://github.com/ayyagarisujanreddy123/Black-Box)
- [Complete project guide](https://github.com/ayyagarisujanreddy123/Black-Box/blob/main/docs/complete-project-guide.md)
- [Security policy](https://github.com/ayyagarisujanreddy123/Black-Box/security/policy)
- [Apache-2.0 license](https://github.com/ayyagarisujanreddy123/Black-Box/blob/main/LICENSE)
