#!/usr/bin/env bash
# Run the full test suite with a live Valkey instance in Kubernetes.
#
# Lifecycle:
#   1. Create namespace mcp-test
#   2. Deploy Valkey from deploy/k8s/components/valkey/valkey.yaml
#   3. Wait for pod ready
#   4. Port-forward 6379 → localhost:6379
#   5. npm test (all tests, including Redis contract suite)
#   6. Tear down namespace and kill port-forward (runs even on failure)
#
# Prerequisites: kubectl pointing at a reachable cluster (e.g. Docker Desktop k8s)
# Usage: bash scripts/test-with-valkey.sh

set -euo pipefail

NAMESPACE="mcp-test"
PF_PID=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VALKEY_MANIFEST="$REPO_ROOT/deploy/k8s/components/valkey/valkey.yaml"

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

echo "==> Creating namespace $NAMESPACE"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

echo "==> Deploying Valkey"
kubectl apply -n "$NAMESPACE" -f "$VALKEY_MANIFEST"

echo "==> Waiting for Valkey pod to be ready (up to 90s)"
kubectl rollout status deployment/valkey -n "$NAMESPACE" --timeout=90s

echo "==> Port-forwarding localhost:6379 → valkey:6379"
kubectl port-forward -n "$NAMESPACE" svc/valkey 6379:6379 &
PF_PID=$!

# Give the port-forward a moment to establish
sleep 2

# Verify the forward is alive
if ! kill -0 "$PF_PID" 2>/dev/null; then
  echo "ERROR: port-forward exited immediately — is port 6379 already in use?"
  exit 1
fi

echo "==> Running test suite with REDIS_URL=redis://localhost:6379"
cd "$REPO_ROOT"
REDIS_URL="redis://localhost:6379" npm test

TEST_EXIT=$?
echo "==> Tests finished (exit $TEST_EXIT)"
exit $TEST_EXIT
