# Performance smoke measurement

This document publishes a reproducible local smoke measurement, not a general performance guarantee.

## Result

- Measured: 2026-07-21T03:40:15.011Z
- Measured source commit: `cad4eed5a96cb6036a73590ed41d03a152141345`
- Command: `npm run benchmark`
- Samples: 10 warmups, then 100 measured requests per route
- Machine: Intel Core i7-9750H, macOS 25.5.0, x64
- Runtime: Node.js v22.20.0
- Fixture SHA-256: `a48eb11e0f9d8862dc401e68ce421e6417365163c286287f24867f38ab717f1f`

| Route and metric               | p50      | p95       |
| ------------------------------ | -------- | --------- |
| Direct upstream TTFB           | 1.132 ms | 2.196 ms  |
| Recorded proxy TTFB            | 7.812 ms | 11.973 ms |
| Direct upstream total          | 1.283 ms | 2.406 ms  |
| Recorded proxy total           | 7.960 ms | 12.340 ms |
| Cockpit initial document TTFB  | 1.486 ms | 2.037 ms  |
| Cockpit initial document total | 1.609 ms | 2.243 ms  |

The p95 recorded-minus-direct delta was 9.777 ms to first byte and 9.934 ms total. The packaged cockpit had three production assets totaling 350,226 raw bytes and 99,525 bytes when each asset was gzipped. Source maps are excluded from that payload count.

## Method and limits

The benchmark starts a loopback HTTP upstream, a fresh Black Box daemon and evidence store, and the packaged cockpit. It alternates direct and recorded non-streaming Responses requests with a small deterministic JSON body, consumes every response, and requests the cockpit's initial HTML document once per sample. It records wall-clock durations with Node's monotonic performance clock.

This does not measure Internet latency, large bodies, SSE streams, concurrency, peak memory, browser parsing, rendering, frame time, or interaction latency. Loopback requests are much shorter than the 500 ms scenario used by the design's percentage-overhead target, so no percentage claim is made. Results vary by machine and background load; run `npm run benchmark` on each claimed release platform before publishing broader numbers.
