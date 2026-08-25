#!/usr/bin/env bash
# Full-stack DAST: build image → deploy to k8s (mcp-dast namespace) → run scan → tear down.
#
# Lifecycle:
#   1. Build Docker image tagged markdown-for-agents-mcp:dast-local
#   2. Create namespace mcp-dast
#   3. Apply deploy/k8s/overlays/dast-local (server + Valkey, no worker/HPA/PDB)
#   4. Wait for Valkey and mcp-server rollouts
#   5. Port-forward svc/mcp-server 3000:80
#   6. Poll /readyz until 200
#   7. node scripts/scan-dast.mjs --base http://localhost:3000 --token dast-test-token
#   8. Tear down namespace and kill port-forward (runs even on failure)
#
# Prerequisites:
#   - Docker Desktop with Kubernetes enabled (kubectl pointing at desktop-control-plane)
#   - Docker daemon running (for image build and ZAP container)
#   - Port 3000 free on localhost
#
# Usage:
#   bash scripts/dast-k8s.sh
#   bash scripts/dast-k8s.sh --skip-zap    # MCP probes only, no Docker ZAP container
#   bash scripts/dast-k8s.sh --active       # ZAP active scan (DO NOT run on production)

set -euo pipefail

NAMESPACE="mcp-dast"
DAST_TOKEN="dast-test-token"
IMAGE_TAG="dast-local"
# Docker Desktop's k8s node runs as a Docker container named desktop-control-plane.
# docker exec + ctr lets us import images directly into the k8s.io containerd
# namespace, bypassing Docker Desktop's registry mirror proxy entirely.
K8S_NODE_CONTAINER="desktop-control-plane"
K8S_IMAGE_REF="docker.io/library/markdown-for-agents-mcp:${IMAGE_TAG}"
PF_PID=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Pass any extra flags (--skip-zap, --active) straight through to scan-dast.mjs
EXTRA_FLAGS=("$@")

cleanup() {
  echo ""
  echo "==> Tearing down namespace $NAMESPACE"
  if [[ -n "$PF_PID" ]] && kill -0 "$PF_PID" 2>/dev/null; then
    kill "$PF_PID" 2>/dev/null || true
  fi
  kubectl delete namespace "$NAMESPACE" --ignore-not-found --wait=false 2>/dev/null || true
  echo "==> Done."
}
trap cleanup EXIT

# ── 1. Build image ────────────────────────────────────────────────────────────
echo "==> Building markdown-for-agents-mcp:$IMAGE_TAG"
docker build -t "markdown-for-agents-mcp:$IMAGE_TAG" "$REPO_ROOT"

# ── 2. Import image into the k8s node's containerd (k8s.io namespace) ────────
# Docker Desktop's k8s node is a Docker container — ctr is available inside it.
# This bypasses Docker Desktop's registry-mirror proxy (which intercepts all
# registry pulls and cannot forward requests to a local registry).
echo "==> Importing image into k8s.io containerd namespace via docker exec"
docker save "markdown-for-agents-mcp:$IMAGE_TAG" | \
  docker exec -i "$K8S_NODE_CONTAINER" ctr -n k8s.io images import --digests -

# ── 2. Create namespace ───────────────────────────────────────────────────────
echo "==> Creating namespace $NAMESPACE"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# ── 3. Apply overlay ──────────────────────────────────────────────────────────
echo "==> Applying DAST overlay"
kubectl apply -k "$REPO_ROOT/deploy/k8s/overlays/dast-local"

# ── 4. Wait for rollouts ──────────────────────────────────────────────────────
echo "==> Waiting for Valkey (up to 90s)"
kubectl rollout status deployment/valkey -n "$NAMESPACE" --timeout=90s

echo "==> Waiting for mcp-server (up to 180s — includes Playwright install)"
kubectl rollout status deployment/mcp-server -n "$NAMESPACE" --timeout=180s

echo "==> Waiting for mcp-worker (up to 180s)"
kubectl rollout status deployment/mcp-worker -n "$NAMESPACE" --timeout=180s

# ── 5. Port-forward ───────────────────────────────────────────────────────────
echo "==> Port-forwarding localhost:3000 → svc/mcp-server:80"
kubectl port-forward -n "$NAMESPACE" svc/mcp-server 3000:80 &
PF_PID=$!
sleep 2

if ! kill -0 "$PF_PID" 2>/dev/null; then
  echo "ERROR: port-forward exited immediately — is port 3000 already in use?"
  exit 1
fi

# ── 6. Poll /readyz ───────────────────────────────────────────────────────────
echo "==> Waiting for /readyz (up to 60s)"
for i in $(seq 1 60); do
  if curl -sf http://localhost:3000/readyz > /dev/null 2>&1; then
    echo "==> Server ready after ${i}s"
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "ERROR: /readyz never returned 200 after 60s"
    kubectl logs -n "$NAMESPACE" -l app=mcp-server --tail=30
    exit 1
  fi
  sleep 1
done

# ── 7. Run DAST ───────────────────────────────────────────────────────────────
echo "==> Running DAST scan"
cd "$REPO_ROOT"
node scripts/scan-dast.mjs \
  --base http://localhost:3000 \
  --token "$DAST_TOKEN" \
  "${EXTRA_FLAGS[@]}"

DAST_EXIT=$?
echo "==> DAST finished (exit $DAST_EXIT)"
exit $DAST_EXIT
