# Performance smoke measurement

This document publishes a reproducible local smoke measurement, not a general performance guarantee.

## Result

- Measured: 2026-07-20T23:45:46.931Z
- Command: `npm run benchmark`
- Samples: 10 warmups, then 100 measured requests per route
- Machine: Intel Core i7-9750H, macOS 25.5.0, x64
- Runtime: Node.js v22.20.0
- Fixture SHA-256: `a48eb11e0f9d8862dc401e68ce421e6417365163c286287f24867f38ab717f1f`

| Route and metric               | p50      | p95       |
| ------------------------------ | -------- | --------- |
| Direct upstream TTFB           | 1.021 ms | 1.425 ms  |
| Recorded proxy TTFB            | 6.941 ms | 10.035 ms |
| Direct upstream total          | 1.127 ms | 1.621 ms  |
| Recorded proxy total           | 7.077 ms | 10.233 ms |
| Cockpit initial document TTFB  | 1.346 ms | 2.057 ms  |
| Cockpit initial document total | 1.465 ms | 2.269 ms  |

The p95 recorded-minus-direct delta was 8.610 ms to first byte and 8.612 ms total. The packaged cockpit had three production assets totaling 350,217 raw bytes and 99,523 bytes when each asset was gzipped. Source maps are excluded from that payload count.

## Method and limits

The benchmark starts a loopback HTTP upstream, a fresh Black Box daemon and evidence store, and the packaged cockpit. It alternates direct and recorded non-streaming Responses requests with a small deterministic JSON body, consumes every response, and requests the cockpit's initial HTML document once per sample. It records wall-clock durations with Node's monotonic performance clock.

This does not measure Internet latency, large bodies, SSE streams, concurrency, peak memory, browser parsing, rendering, frame time, or interaction latency. Loopback requests are much shorter than the 500 ms scenario used by the design's percentage-overhead target, so no percentage claim is made. Results vary by machine and background load; run `npm run benchmark` on each claimed release platform before publishing broader numbers.
