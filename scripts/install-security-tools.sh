#!/usr/bin/env bash
# Install all tools required for `npm run scan` and `npm run scan:dast`.
#
# Tools installed:
#   semgrep   — SAST (AST-level static analysis, OWASP Top 10 + Node.js rulesets)
#   gitleaks  — Secrets scanning (git history + working tree)
#   Docker    — Required for OWASP ZAP (DAST); not installed by this script
#
# Usage:
#   bash scripts/install-security-tools.sh
#   bash scripts/install-security-tools.sh --ci   # non-interactive, fails on missing Docker

set -euo pipefail

CI_MODE=false
for arg in "$@"; do [[ "$arg" == "--ci" ]] && CI_MODE=true; done

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*"; }

OS="$(uname -s)"
ARCH="$(uname -m)"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Security Tools Installer — markdown-for-agents-mcp"
echo "═══════════════════════════════════════════════════════════"
echo " OS: ${OS} / ${ARCH}"
echo ""

# ── semgrep ───────────────────────────────────────────────────────────────────

echo "── semgrep (SAST) ──────────────────────────────────────────"
if command -v semgrep &>/dev/null; then
  SEMGREP_VER="$(semgrep --version 2>/dev/null | head -1)"
  info "semgrep already installed: ${SEMGREP_VER}"
else
  echo "  Installing semgrep…"
  if [[ "$OS" == "Darwin" ]]; then
    if command -v brew &>/dev/null; then
      brew install semgrep
    else
      warn "Homebrew not found — installing via pip3"
      pip3 install --user semgrep
    fi
  elif [[ "$OS" == "Linux" ]]; then
    if command -v pip3 &>/dev/null; then
      pip3 install --user semgrep
    elif command -v pip &>/dev/null; then
      pip install --user semgrep
    else
      error "pip3 not found. Install Python 3 then run: pip3 install semgrep"
      exit 1
    fi
  else
    warn "Unsupported OS for automatic install. Install semgrep manually: https://semgrep.dev/docs/getting-started"
  fi
  if command -v semgrep &>/dev/null; then
    info "semgrep installed: $(semgrep --version 2>/dev/null | head -1)"
  else
    error "semgrep install failed. Check PATH (pip --user installs to ~/.local/bin on Linux)"
    warn  "Add ~/.local/bin to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
fi

# ── gitleaks ──────────────────────────────────────────────────────────────────

echo ""
echo "── gitleaks (secrets) ──────────────────────────────────────"
if command -v gitleaks &>/dev/null; then
  GITLEAKS_VER="$(gitleaks version 2>/dev/null || echo 'unknown')"
  info "gitleaks already installed: ${GITLEAKS_VER}"
else
  echo "  Installing gitleaks…"
  if [[ "$OS" == "Darwin" ]]; then
    if command -v brew &>/dev/null; then
      brew install gitleaks
    else
      warn "Homebrew not found — downloading binary"
      _install_gitleaks_binary
    fi
  elif [[ "$OS" == "Linux" ]]; then
    # Download latest binary from GitHub releases
    LATEST_TAG="$(curl -fsSL --max-time 10 https://api.github.com/repos/gitleaks/gitleaks/releases/latest \
      | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])" 2>/dev/null || echo "v8.18.4")"
    GITLEAKS_VERSION="${LATEST_TAG#v}"
    if [[ "$ARCH" == "x86_64" ]]; then
      GITLEAKS_ARCH="x64"
    elif [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
      GITLEAKS_ARCH="arm64"
    else
      GITLEAKS_ARCH="x64"
    fi
    TARBALL="gitleaks_${GITLEAKS_VERSION}_linux_${GITLEAKS_ARCH}.tar.gz"
    URL="https://github.com/gitleaks/gitleaks/releases/download/${LATEST_TAG}/${TARBALL}"
    echo "  Downloading ${URL}…"
    curl -fsSL "$URL" | sudo tar -xz -C /usr/local/bin gitleaks
    info "gitleaks ${LATEST_TAG} installed to /usr/local/bin/gitleaks"
  else
    warn "Unsupported OS. Install gitleaks manually: https://github.com/gitleaks/gitleaks#installing"
  fi
  if command -v gitleaks &>/dev/null; then
    info "gitleaks installed: $(gitleaks version 2>/dev/null)"
  else
    error "gitleaks install failed"
  fi
fi

# ── Docker + ZAP image ────────────────────────────────────────────────────────

echo ""
echo "── Docker + OWASP ZAP (DAST) ───────────────────────────────"
if ! command -v docker &>/dev/null; then
  error "Docker not found — required for OWASP ZAP (npm run scan:dast)"
  warn  "Install Docker Desktop: https://docs.docker.com/get-docker/"
  $CI_MODE && exit 1 || true
else
  DOCKER_VER="$(docker --version)"
  info "$DOCKER_VER"

  echo "  Pulling OWASP ZAP stable image (this may take a few minutes)…"
  if docker pull ghcr.io/zaproxy/zaproxy:stable 2>&1 | tail -2; then
    ZAP_VER="$(docker run --rm ghcr.io/zaproxy/zaproxy:stable zap.sh -version 2>/dev/null | head -1 || echo 'unknown')"
    info "ZAP image ready"
  else
    error "Failed to pull ZAP image. Check Docker daemon and network."
    $CI_MODE && exit 1 || true
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Installation complete. Tool status:"
echo "═══════════════════════════════════════════════════════════"
command -v semgrep  &>/dev/null && info "semgrep  → $(semgrep --version 2>/dev/null | head -1)"   || error "semgrep  → NOT FOUND"
command -v gitleaks &>/dev/null && info "gitleaks → $(gitleaks version 2>/dev/null)"               || error "gitleaks → NOT FOUND"
command -v docker   &>/dev/null && info "docker   → $(docker --version)"                           || error "docker   → NOT FOUND (required for DAST)"
echo ""
echo " Run scans:"
echo "   npm run scan             # SCA + SAST + secrets (no server needed)"
echo "   npm run scan:dast        # DAST (requires: docker compose up -d)"
echo ""
echo " See docs/security/SECURITY_SCANNING.md for full documentation."
echo "═══════════════════════════════════════════════════════════"
