# Kubernetes Deployment Guide — markdown-for-agents-mcp

## Contents

1. [Architecture overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Directory structure](#3-directory-structure)
4. [Configuration reference](#4-configuration-reference)
5. [Building and publishing the image](#5-building-and-publishing-the-image)
6. [Deploying with Kustomize](#6-deploying-with-kustomize)
7. [Verifying the deployment](#7-verifying-the-deployment)
8. [Optional: Valkey (shared store)](#8-optional-valkey-shared-store)
9. [Optional: external Redis or Valkey](#9-optional-external-redis-or-valkey)
10. [Secrets management](#10-secrets-management)
11. [Prometheus integration](#11-prometheus-integration)
12. [Autoscaling](#12-autoscaling)
13. [Rolling updates](#13-rolling-updates)
14. [Creating a production overlay](#14-creating-a-production-overlay)
15. [Smoke test suite](#15-smoke-test-suite)
16. [Teardown](#16-teardown)
17. [Troubleshooting](#17-troubleshooting)
18. [Docker Desktop walkthrough](#18-docker-desktop-walkthrough)

---

## 1. Architecture overview

The stack runs as two Deployments of the **same image**, differentiated by role:

```
                          ┌─────────────────────────────────────────────┐
                          │             mcp-system namespace             │
                          │                                              │
  MCP client ──HTTP──▶   │  mcp-server (3 replicas, HPA 3→20)          │
  (AI agent)             │    POST /mcp  — stateless, any replica       │
                          │    GET  /healthz /readyz /metrics            │
                          │           │                                  │
                          │           │ JobQueue (Valkey or SQLite)      │
                          │           ▼                                  │
                          │  mcp-worker (2 replicas, HPA 2→50)          │
                          │    crawl queue consumer                      │
                          │    Playwright (Chromium) rendering           │
                          │                                              │
                          │  valkey (optional component)                 │
                          │    shared rate-limit + cache store           │
                          └─────────────────────────────────────────────┘
```

**Key design properties:**

- **Stateless HTTP transport.** Every POST is self-contained; any replica can serve any request. A plain ClusterIP Service (or ALB) round-robins without session affinity.
- **Two Deployments, one image.** Server pods handle requests. Worker pods consume the crawl queue. Independent HPA on different signals — inflight requests for servers, queue depth for workers.
- **Store is optional.** The default `STORE_BACKEND=sqlite` requires no external service and is safe for a single server replica. Include the `components/valkey` Kustomize component to enable shared rate-limit buckets and the crawl queue across replicas.
- **Prometheus via annotations.** No Prometheus is deployed. Pod annotations (`prometheus.io/scrape`, `prometheus.io/port`, `prometheus.io/path`) enable autodiscovery by any existing cluster Prometheus.

---

## 2. Prerequisites

| Tool | Minimum version | Notes |
|---|---|---|
| `kubectl` | 1.27 | `kubectl version --client` |
| `kustomize` | 5.0 | Built into `kubectl apply -k`; or `kustomize build \| kubectl apply -f -` |
| `metrics-server` | 0.6 | Required for CPU-based HPA. See [§12](#12-autoscaling). |
| Container registry | — | ECR, GCR, Docker Hub, or self-hosted |
| Kubernetes cluster | 1.27 | EKS, GKE, AKS, Docker Desktop, or kind |

The `mcp-system` namespace is created by the manifests. No pre-existing namespace is required.

---

## 3. Directory structure

```
deploy/k8s/
├── base/                       # Cluster-agnostic manifests
│   ├── kustomization.yaml
│   ├── namespace.yaml
│   ├── configmap.yaml          # All non-secret environment variables
│   ├── server.yaml             # mcp-server Deployment + ClusterIP Service
│   ├── worker.yaml             # mcp-worker Deployment
│   ├── pdb.yaml                # PodDisruptionBudget (minAvailable: 2)
│   ├── hpa.yaml                # HPA for both Deployments
│   └── networkpolicy.yaml      # SSRF egress protection
│
├── components/
│   └── valkey/                 # Optional shared store
│       ├── kustomization.yaml  # Component — patches ConfigMap to redis backend
│       └── valkey.yaml         # Valkey Deployment + Service
│
└── overlays/
    └── docker-desktop/         # Local development overlay
        ├── kustomization.yaml
        ├── server-patch.yaml   # replicas: 1, imagePullPolicy: Never
        ├── server-tsc-patch.yaml  # removes topologySpreadConstraints
        ├── worker-patch.yaml
        ├── service-patch.yaml  # ClusterIP → LoadBalancer on port 3000
        ├── hpa-server-patch.yaml
        ├── hpa-worker-patch.yaml
        └── pdb-patch.yaml
```

**Creating your own overlay** — copy `overlays/docker-desktop/` and adjust. The base manifests are not edited directly; all environment-specific changes go into patches.

---

## 4. Configuration reference

All variables are set in `base/configmap.yaml` and overridden in overlay patches. Secrets use a separate `mcp-secrets` Secret (see [§10](#10-secrets-management)).

### Store

| Variable | Default | Description |
|---|---|---|
| `STORE_BACKEND` | `sqlite` | `auto \| memory \| sqlite \| redis`. `sqlite` writes to a temp file per pod (single-replica only). `redis` requires `STORE_REDIS_URL`. |
| `STORE_REDIS_URL` | — | Redis/Valkey URL, e.g. `redis://valkey:6379`. Required when `STORE_BACKEND=redis`. |

### HTTP server

| Variable | Default | Description |
|---|---|---|
| `MCP_HTTP_MODE` | `stateless` | `stateless` — every POST is independent. `session` — server maintains session state (requires sticky routing). Keep `stateless` for multi-replica deployments. |
| `MCP_AUTH_TOKEN` | — | Bearer token for all endpoints. Set via Secret (see §10). Probes `/healthz` and `/readyz` are always unauthenticated. |

### Rendering

| Variable | Default | Description |
|---|---|---|
| `RENDER_MAX_CONCURRENCY` | `8` (server), `16` (worker) | Maximum concurrent Playwright renders per pod. Tune to `(pod memory GiB − 1) × 2`. |
| `BROWSER_POOL_SIZE` | `1` | Number of Chromium browser instances per pod. |
| `LIGHTPANDA_ENABLED` | `false` | Enable Lightpanda as a Tier-2 renderer (requires sidecar). |
| `LIGHTPANDA_CDP_URL` | `ws://127.0.0.1:9222` | CDP endpoint for Lightpanda. |

### Crawling

| Variable | Default | Description |
|---|---|---|
| `CRAWL_MAX_PAGES` | `1000` | Hard page cap per crawl job. |
| `CRAWL_MAX_DEPTH` | `10` | Link-following depth limit. |
| `CRAWL_MAX_CONCURRENCY` | `5` (server), `10` (worker) | Concurrent fetches per crawl job. |

### Rate limiting

| Variable | Default | Description |
|---|---|---|
| `RATE_LIMIT_PER_HOST_RPS` | `2` | Requests per second per target hostname. Shared across replicas when `STORE_BACKEND=redis`. |
| `RATE_LIMIT_BURST` | `5` | Burst allowance above the per-second limit. |

### Drain / shutdown

| Variable | Default | Description |
|---|---|---|
| `SHUTDOWN_DRAIN_MS` | `5000` | Wait after SIGTERM before closing the HTTP server (allows load-balancer Endpoints propagation). |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Grace period for in-flight requests to complete after `httpServer.close()`. |

`terminationGracePeriodSeconds: 90` in the Deployment specs must exceed `SHUTDOWN_DRAIN_MS + SHUTDOWN_TIMEOUT_MS` (35 s default). Do not reduce it below 60 s.

### Search

| Variable | Default | Description |
|---|---|---|
| `SEARCH_FANOUT_RESULTS` | `20` | Max URLs returned from the fan-out across all providers. |
| `SEARCH_DEFAULT_COUNTRY` | `za` | ISO 3166-1 alpha-2 country code injected into every query (e.g. `za` = South Africa). |
| `SEARCH_DEFAULT_LANGUAGE` | `en` | BCP 47 language code for result ranking. |
| `LOG_REDACT_QUERIES` | `true` | Hash query text in logs (POPIA compliance). Set `false` only for debugging — never in production. |
| `SEARXNG_URL` | — | SearXNG instance URL; enables the free Tier-2 search provider. |
| `SEARXNG_ENGINE_PROFILE` | `clean` | `clean` — ToS-safe engines (Mojeek, Marginalia, Brave free, Wikipedia). `full` — adds Google/Bing/DDG; **breaches those engines' ToS** — legal sign-off required before enabling. |
| `SEARCH_CACHE_TTL_MS` | `3600000` | Search result cache TTL (ms; 1 h default). Caches by `(profile, query)` hash via `KeyValueStore`. Reduces engine load and mitigates IP-rate blocks at scale. |

### Reranker

| Variable | Default | Description |
|---|---|---|
| `RERANK_BACKEND` | `none` | `none` — SERP order only. `local` — ONNX cross-encoder in a worker thread (requires optional deps; image must have model baked in). `tei` — remote TEI endpoint. |
| `RERANK_MODEL` | `Xenova/bge-reranker-base` | HuggingFace model ID for `local` backend. |
| `RERANK_DTYPE` | `q8` | Quantisation dtype for ONNX (`q8` required for CPU `onnxruntime-node`). |
| `RERANK_TEI_URL` | — | TEI endpoint URL when `RERANK_BACKEND=tei`. |

When `RERANK_BACKEND=local` the server pod must have the model baked into the image at `$HF_HOME`. If the model is missing at startup the process **fails loudly** rather than silently falling back to SERP order — a degraded-but-passing startup is harder to diagnose than an immediate crash. `/readyz` gates on the reranker reaching ready state, giving the existing 300 s `startupProbe` window for the 280 MB model load.

### Search providers (Secrets)

| Variable | Default | Description |
|---|---|---|
| `BRAVE_API_KEY` | — | Brave Search API key. |
| `SERPER_API_KEY` | — | Serper (Google SERP) API key. |

### Observability

| Variable | Default | Description |
|---|---|---|
| `LOG_FORMAT` | `json` | `json` or `text`. Use `json` in production. |
| `LOG_LEVEL` | `INFO` | `DEBUG \| INFO \| WARN \| ERROR`. |

---

## 5. Building and publishing the image

### Build

```bash
# From the repo root
docker build -t <registry>/markdown-for-agents-mcp:<tag> .
```

The `Dockerfile` uses a multi-stage build:
- **Build stage** — `node:22-bookworm-slim` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, runs `npm ci --ignore-scripts` + `tsc`.
- **Runtime stage** — `mcr.microsoft.com/playwright:v<version>-jammy` (Node 22, Chromium bundled, no root user).

Node 22 is the minimum required version (`engines.node: >=22.0.0`). Do not use Alpine-based images — Playwright cannot drive the musl Chromium binary.

### Push to registry

```bash
docker push <registry>/markdown-for-agents-mcp:<tag>
```

### Update the overlay

In your overlay's `kustomization.yaml`, set the image reference:

```yaml
images:
  - name: markdown-for-agents-mcp:latest
    newName: <registry>/markdown-for-agents-mcp
    newTag: <tag>
```

---

## 6. Deploying with Kustomize

### Create the secrets first

```bash
kubectl create secret generic mcp-secrets \
  --namespace mcp-system \
  --from-literal=MCP_AUTH_TOKEN='<your-token>' \
  --from-literal=BRAVE_API_KEY='<key>' \
  --from-literal=SERPER_API_KEY='<key>' \
  --dry-run=client -o yaml | kubectl apply -f -
```

All three keys are `optional: true` in the Deployment specs — the pods start without them. Set what you have.

### Apply the overlay

```bash
# Preview what will be applied
kubectl kustomize deploy/k8s/overlays/<your-overlay>

# Apply
kubectl apply -k deploy/k8s/overlays/<your-overlay>
```

### Watch rollout

```bash
kubectl rollout status deployment/mcp-server -n mcp-system
kubectl rollout status deployment/mcp-worker -n mcp-system
```

### Verify running state

```bash
kubectl get all -n mcp-system
```

Expected output: `mcp-server` and `mcp-worker` Deployments with all replicas Ready, `valkey` Deployment (if the component is included), Services, HPA, and PDB.

---

## 7. Verifying the deployment

### Health endpoints

```bash
# Port-forward if using ClusterIP
kubectl port-forward svc/mcp-server 3000:80 -n mcp-system &

curl http://localhost:3000/healthz   # process-level: {"status":"ok"}
curl http://localhost:3000/readyz    # deep: includes store and browser pool state
curl http://localhost:3000/metrics   # Prometheus text exposition
```

`/healthz` checks only the Node process. `/readyz` checks that the browser pool is warm and the store (Valkey/SQLite) is reachable. Readiness probes use `/readyz`; liveness probes use `/healthz`. This prevents a store hiccup from restarting healthy pods.

### MCP tool call

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "fetch_url",
      "arguments": { "url": "https://example.com" }
    }
  }' | jq .
```

---

## 8. Optional: Valkey (shared store)

The `components/valkey` Kustomize component adds a Valkey deployment and patches the ConfigMap to `STORE_BACKEND=redis`.

**Valkey** is a BSD-licensed, Redis-compatible in-memory store from the Linux Foundation. It is used instead of Redis to avoid SSPL licensing concerns.

### Why you need it for multi-replica deployments

With the default `STORE_BACKEND=sqlite`, each pod has its own independent rate-limit buckets and cache. Ten replicas each honouring `RATE_LIMIT_PER_HOST_RPS=2` will send up to 20 RPS at a target. Valkey provides a shared token-bucket store so the aggregate rate across all replicas honours the configured limit.

The crawl `JobQueue` also requires a shared store — two worker pods claiming the same URL from separate SQLite files will both fetch it.

### Enable the Valkey component

Add to your overlay's `kustomization.yaml`:

```yaml
components:
  - ../../components/valkey
```

This is already included in the `docker-desktop` overlay.

### Production Valkey

The bundled `components/valkey/valkey.yaml` is a single-replica Deployment with no persistence — suitable for development and single-AZ production where data loss on restart is acceptable (rate-limit buckets and caches rebuild automatically).

For production HA, replace it with the Bitnami Valkey Helm chart:

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm install valkey bitnami/valkey \
  --namespace mcp-system \
  --set replica.replicaCount=2 \
  --set auth.enabled=true \
  --set auth.existingSecret=mcp-secrets \
  --set auth.existingSecretPasswordKey=VALKEY_PASSWORD
```

Then patch the ConfigMap in your overlay:

```yaml
patches:
  - target:
      kind: ConfigMap
      name: mcp-config
    patch: |-
      - op: replace
        path: /data/STORE_REDIS_URL
        value: redis://:$(VALKEY_PASSWORD)@valkey-primary:6379
```

---

## 9. Optional: external Redis or Valkey

To use an existing Redis or Valkey instance instead of the bundled component, patch the ConfigMap in your overlay without including `components/valkey`:

```yaml
# In your overlay's kustomization.yaml — no components/valkey entry
patches:
  - target:
      kind: ConfigMap
      name: mcp-config
    patch: |-
      - op: replace
        path: /data/STORE_BACKEND
        value: redis
      - op: add
        path: /data/STORE_REDIS_URL
        value: redis://<host>:<port>
```

For an authenticated instance, store the URL with credentials in `mcp-secrets` and reference it from the Deployment's `env` block, not the ConfigMap — ConfigMap values are visible in plain text.

---

## 10. Secrets management

The Deployments reference a Secret named `mcp-secrets` in `mcp-system`. All keys are `optional: true`, so the pods start even if the Secret does not exist or a key is absent.

| Key | Used by | Purpose |
|---|---|---|
| `MCP_AUTH_TOKEN` | server | Bearer token for all MCP endpoints |
| `BRAVE_API_KEY` | server | Brave Search API |
| `SERPER_API_KEY` | server | Serper (Google SERP) API |

### Create with kubectl

```bash
kubectl create secret generic mcp-secrets \
  --namespace mcp-system \
  --from-literal=MCP_AUTH_TOKEN='...' \
  --from-literal=BRAVE_API_KEY='...' \
  --from-literal=SERPER_API_KEY='...'
```

### External Secrets Operator (recommended for production)

Rather than managing Secret objects directly, use [External Secrets Operator](https://external-secrets.io) to sync from AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager, or Azure Key Vault:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: mcp-secrets
  namespace: mcp-system
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secretsmanager
    kind: ClusterSecretStore
  target:
    name: mcp-secrets
  data:
    - secretKey: MCP_AUTH_TOKEN
      remoteRef:
        key: /mcp/MCP_AUTH_TOKEN
    - secretKey: BRAVE_API_KEY
      remoteRef:
        key: /mcp/BRAVE_API_KEY
```

**Never store secrets in ConfigMaps or in `kustomization.yaml` literals.** Never commit Secret YAML with real values.

---

## 11. Prometheus integration

No Prometheus is deployed. The server pods expose `/metrics` (Prometheus text format, port 3000) and carry autodiscovery annotations:

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "3000"
  prometheus.io/path: "/metrics"
```

A Prometheus instance with the standard `kubernetes-pods` scrape job picks these up automatically.

### External Prometheus (separate cluster or namespace)

Add a scrape job to your Prometheus configuration:

```yaml
scrape_configs:
  - job_name: markdown-for-agents-mcp
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [mcp-system]
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: "true"
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        target_label: __address__
        regex: (.+)
        replacement: ${1}:3000
```

### Key metrics

| Metric | Type | Description |
|---|---|---|
| `mcp_tool_calls_total{tool,outcome}` | Counter | Completed tool invocations |
| `mcp_tool_duration_seconds{tool}` | Histogram | End-to-end tool call latency |
| `mcp_inflight_requests` | Gauge | Active tool calls (HPA signal for server) |
| `fetch_requests_total{tier,outcome}` | Counter | HTTP fetches by render tier |
| `fetch_duration_seconds{tier}` | Histogram | Fetch latency by tier |
| `fetch_escalations_total{from_tier,to_tier,reason}` | Counter | Render-tier escalations |
| `browser_pool_in_use` | Gauge | Current Chromium pages in use |
| `crawl_queue_depth{job}` | Gauge | Pending crawl items (HPA signal for worker) |
| `crawl_pages_total{job,status}` | Counter | Crawl completions by status |

---

## 12. Autoscaling

### metrics-server

CPU-based HPA requires `metrics-server`. Install it if not already present:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

On clusters with self-signed kubelet certificates (including Docker Desktop), patch the deployment:

```bash
kubectl patch deployment metrics-server \
  --namespace kube-system \
  --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
```

### HPA configuration

**mcp-server HPA** (base)

- Primary signal: `mcp_inflight_requests`, target 6 per pod (requires `prometheus-adapter`)
- Fallback: CPU utilisation 70%
- Min 3 replicas, max 20
- Scale-down stabilisation window: 300 s (retains warm Chromium instances)

**mcp-worker HPA** (base)

- Primary signal: `crawl_queue_depth`, target 50 per pod
- Fallback: CPU utilisation 70%
- Min 2 replicas, max 50

### prometheus-adapter (for custom metrics HPA)

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --set prometheus.url=http://prometheus.monitoring.svc.cluster.local \
  --set rules.default=false \
  --values - <<'EOF'
rules:
  custom:
    - seriesQuery: 'mcp_inflight_requests{namespace="mcp-system"}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
          pod: {resource: "pod"}
      name:
        matches: "mcp_inflight_requests"
      metricsQuery: 'avg(<<.Series>>{<<.LabelMatchers>>})'
    - seriesQuery: 'crawl_queue_depth{namespace="mcp-system"}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
      name:
        matches: "crawl_queue_depth"
      metricsQuery: 'sum(<<.Series>>{<<.LabelMatchers>>})'
EOF
```

Without `prometheus-adapter`, both HPAs fall back to CPU-only scaling, which is less precise for this workload (Chromium spikes CPU during page load, then idles on network waits).

### Check HPA status

```bash
kubectl get hpa -n mcp-system
kubectl describe hpa mcp-server-hpa -n mcp-system
```

---

## 13. Rolling updates

```bash
# Update the image in your overlay's kustomization.yaml, then:
kubectl apply -k deploy/k8s/overlays/<your-overlay>
kubectl rollout status deployment/mcp-server -n mcp-system
```

The Deployments use the default `RollingUpdate` strategy (25% maxUnavailable, 25% maxSurge). The `preStop` hook (`sleep 5`) gives the load balancer time to remove the pod from Endpoints before connections are drained. `terminationGracePeriodSeconds: 90` allows in-flight Playwright renders up to 90 seconds to complete.

To roll back:

```bash
kubectl rollout undo deployment/mcp-server -n mcp-system
kubectl rollout undo deployment/mcp-worker -n mcp-system
```

---

## 14. Creating a production overlay

Copy the docker-desktop overlay as a starting point:

```bash
cp -r deploy/k8s/overlays/docker-desktop deploy/k8s/overlays/prod
```

Minimum changes for production:

**`overlays/prod/kustomization.yaml`**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: mcp-system

resources:
  - ../../base

components:
  - ../../components/valkey   # or remove and configure external Redis

images:
  - name: markdown-for-agents-mcp:latest
    newName: <your-registry>/markdown-for-agents-mcp
    newTag: <release-tag>

patches:
  - path: server-patch.yaml
    target:
      kind: Deployment
      name: mcp-server
  - path: worker-patch.yaml
    target:
      kind: Deployment
      name: mcp-worker
  # Add ingress-patch.yaml for TLS ingress
```

**`overlays/prod/server-patch.yaml`** — adjust resources and replicas:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-server
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: mcp-server
          imagePullPolicy: Always
          resources:
            requests:
              cpu: "1"
              memory: 2Gi
            limits:
              cpu: "2"
              memory: 4Gi
```

**Ingress with TLS** (add `overlays/prod/ingress.yaml` to resources):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mcp-server
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts: [mcp.your-domain.com]
      secretName: mcp-tls
  rules:
    - host: mcp.your-domain.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: mcp-server
                port:
                  name: http
```

**NetworkPolicy enforcement.** The bundled `networkpolicy.yaml` provides SSRF protection only when the CNI enforces NetworkPolicy (Calico, Cilium, or similar). Kindnet (Docker Desktop default) and Flannel do not enforce it. Verify your CNI supports NetworkPolicy before relying on it for egress isolation in production.

---

## 15. Smoke test suite

A comprehensive k8s smoke test suite is included at `scripts/k8s-smoke-tests.mjs`. It runs 13 test suites against a live deployment.

```bash
npm run test:k8s
```

The script auto-detects the service endpoint by probing:
1. The LoadBalancer external IP
2. `localhost:<servicePort>`
3. `localhost:<nodePort>`

It uses the first reachable URL. This makes it work on Docker Desktop (where LoadBalancer IPs are not routable from the Mac host) and cloud clusters alike.

### What is tested

| Suite | What it verifies |
|---|---|
| 1 — Inventory | All expected resources exist in `mcp-system` |
| 2 — Endpoints reachable | `/healthz`, `/readyz`, `/metrics` return 200 |
| 3 — Health probe format | `/healthz` and `/readyz` return valid JSON |
| 4 — Metrics exposition | `/metrics` is Prometheus text format |
| 5 — MCP protocol | `initialize` and `tools/list` return valid JSON-RPC responses |
| 6 — Tool call | `fetch_url` on `https://example.com` returns markdown |
| 7 — Auth enforcement | Requests without a token are rejected (when `MCP_AUTH_TOKEN` is set) |
| 8 — HPA active | Both HPAs show a current replica count |
| 9 — PDB active | PDB shows `minAvailable: 2` |
| 10 — ConfigMap | All expected config keys are present |
| 11 — Stateless | 10 concurrent requests succeed without session affinity |
| 12 — NetworkPolicy | Egress NetworkPolicy exists (enforcement skipped if kindnet detected) |
| 13 — Self-healing | Pod deletion triggers replacement; traffic recovers |

---

## 16. Teardown

```bash
# Delete all resources in the namespace
kubectl delete namespace mcp-system

# Or delete only what Kustomize created (preserves other resources in the namespace)
kubectl delete -k deploy/k8s/overlays/<your-overlay>
```

---

## 17. Troubleshooting

### Pods stuck in `ErrImagePull` or `ErrImageNeverPull`

The image is not available to the container runtime. For cloud clusters, ensure the image is pushed to the registry and the cluster has pull credentials. See §5.

For Docker Desktop, see the [Docker Desktop walkthrough](#18-docker-desktop-walkthrough) — Docker Desktop uses `containerd` separately from the Docker daemon.

### Pods stuck in `Pending`

```bash
kubectl describe pod <pod-name> -n mcp-system
```

Common causes:
- **Insufficient resources.** Base server requests are 1 CPU / 2 Gi per replica (3 replicas = 3 CPU / 6 Gi). Reduce in your overlay if the cluster is small.
- **`topologySpreadConstraints`** requiring multi-zone scheduling on a single-zone cluster. The docker-desktop overlay removes this constraint with a JSON patch. Add the same patch to any single-zone overlay.

### `/readyz` returns 503

The browser pool has not finished warming up, or the store is unreachable. Check:

```bash
kubectl logs deployment/mcp-server -n mcp-system --tail=50
```

- If Valkey is included, ensure the `valkey` pod is Ready before server pods start. The `readinessProbe` on Valkey's `valkey-cli ping` handles ordering automatically.
- The `startupProbe` on `/readyz` allows up to 300 s (30 failures × 10 s) for initial warmup. Do not assume the pod has failed during this window.

### HPA shows `cpu: <unknown>`

`metrics-server` is not installed or not ready. Install it (see §12) and wait 1–2 minutes for metrics to propagate.

### Rate limiting not shared across replicas

`STORE_BACKEND=sqlite` (or `memory`) means each pod has independent rate-limit buckets. Include `components/valkey` or configure `STORE_BACKEND=redis` with an external store.

### NetworkPolicy blocks in-cluster traffic

If pods cannot reach Valkey or each other after applying NetworkPolicy, check that your CNI enforces it. The policy allows all traffic within `mcp-system` namespace explicitly. If you use a managed CNI that adds extra restrictions, add the appropriate allow rules in an overlay patch.

### `kubectl rollout status` hangs

A pod may be stuck in `Terminating` waiting for in-flight requests to drain. Check `SHUTDOWN_DRAIN_MS` + `SHUTDOWN_TIMEOUT_MS` against `terminationGracePeriodSeconds`. The latter must be larger. Under high load, increase `SHUTDOWN_TIMEOUT_MS`.

---

## 18. Docker Desktop walkthrough

Docker Desktop runs its own Kubernetes cluster using `containerd` as the container runtime. This runtime is **separate from the Docker daemon** — images built with `docker build` are not automatically available to the cluster.

### Step 1: Enable Kubernetes

Docker Desktop → Settings → Kubernetes → Enable Kubernetes → Apply.

### Step 2: Build the image

```bash
docker build -t markdown-for-agents-mcp:local .
```

### Step 3: Import the image into containerd

The cluster uses `containerd` in the `k8s.io` namespace. Import the image via a privileged pod:

```bash
# Export the image from Docker
docker save markdown-for-agents-mcp:local -o /tmp/mcp.tar

# Copy into the containerd socket via a privileged pod
kubectl run importer --image=alpine --restart=Never \
  --overrides='{
    "spec": {
      "hostPID": true,
      "containers": [{
        "name": "importer",
        "image": "alpine",
        "command": ["sh","-c","apk add --no-cache containerd-ctr 2>/dev/null; while [ ! -f /import/mcp.tar ]; do sleep 1; done; ctr --namespace k8s.io images import /import/mcp.tar; echo DONE"],
        "securityContext": {"privileged": true},
        "volumeMounts": [
          {"mountPath": "/run/containerd","name": "ctr"},
          {"mountPath": "/import","name": "import"}
        ]
      }],
      "volumes": [
        {"name": "ctr","hostPath": {"path": "/run/containerd"}},
        {"name": "import","hostPath": {"path": "/tmp"}}
      ]
    }
  }'

# Wait for import to complete
kubectl logs -f importer
kubectl delete pod importer
```

### Step 4: Create the namespace (if not already present)

```bash
kubectl create namespace mcp-system --dry-run=client -o yaml | kubectl apply -f -
```

### Step 5: Create secrets

```bash
kubectl create secret generic mcp-secrets \
  --namespace mcp-system \
  --from-literal=MCP_AUTH_TOKEN='dev-token'
```

### Step 6: Apply the overlay

```bash
kubectl apply -k deploy/k8s/overlays/docker-desktop
```

### Step 7: Wait for rollout

```bash
kubectl rollout status deployment/mcp-server -n mcp-system
kubectl rollout status deployment/mcp-worker -n mcp-system
```

### Step 8: Access the service

The docker-desktop overlay sets the Service to `LoadBalancer`. Docker Desktop maps this to `localhost`:

```bash
# The LoadBalancer external IP (e.g. 172.20.x.x) is NOT reachable from the Mac host.
# Use localhost instead.
curl http://localhost:3000/healthz
```

### Step 9: Run the smoke tests

```bash
npm run test:k8s
```

Expected: 67/67 passing.

### Step 10: Tear down

```bash
kubectl delete namespace mcp-system
```

---

## Appendix: Manifest summary

| Resource | Kind | Purpose |
|---|---|---|
| `mcp-system` | Namespace | Isolation boundary for all resources |
| `mcp-config` | ConfigMap | Non-secret environment variables |
| `mcp-secrets` | Secret | Tokens and API keys (created manually) |
| `mcp-server` | Deployment | HTTP + MCP request serving |
| `mcp-server` | Service | ClusterIP (base) / LoadBalancer (docker-desktop) |
| `mcp-worker` | Deployment | Crawl queue consumer |
| `mcp-server-hpa` | HorizontalPodAutoscaler | Server scaling on inflight requests / CPU |
| `mcp-worker-hpa` | HorizontalPodAutoscaler | Worker scaling on queue depth / CPU |
| `mcp-server-pdb` | PodDisruptionBudget | Ensures ≥2 server replicas during node drain |
| `mcp-egress` | NetworkPolicy | Blocks RFC1918 egress; SSRF protection |
| `valkey` | Deployment | In-memory store (via `components/valkey`) |
| `valkey` | Service | Internal `redis://valkey:6379` endpoint |
