before: cc854dba (2026-11-03T15:21:44.411Z)   after: 6f451775 (2026-11-03T15:28:19.077Z)


### performance

| check | before | after |
|---|---|---|
| direct p50 / p95 | 0.53 / 0.96 ms | 0.34 / 0.88 ms |
| via proxy p50 / p95 | 3.34 / 5.19 ms | 1.12 / 2.18 ms |
| overhead p50 | PASS 2.81 ms | PASS 0.78 ms |
| overhead p95 | PASS 4.23 ms | PASS 1.3 ms |
| first-byte delay added | FAIL 3.15 ms | PASS 2.33 ms ✔ |
| chunks not batched | PASS 20/20 chunks | PASS 20/20 chunks |
| stream duration preserved | PASS | PASS |
| c=1 throughput | 50 req/s | 53 req/s |
| c=1 latency p50 / p95 | 16.09 / 31.8 ms | 15.83 / 31.77 ms |
| c=1 no failures | PASS | PASS |
| c=10 throughput | 181 req/s | 574 req/s |
| c=10 latency p50 / p95 | 53.18 / 67.84 ms | 15.86 / 23.55 ms |
| c=10 no failures | PASS | PASS |
| c=50 throughput | 182 req/s | 336 req/s |
| c=50 latency p50 / p95 | 247.64 / 425.74 ms | 140.99 / 249.89 ms |
| c=50 no failures | PASS | PASS |
| event-loop max stall | 328.73 ms | 160.56 ms |
| event-loop p99 delay | FAIL 95.42 ms | PASS 45.97 ms ✔ |
| 250 KB body forwarded and model rewritten | PASS | PASS |
| 250 KB request via proxy (median) | 6.45 ms | 4.98 ms |
| 250 KB added latency (median) | PASS 4.14 ms | PASS 2.77 ms |
| 1024 KB body forwarded and model rewritten | PASS | PASS |
| 1024 KB request via proxy (median) | 17.05 ms | 13.83 ms |
| 1024 KB added latency (median) | PASS 11.2 ms | PASS 5.14 ms |
| 5 MB response direct / via proxy | 21.02 / 42.16 ms | 23.62 / 51.82 ms |
| read+parse both files | 1291.4 us/request | 1393.3 us/request |
| new upstream connections per 100 requests | FAIL 97 conns | PASS 1 conns ✔ |
| RSS before -> after | 125.9 -> 119.7 MB | 65.5 -> 68.1 MB |
| RSS growth | PASS -6.2 MB | PASS 2.6 MB |
| open handles growth | FAIL 19 handles | PASS 0 handles ✔ |
| every request logged | PASS 5059 lines | PASS 5062 lines |

### reliability

| check | before | after |
|---|---|---|
| persistent 503 returned to client | PASS | PASS |
| upstream attempts on persistent 503 | PASS 1 attempts | PASS 3 attempts |
| proxy alive afterwards | PASS | PASS |
| feature: retry recovers from one 502 | FAIL | PASS ✔ |
| feature: retry recovers from one 503 | FAIL | PASS ✔ |
| feature: retry recovers from one 504 | FAIL | PASS ✔ |
| feature: retry recovers from one 529 | FAIL | PASS ✔ |
| 429 passed through with retry-after | PASS | PASS |
| 400 not retried | PASS | PASS |
| 502 JSON error to client | PASS | PASS |
| still serving after failure | PASS | PASS |
| persistent reset -> 502 | PASS | PASS |
| upstream attempts on persistent reset | PASS 1 attempts | PASS 3 attempts |
| feature: retry recovers from one reset | FAIL | PASS ✔ |
| proxy alive afterwards | PASS | PASS |
| client sees a truncated stream | PASS | PASS |
| no JSON error appended to stream | PASS | PASS |
| no retry after bytes were sent | PASS | PASS |
| proxy alive afterwards | PASS | PASS |
| upstream request cancelled | PASS | PASS |
| 30 MB stream delivered intact | PASS | PASS |
| upstream was throttled while client paused | PASS | PASS |
| proxy peak RSS growth | PASS 13.41 MB | PASS 8.82 MB |
| feature: hung upstream gets a 502/504 quickly | FAIL | PASS ✔ |
| feature: slow headers cut off | FAIL | PASS ✔ |
| feature: stalled stream is closed | FAIL | PASS ✔ |
| slow but live stream is NOT cut off | PASS | PASS |
| feature: falls back when primary is overloaded | FAIL | PASS ✔ |
| fallback not used when primary works | PASS | PASS |
| 5 MB binary response byte-identical | PASS | PASS |
| non-JSON response passed through | PASS | PASS |
| body "{not json" handled | PASS | PASS |
| body "" handled | PASS | PASS |
| body "null" handled | PASS | PASS |
| body "[1]" handled | PASS | PASS |
| body "\"str\"" handled | PASS | PASS |
| proxy alive afterwards | PASS | PASS |
| pid file replaced with live pid | PASS | PASS |
| restart after hard kill serves requests | PASS | PASS |
| pid file matches new process | PASS | PASS |
| second instance exits with a clear message | PASS | PASS |
| first instance unaffected | PASS | PASS |
| baseline mapping works | PASS | PASS |
| config deleted: last good config kept | PASS | PASS |
| config half-written: last good config kept | PASS | PASS |
| config restored: picked up again | PASS | PASS |
| .env missing: defined JSON error, no crash | PASS | PASS |
| invalid PROVIDER_BASE_URL: 500 JSON error | PASS | PASS |
| recovers when .env is fixed | PASS | PASS |
| requests still served when proxy.log cannot be written | PASS | PASS |
| proxy process still running | PASS | PASS |
| soak requests | 8962 req | 5155 req |
| no timeouts or dropped connections | PASS | PASS |
| proxy alive at end | PASS | PASS |
| RSS growth | FAIL 120.37 MB | PASS 13.2 MB ✔ |
| open handles growth | PASS 8 handles | PASS 7 handles |

### observability

| check | before | after |
|---|---|---|
| sample line (normal request) | 2026-11-03T15:21:41.234Z POST /v1/messages model=alias-model->mapped/model -> 200 bytes=98 | 2026-11-03T15:28:15.088Z --- proxy started on 127.0.0.1:56606 -> http://127.0.0.1:56605 aliases=1
2026-11-03T15:28:15.131Z POST /v1/messages model=alias-model->mapped/model via=alias status=200 ms=10 bytes=98 ua=claude-c |
| Q1 which client sent it (user-agent logged) | FAIL | PASS ✔ |
| Q2a alias requests show sent -> used model | PASS | PASS |
| Q2b default_model fallback is visibly marked | FAIL | PASS ✔ |
| Q2c passthrough id is distinguishable | PASS | PASS |
| Q3a duration logged | FAIL | PASS ✔ |
| Q3b duration covers the whole stream | FAIL | PASS ✔ |
| Q4 upstream request id logged (match provider logs) | FAIL | PASS ✔ |
| Q5a upstream error marked as upstream | FAIL | PASS ✔ |
| Q5b network failure shows cause and source | FAIL | PASS ✔ |
| Q5c blocked request marked as proxy-generated | FAIL | PASS ✔ |
| Q6 retries visible when they happen | FAIL | PASS ✔ |
| no keys, tokens or request bodies in log | PASS | PASS |
| every request line has one fixed shape (status=NNN) | FAIL | PASS ✔ |
| average log line size | PASS 91.33 bytes | PASS 144.89 bytes |
| blocked requests are logged | PASS | PASS |
| config errors are logged | PASS | PASS |
| startup is logged | PASS | PASS |
| config error line says which config is used | PASS | PASS |
| status code present on failed requests | PASS | PASS |
| log rotates past the size limit | PASS | PASS |
| reliability: proxy.log replaced by a directory (setup) (new) | — | PASS |

| area | pass before | pass after | fail before | fail after |
|---|---|---|---|---|
| performance | 13 | 17 | 4 | 0 |
| reliability | 45 | 56 | 10 | 0 |
| observability | 10 | 20 | 10 | 0 |
