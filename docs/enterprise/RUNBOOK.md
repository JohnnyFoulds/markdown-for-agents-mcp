# Operations Runbook — markdown-for-agents-mcp

> Every alert in this runbook is keyed to a metric wired in the codebase.
> Thresholds marked **TBD** must be updated with measured values from
> `node scripts/load-test.mjs` (see `docs/enterprise/SLO.md`).
>
> Every procedure in this runbook must be executed at least once against
> a live deployment before this document is considered verified.

## Quick reference

| Symptom | Most likely cause | Jump to |
|---|---|---|
| `/readyz` → 503 | Reranker still loading or browser pool cold | [§1](#1-readyz-returning-503) |
| High error rate alert | Provider failures or tool panics | [§2](#2-high-mcp-error-rate) |
| Search results degraded | Engine blocking, breaker open, or cache cold | [§3](#3-search-degradation) |
| Cache hit rate collapsed | Valkey down, TTL too low, query distribution changed | [§4](#4-cache-hit-rate-collapse) |
| Latency spike | Browser pool saturated, worker queue depth growing | [§5](#5-latency-spike) |
| HPA not scaling | prometheus-adapter misconfigured, metrics absent | [§6](#6-hpa-not-scaling) |
| OOM / pod eviction | `/dev/shm` exhaustion, Chromium memory leak | [§7](#7-oom--pod-eviction) |
| SSRF violation alert | Probe request reaching a private IP | [§8](#8-ssrf-violation) |
| Rollback needed | Any deployment issue | [§9](#9-rollback) |

---

## 1. `/readyz` returning 503 {#1-readyz-returning-503}

**Metric:** none (HTTP probe)  
**Alert:** `startupProbe` failure → pod not added to Endpoints; traffic still served by other pods

### Diagnosis

```bash
kubectl logs -n mcp-system deployment/mcp-server --tail=50 | grep -E 'readyz|ready|warmup|reranker'
```

**Case A — Reranker still loading** (normal at startup; `startupProbe` allows 300 s)

```
[INFO] reranker warmup starting …
```

Wait up to 5 minutes. If still not ready after 5 minutes:

```bash
kubectl logs -n mcp-system deployment/mcp-server --tail=100 | grep -E 'ERROR|reranker|warmup'
```

Look for a `TransformersReranker: model load failed` error, which means the baked
model is absent from the image. Check:

```bash
kubectl exec -n mcp-system deployment/mcp-server -- ls /opt/hf/hub/
```

If empty: the image was built without the model bake step. Rebuild with:

```bash
docker build -t markdown-for-agents-mcp:latest .
```

**Case B — Browser pool not initialising** (Chromium crash at startup)

```bash
kubectl logs -n mcp-system deployment/mcp-server --tail=100 | grep -E 'browser|chromium|playwright'
```

Common cause: `/dev/shm` too small. Confirm the `emptyDir: medium: Memory` volume is
mounted (`kubectl describe pod <pod-name> -n mcp-system | grep shm`). If the pod spec
lacks it, re-apply the manifests.

**Case C — Store not connecting** (Valkey down; server stays not-ready)

```bash
kubectl logs -n mcp-system deployment/mcp-server | grep -i 'store\|redis\|valkey\|connect'
```

Check Valkey pod: `kubectl get pods -n mcp-system -l app=valkey`

### Resolution

- Model absent → rebuild image, redeploy
- `/dev/shm` missing → re-apply manifests
- Valkey down → see [§4](#4-cache-hit-rate-collapse) for Valkey recovery

---

## 2. High MCP error rate {#2-high-mcp-error-rate}

**Metric:** `mcp_tool_calls_total{outcome="error"}`  
**Alert condition:** `rate(mcp_tool_calls_total{outcome="error"}[5m]) / rate(mcp_tool_calls_total[5m]) > 0.05`  
**SLO target:** error rate ≤ 1 % sustained

### Diagnosis

```bash
# What tools are failing and how often?
kubectl exec -n mcp-system deployment/mcp-server -- \
  curl -s http://localhost:3000/metrics \
  | grep mcp_tool_calls_total

# Recent errors in logs
kubectl logs -n mcp-system deployment/mcp-server --tail=100 \
  | grep -E '"level":"ERROR"|"outcome":"error"'
```

**Case A — `web_search` errors**: see [§3](#3-search-degradation)

**Case B — `fetch_page` / `crawl_start` errors**: check the fetcher and Chromium:

```bash
kubectl logs -n mcp-system deployment/mcp-worker --tail=100 | grep ERROR
kubectl exec -n mcp-system deployment/mcp-server -- \
  curl -s http://localhost:3000/metrics | grep fetch_requests_total
```

**Case C — All tools failing**: likely the process is unhealthy. Check if `inflightRequests`
is stuck at a high value (event loop blocked):

```bash
kubectl exec -n mcp-system deployment/mcp-server -- \
  curl -s http://localhost:3000/metrics | grep mcp_inflight_requests
```

If inflight >> expected, the pod may be wedged. Roll it:

```bash
kubectl rollout restart deployment/mcp-server -n mcp-system
```

### Resolution

- Provider failures → see §3
- Chromium crashes → see §7
- Wedged pod → rollout restart (graceful) or see §9 for full rollback

---

## 3. Search degradation {#3-search-degradation}

**Metric:** `search_degraded_total{reason}`, `search_provider_requests_total{provider,outcome}`  
**Alert condition:** `increase(search_degraded_total[10m]) > 5`  
**Reasons:** `breaker_open` (provider circuit breaker tripped), `bot_challenge` (engine blocking)

### Diagnosis

```bash
kubectl exec -n mcp-system deployment/mcp-server -- \
  curl -s http://localhost:3000/metrics \
  | grep -E 'search_degraded_total|search_provider_requests_total'
```

**Case A — `reason="breaker_open"` incrementing**

A provider is failing repeatedly and its circuit breaker has opened. The breaker
auto-resets after its cooldown period (~60 s by default). Check which provider:

```bash
kubectl logs -n mcp-system deployment/mcp-server --tail=200 \
  | grep -E 'circuit breaker|breaker open|provider.*failed'
```

If SearXNG: check the SearXNG pod:

```bash
kubectl get pods -n mcp-system -l app=searxng
kubectl logs -n mcp-system deployment/searxng --tail=50
```

If Brave/Serper: likely API quota or downstream outage. Check provider status pages.
Search will fall through to the next tier automatically (SearXNG → DDG).

**Case B — `reason="bot_challenge"` incrementing**

An engine is returning 429 / HTML instead of JSON. This means the engine is rate-limiting
SearXNG's upstream requests — not the MCP server directly.

Short-term: switch engine profile to reduce load:

```bash
kubectl set env deployment/mcp-server -n mcp-system SEARXNG_ENGINE_PROFILE=clean
```

If already on `clean`: the `clean` profile's engines are rate-limiting at the current
query volume. Options:

1. Reduce query rate (wait for cache warmup — see §4)
2. Add a paid key to shift load to Brave/Serper:
   ```bash
   kubectl create secret generic mcp-secrets \
     --from-literal=BRAVE_API_KEY=<key> \
     --dry-run=client -o yaml | kubectl apply -f - -n mcp-system
   kubectl rollout restart deployment/mcp-server -n mcp-system
   ```
3. Add a SOCKS5 proxy pool (`PROXY_PINS`) to rotate egress IPs

**Case C — All providers failing, fallthrough to DDG tier-3**

Check `search_provider_requests_total` for all providers showing `outcome="error"`.
Users are still getting results (DDG tier-3 is always the backstop) but quality is
degraded. Escalate to check upstream provider status.

---

## 4. Cache hit rate collapse {#4-cache-hit-rate-collapse}

**Metric:** `search_cache_total{result="hit"|"miss"}`  
**Alert condition:** `rate(search_cache_total{result="hit"}[30m]) / rate(search_cache_total[30m]) < 0.1`
(only meaningful after 1 h warm-up; suppress in the first hour after deployment)

### Diagnosis

```bash
kubectl exec -n mcp-system deployment/mcp-server -- \
  curl -s http://localhost:3000/metrics | grep search_cache_total
```

**Case A — Valkey pod down**

Cache misses are expected when Valkey is unreachable (the code silently skips caching).
Check:

```bash
kubectl get pods -n mcp-system -l app=valkey
kubectl logs -n mcp-system -l app=valkey --tail=30
```

If the pod is down: `kubectl rollout restart deployment/valkey -n mcp-system`

If Valkey is persistently unavailable and the deployment has only one replica, the system
degrades to uncached operation — functional but higher engine load.

**Case B — TTL too short for query repetition pattern**

If cache is up but hit rate is low: the `SEARCH_CACHE_TTL_MS` may be too short for the
actual query repetition rate. Check the current TTL:

```bash
kubectl get configmap mcp-config -n mcp-system -o jsonpath='{.data.SEARCH_CACHE_TTL_MS}'
```

For department-wide usage at 1k queries/day, 1 h TTL (3600000 ms) is appropriate.
If queries are highly diverse, increase to 4 h or 24 h.

**Case C — `SEARXNG_ENGINE_PROFILE` changed**

Profile is part of the cache key. Switching profiles invalidates the existing cache.
Hit rate will recover after ~1 h of warmup.

---

## 5. Latency spike {#5-latency-spike}

**Metrics:** `mcp_tool_duration_seconds`, `browser_pool_in_use`, `browser_pool_queued`,
`crawl_queue_depth`  
**Alert condition (TBD):** `histogram_quantile(0.95, rate(mcp_tool_duration_seconds_bucket{tool="web_search"}[5m])) > TBD`

### Diagnosis

```bash
kubectl exec -n mcp-system deployment/mcp-server -- \
  curl -s http://localhost:3000/metrics \
  | grep -E 'browser_pool|crawl_queue_depth|mcp_inflight'
```

**Case A — Browser pool saturated** (`browser_pool_queued` > 0)

The browser pool is full and requests are queuing. This is expected under sustained
`basic`/`advanced` load. The worker-HPA should have scaled on `crawl_queue_depth`.
Check HPA:

```bash
kubectl get hpa -n mcp-system
```

If the HPA shows `<unknown>` for `crawl_queue_depth`, the prometheus-adapter is not
configured — see §6. The system will autoscale on CPU fallback instead.

Short-term relief: increase `RENDER_MAX_CONCURRENCY` (costs more memory per pod):

```bash
kubectl set env deployment/mcp-server -n mcp-system RENDER_MAX_CONCURRENCY=12
```

Max safe value: ~16 (each context ~150–200 MB; 16 × 200 MB = 3.2 GB vs 4 GB limit).

**Case B — `advanced` depth latency high** (expected: p95 10–20 s)

`advanced` depth is CPU-bound on cross-encoder inference. Per-request latency cannot
be improved by scaling. Check if the reranker is actually running:

```bash
kubectl exec -n mcp-system deployment/mcp-server -- \
  curl -s http://localhost:3000/metrics | grep rerank_duration_seconds
```

If no samples: reranker is in noop mode (`isReady() = false`). Check `/readyz` and
model load (see §1 Case A).

**Case C — `fast` depth is slow** (expected: p95 < 1 s)

`fast` does no page fetching. If p95 > 1 s for `fast`, the fanout itself is slow —
likely all providers failing and waiting for timeouts:

```bash
kubectl logs -n mcp-system deployment/mcp-server --tail=100 \
  | grep -E 'timeout|deadline|provider.*failed'
```

---

## 6. HPA not scaling {#6-hpa-not-scaling}

**Symptoms:** `kubectl get hpa -n mcp-system` shows `<unknown>` for custom metrics;
load increases but pod count stays at `minReplicas`.

### Diagnosis

```bash
kubectl describe hpa mcp-server-hpa -n mcp-system | grep -A5 'Conditions\|Metrics'
```

**Case A — prometheus-adapter not installed**

The `mcp_inflight_requests` and `crawl_queue_depth` custom metrics require
`prometheus-adapter` (kube-prometheus-stack or standalone). Without it, the HPA
falls back to CPU autoscaling only (still functional, just less responsive to request
load).

Install prometheus-adapter and configure it to expose `mcp_inflight_requests` and
`crawl_queue_depth` as pod/external metrics. A sample `custom-metrics-config.yaml` is
in `deploy/k8s/base/` (if present in your overlay).

**Case B — Metrics not being scraped**

Verify Prometheus is scraping the server pods:

```bash
# From inside the cluster
kubectl exec -n mcp-system deployment/mcp-server -- \
  curl -s http://localhost:3000/metrics | grep mcp_inflight_requests
```

If the metric is absent (no samples), the metric is not being incremented — check
`src/server/registry.ts` (Phase 1 wiring).

**Case C — Metric present but HPA not reacting**

The `averageValue: "6"` target means the HPA scales when the average inflight requests
per pod exceeds 6. Under low load this will never trigger. This is correct behaviour.

---

## 7. OOM / pod eviction {#7-oom--pod-eviction}

**Symptoms:** `kubectl describe pod <pod> -n mcp-system` shows `OOMKilled` or
`Evicted`; `browser_recycles_total` rising fast.

### Diagnosis

```bash
kubectl describe node <node> | grep -A10 'Conditions\|Allocated'
kubectl top pods -n mcp-system
```

**Case A — `/dev/shm` exhaustion** (most common Chromium failure)

Chrome writes shared memory to `/dev/shm`. The manifests mount a 1 Gi `emptyDir` at
`/dev/shm`. If the pod spec was modified and the mount was removed, Chrome will OOM
immediately.

```bash
kubectl describe pod <pod> -n mcp-system | grep -A3 shm
```

If absent: re-apply the base manifests.

**Case B — Too many concurrent contexts** (memory limit hit)

Each Chromium context uses ~150–200 MB. At `RENDER_MAX_CONCURRENCY=8`, peak usage is
~1.6 GB; the pod limit is 4 GB, leaving headroom for the Node.js process and model.
If `RENDER_MAX_CONCURRENCY` was increased above safe levels, reduce it:

```bash
kubectl set env deployment/mcp-server -n mcp-system RENDER_MAX_CONCURRENCY=6
```

**Case C — Chromium zombie processes**

`browser_recycles_total` incrementing rapidly indicates Chrome is crashing and being
recycled. Check logs:

```bash
kubectl logs -n mcp-system deployment/mcp-server --tail=200 | grep -i 'browser\|chrome\|crash\|recycle'
```

If a specific domain is triggering crashes, add it to `BLOCKED_DOMAINS` temporarily.

---

## 8. SSRF violation {#8-ssrf-violation}

**Metric:** `ssrf_violations_total`  
**Alert condition:** `increase(ssrf_violations_total[5m]) > 0` (any violation is a page)

### Diagnosis

```bash
kubectl exec -n mcp-system deployment/mcp-server -- \
  curl -s http://localhost:3000/metrics | grep ssrf_violations_total

kubectl logs -n mcp-system deployment/mcp-server --tail=100 \
  | grep -i 'ssrf\|private\|blocked'
```

The violation counter increments when the app-level `isPrivateIp()` guard fires — a
request was attempted to a private/loopback/metadata IP.

**Important:** The app-level guard is detect-and-discard. The authoritative SSRF
control is the `mcp-egress` NetworkPolicy which blocks RFC1918/link-local at the
kernel level. However, the NetworkPolicy only works on clusters with Calico or Cilium.
On kindnet/Flannel it is **advisory only**. See `docs/enterprise/THREAT_MODEL.md §3`.

If violations are coming from a particular domain (DNS rebinding attack vector):

```bash
kubectl set env deployment/mcp-server -n mcp-system \
  BLOCKED_DOMAINS="<offending-domain>"
```

Escalate to the security team immediately if violations exceed 10 in an hour.

---

## 9. Rollback {#9-rollback}

### Standard rollback (image or config issue)

```bash
kubectl rollout undo deployment/mcp-server -n mcp-system
kubectl rollout undo deployment/mcp-worker -n mcp-system
kubectl rollout status deployment/mcp-server -n mcp-system
kubectl rollout status deployment/mcp-worker -n mcp-system
```

### Emergency: force-replace all pods

```bash
kubectl rollout restart deployment/mcp-server -n mcp-system
kubectl rollout restart deployment/mcp-worker -n mcp-system
```

### Config-only rollback (revert a ConfigMap change)

```bash
# Re-apply the last known-good kustomization
kubectl apply -k deploy/k8s/overlays/<your-overlay>
# ConfigMap changes do not auto-restart pods; trigger manually:
kubectl rollout restart deployment/mcp-server -n mcp-system
```

### Verify health after rollback

```bash
kubectl get pods -n mcp-system
kubectl rollout status deployment/mcp-server -n mcp-system
# Wait for /readyz to return 200 on all pods:
kubectl exec -n mcp-system deployment/mcp-server -- curl -s http://localhost:3000/readyz
```

---

## Appendix: useful one-liners

```bash
# All metrics for the server
kubectl exec -n mcp-system deployment/mcp-server -- curl -s http://localhost:3000/metrics

# Live pod logs (follow)
kubectl logs -n mcp-system deployment/mcp-server -f

# Current env vars (redacted secrets)
kubectl exec -n mcp-system deployment/mcp-server -- env | grep -v _KEY | sort

# MCP tool call (test web_search from inside cluster)
kubectl exec -n mcp-system deployment/mcp-server -- curl -s -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"test","searchDepth":"fast"}}}' \
  http://localhost:3000/mcp

# Resource usage
kubectl top pods -n mcp-system
```
