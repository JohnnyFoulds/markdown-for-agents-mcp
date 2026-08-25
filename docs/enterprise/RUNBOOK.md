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

The violation counter increments when the `isPrivateIp()` guard fires — either in
the HTTP DNS guard (`stage="dns_guard"`) or in the SOCKS5 CONNECT handler
(`stage="socks5_connect"`). Check which stage to narrow the source.

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

## 10. Security incidents {#10-security-incidents}

This section provides procedures for the three security alerts mandated by the ATO (`PRODUCTION_AUTHORISATION.md` SEC-01 through SEC-03) and for common security response actions.  Each subsection names the metric that triggers it.

---

### 10.1 Retention sweep stalled (SEC-01)

**Alert:** `time() - retention_last_sweep_timestamp_seconds > 7200`
**Metric:** `retention_last_sweep_timestamp_seconds` (`src/obs/metrics.ts`)

The retention sweep that purges records older than `CRAWL_RETENTION_MS` has not run in over 2 hours.  Data that should have been deleted under POPIA s14 may be accumulating.

**Diagnosis:**

```bash
# Check the metric value directly
kubectl exec -n mcp-system deployment/mcp-server -- \
  curl -s http://localhost:3000/metrics | grep retention_last_sweep

# Check for worker errors
kubectl logs -n mcp-system deployment/mcp-worker --since=3h | grep -i "retention\|sweep\|error"

# Confirm worker role
kubectl exec -n mcp-system deployment/mcp-worker -- \
  env | grep MCP_ROLE
```

**Resolution:**

1. If the worker pod is not running or is crash-looping, investigate and restore the worker (`MCP_ROLE=worker` or `both`).
2. If the worker is running but the metric is stale, check the store backend connectivity (`STORE_BACKEND`, `STORE_REDIS_URL`).
3. After restoring, confirm the metric updates within 15 minutes.

**POPIA note.** A stalled sweep may constitute a failure to comply with the s14 storage-limitation obligation.  If the sweep was stalled for more than 24 hours, record the incident and assess whether a breach notification is required.

---

### 10.2 POPIA controls disabled (SEC-02)

**Alert:** `increase(audit_events_total{popia_mode="off"}[5m]) > 0`
**Metric:** `audit_events_total` (`src/obs/metrics.ts`)

`POPIA_MODE=off` has been applied to a running pod, disabling all privacy enforcement.  This alert fires if any audit event is emitted with `popia_mode="off"`.

**Diagnosis:**

```bash
# Confirm current POPIA_MODE in all pods
kubectl get pods -n mcp-system -o name | xargs -I{} \
  kubectl exec -n mcp-system {} -- env | grep POPIA_MODE

# Check recent audit lines for popia_mode=off
kubectl logs -n mcp-system deployment/mcp-server --since=15m | \
  grep '"audit":true' | grep '"popiaMode":"off"'
```

**Resolution:**

1. Immediately restore `POPIA_MODE=enforce` (or `monitor`) — do not leave `off` in production.

   ```bash
   # Hot-patch via ConfigMap (requires git reconciliation — see §10.5)
   kubectl patch configmap mcp-config -n mcp-system \
     --type=merge -p '{"data":{"POPIA_MODE":"enforce"}}'
   kubectl rollout restart deployment/mcp-server -n mcp-system
   kubectl rollout restart deployment/mcp-worker -n mcp-system
   ```

2. Determine who set `POPIA_MODE=off` and when (check change-management records, `RUNBOOK.md §9`, git history).
3. Assess whether data processed during the `off` window requires breach assessment under POPIA s22.

---

### 10.3 PII scan truncation spike (SEC-03)

**Alert:** `pii_scan_truncated_total` counter advancing unexpectedly
**Metric:** `pii_scan_truncated_total` (`src/obs/metrics.ts`)

Tool arguments exceed the 8 KB scan cap.  Content beyond 8 KB is forwarded to external services **without PII scanning**.  In `enforce` mode, large arguments are partially scanned; PII in the tail may egress unchecked.

**Diagnosis:**

```bash
kubectl exec -n mcp-system deployment/mcp-server -- \
  curl -s http://localhost:3000/metrics | grep pii_scan_truncated

# Which tools are producing large arguments?
kubectl logs -n mcp-system deployment/mcp-server --since=1h | \
  grep '"audit":true' | jq -r '.tool' | sort | uniq -c | sort -rn
```

**Resolution:**

1. If the spike is a client sending unexpectedly large queries, work with the client operator to reduce payload size.
2. If the spike is legitimate (large batch operations), assess whether to raise the 8 KB cap (source: `src/server/registry.ts`).  A higher cap increases PII detection coverage but also increases scan duration and memory pressure.
3. If PII may have egressed without detection, raise a breach assessment.

---

### 10.4 Credential rotation

The following credentials require a documented rotation schedule under the FSP's secrets management policy.

**`MCP_AUTH_TOKEN` (bearer token for all HTTP clients)**

```bash
# Generate a new token (or use Secrets Manager to generate and store)
NEW_TOKEN=$(openssl rand -hex 32)

# Update the Kubernetes Secret
kubectl create secret generic mcp-secrets -n mcp-system \
  --from-literal=MCP_AUTH_TOKEN="$NEW_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart the server to pick up the new token
kubectl rollout restart deployment/mcp-server -n mcp-system
```

After rotation, all clients must be updated with the new token before the old one is invalidated.  Coordinate with all consumers before restarting.

**`BRAVE_API_KEY` / `SERPER_API_KEY`**

Rotate in the provider console, then update the Kubernetes Secret and restart.  Both providers allow a brief overlap period — activate the new key before invalidating the old one.

**`MCP_CALLER_ID_SALT`**

Rotating this salt invalidates all existing `callerHash` values in the audit trail — they will no longer match a re-hash of the same identity.  Coordinate with the security/audit team before rotating.  If audit-trail continuity is required across the rotation, archive the audit logs with the old-salt timestamp before applying the new salt.

---

### 10.5 Emergency change control

An emergency `kubectl set env` or `kubectl patch configmap` applied to a running pod bypasses the standard PR process.  Any such change must be reconciled back into git within one business day.

**Record-keeping checklist:**

- [ ] Incident ticket created with: symptom, time of change, exact command run, operator name.
- [ ] Change applied and verified (rollout status, `/readyz` green on all pods).
- [ ] Git commit raised with the equivalent change to `deploy/k8s/base/configmap.yaml` (or overlay).
- [ ] PR reviewed and merged before next scheduled maintenance window.

---

### 10.6 Post-incident evidence preservation

```bash
# Capture all current metrics before a pod restart
kubectl exec -n mcp-system deployment/mcp-server -- \
  curl -s http://localhost:3000/metrics > incident-metrics-$(date +%Y%m%d-%H%M%S).txt

# Capture pod logs (all containers, all pods in the namespace)
kubectl logs -n mcp-system -l app=mcp-server --all-containers > incident-server-logs-$(date +%Y%m%d).txt
kubectl logs -n mcp-system -l app=mcp-worker --all-containers > incident-worker-logs-$(date +%Y%m%d).txt

# Capture current ConfigMap (evidence of config state at incident time)
kubectl get configmap mcp-config -n mcp-system -o yaml > incident-configmap-$(date +%Y%m%d).yaml
```

Retain these artefacts in accordance with the FSP's incident-management and POPIA s22 evidence-retention policies.

---

### Quick-reference: security alert → runbook section

| Alert condition | Metric | Section |
|---|---|---|
| `time() - retention_last_sweep_timestamp_seconds > 7200` | `retention_last_sweep_timestamp_seconds` | §10.1 |
| `increase(audit_events_total{popia_mode="off"}[5m]) > 0` | `audit_events_total` | §10.2 |
| `pii_scan_truncated_total` advancing unexpectedly | `pii_scan_truncated_total` | §10.3 |

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
