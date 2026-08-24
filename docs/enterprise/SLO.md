# Service Level Objectives — markdown-for-agents-mcp

> **Status: template — fill in measured values after running `node scripts/load-test.mjs`**
>
> Every number in this document must come from a measured load-test run against the
> target k8s cluster, not from estimates. Placeholder values are marked `TBD`.
> Until the load test has run and the numbers are filled in, this document is a
> draft and must not be used as a contract.

## Summary

| Metric | Target | Measured | Measured at |
|---|---|---|---|
| `fast` p95 latency | ≤ 1 s | TBD | — |
| `basic` p95 latency | ≤ 8 s | TBD | — |
| `advanced` p95 latency | ≤ 20 s | TBD | — |
| Availability (rolling 30 days) | ≥ 99.0 % | TBD | — |
| Error rate (5xx + tool errors) | ≤ 1 % | TBD | — |
| Cache hit rate (steady state) | ≥ 40 % | TBD | — |

Populate this table by running:

```sh
# Against a live k8s or docker-compose deployment
node scripts/load-test.mjs \
  --base http://localhost:3000 \
  --concurrency 10 \
  --queries 100 \
  --depths fast,basic,advanced
```

## Depth definitions

| Depth | What it does | Typical latency |
|---|---|---|
| `fast` | SERP snippets only — no page fetch, no render | p95 < 1 s structural |
| `basic` | Fetch + render pages, return full markdown | p95 2–8 s (network-bound) |
| `advanced` | Fetch + render + cross-encoder reranking | p95 10–20 s (CPU-bound) |

### Why `advanced` is slow by design

There is **no warm index.** Every `advanced` search fetches and renders live pages via
Chromium, then runs cross-encoder scoring over ~20 chunks × ~400 tokens. This is a
structural latency floor; it cannot be improved without building an index — a different
product. State this honestly in all SLO discussions.

## Error budget

| Window | Availability target | Allowed downtime |
|---|---|---|
| Rolling 30 days | 99.0 % | ≤ 7.2 h |
| Rolling 7 days | 99.5 % | ≤ 50 min |

Budget is consumed by:

- 5xx HTTP responses at `/mcp`
- Tool calls that return `isError: true`
- `/readyz` returning non-200 for > 30 s (counts as downtime for that replica)

Budget is **not** consumed by:

- Individual provider failures when another provider serves the query
- `advanced` latency exceeding the p95 target on a single call (covered by latency SLO, not availability)
- Planned maintenance windows with advance notice ≥ 48 h

## Alerts (thresholds for `docs/enterprise/RUNBOOK.md`)

> Fill in after load test — alert thresholds must come from measured numbers, not guesses.

| Alert | Condition | Severity |
|---|---|---|
| High error rate | `rate(mcp_tool_calls_total{outcome="error"}[5m]) / rate(mcp_tool_calls_total[5m]) > 0.05` | page |
| Search degraded | `increase(search_degraded_total[10m]) > 5` | warn |
| Cache hit rate collapse | `rate(search_cache_total{result="hit"}[30m]) / rate(search_cache_total[30m]) < 0.1` (after warm-up) | warn |
| All providers failing | `increase(search_degraded_total{reason="breaker_open"}[5m]) > 0 for all providers` | page |
| Reranker not ready | `reranker_ready == 0 for > 120s` (needs gauge — Phase 1 work) | warn |
| Browser pool saturated | `crawl_queue_depth > 50 for > 2m` | warn |

## Latency percentiles (measured — TBD)

Run `node scripts/load-test.mjs` and paste the output table here.

```
Depth      Queries  Errors  Error%      p50      p95      p99   SLO p95   Pass
---------- ------- ------- ------- -------- -------- -------- --------- ------
fast           TBD     TBD     TBD      TBD      TBD      TBD      ≤1.0s    TBD
basic          TBD     TBD     TBD      TBD      TBD      TBD      ≤8.0s    TBD
advanced       TBD     TBD     TBD      TBD      TBD      TBD     ≤20.0s    TBD

Cache hit rate (this run): TBD% (TBD hits / TBD total)
```

## Load-test conditions

> Fill in after measurement.

| Parameter | Value |
|---|---|
| Cluster | TBD |
| Node count / size | TBD |
| Replica count (server) | TBD |
| Replica count (worker) | TBD |
| Engine profile | TBD (clean / full) |
| Paid providers active | TBD |
| Concurrency | TBD |
| Query corpus | 30 × Vodacom-representative queries (`scripts/load-test.mjs` corpus) |
| Run date | TBD |

## Honest ceilings

These limitations are structural and will not be resolved by tuning:

1. **No warm index.** `fast` returns snippets from a live search; `advanced` renders live
   pages. Every query is a live round-trip to search engines and target URLs. Tavily,
   Exa, and similar services pre-crawl; this tool does not. The latency gap on
   `advanced` vs a warmed index is ~10× and is **not closable** without building one.

2. **`clean` profile has lower recall than Google.** The cross-encoder recovers much of
   the ranking quality from Mojeek + Marginalia + Brave (free), but it cannot retrieve
   pages the engines never returned. Ambiguous or narrow-domain queries benefit most
   from switching to `SEARXNG_ENGINE_PROFILE=full` or adding a paid key.

3. **IP reputation ceiling at sustained load.** At 10k searches/day from a single egress
   IP, engines will eventually rate-limit regardless of profile. Mitigations: the result
   cache (Phase 3), `PROXY_PINS` rotation, or the paid tier. At 1k/day the `clean`
   profile is expected to be stable indefinitely.

4. **`advanced` latency is CPU-bound, not network-bound.** Scaling replicas helps with
   concurrency but not with per-request latency. The cross-encoder is the floor;
   `bge-reranker-base` at q8 on 4 vCPU takes ~2–5 s per 20-chunk batch.

5. **NetworkPolicy requires Calico or Cilium.** The SSRF egress control in
   `deploy/k8s/base/networkpolicy.yaml` is inert on kindnet/Flannel. This is a cluster
   prerequisite. See `docs/enterprise/THREAT_MODEL.md` for details.

6. **Relevance ceiling vs Tavily.** `bge-reranker-base` is trained on MS MARCO; Tavily's
   scorer is trained on proprietary click data. The gap narrows on unambiguous queries
   and widens on ambiguous or domain-specific ones. Closing it requires fine-tuning on
   Vodacom's own query traffic — a separate ML programme.
