# Security Scanning

Four scan types cover the main OWASP risk categories for this codebase. They can be run individually or together as a pipeline.

```
SCA      — npm dependencies: CVEs + licence inventory
SAST     — static code analysis: OWASP Top 10, Node.js patterns
Secrets  — git history + working tree for leaked credentials
DAST     — live HTTP probes: ZAP passive scan + MCP application probes
```

All output goes to `security-reports/` (gitignored — contains raw CVE and credential data).

---

## Prerequisites

| Tool | Required for | Install |
|---|---|---|
| Node.js ≥ 18 | SCA, SAST, secrets, DAST | pre-installed |
| [semgrep](https://semgrep.dev) | SAST | see below |
| [gitleaks](https://github.com/gitleaks/gitleaks) | Secrets scanning | see below |
| [Docker](https://docs.docker.com/get-docker/) | DAST (OWASP ZAP) | install manually |

Install semgrep and gitleaks with the provided script:

```sh
bash scripts/install-security-tools.sh
```

What the script does:
- macOS: installs via `brew` (falls back to `pip3` if Homebrew absent)
- Linux: installs via `pip3` for semgrep; downloads the latest gitleaks binary from GitHub releases
- Pulls `ghcr.io/zaproxy/zaproxy:stable` Docker image (~1 GB)
- Prints a final status table showing which tools are ready

Docker Desktop must be installed and running separately — the script checks it but cannot install it. Download from [docs.docker.com/get-docker](https://docs.docker.com/get-docker/).

### CI install

```sh
bash scripts/install-security-tools.sh --ci
```

`--ci` fails hard if Docker is absent, instead of warning and continuing.

---

## Running scans

### All scans (SCA + SAST + secrets)

```sh
npm run scan
```

Runs SCA, SAST, and secrets detection in sequence. Produces `security-reports/REPORT.md` — a consolidated findings file formatted for agentic review (see [Agentic review](#agentic-review)).

DAST is excluded from `npm run scan` because it requires a running server. Run it separately (see below).

### SCA — Software Composition Analysis

```sh
npm run scan:sca
```

Runs:
1. `npm audit --json` → flags CVEs in production and dev dependencies
2. `npx license-checker --json --production` → inventories all production licences; flags copyleft (GPL, AGPL, LGPL, CC-BY-SA, etc.)

Exits 1 on any `critical` or `high` CVE.

Output: `security-reports/sca-npm-audit.json`, `security-reports/sca-licenses.json`, `security-reports/sca-report.md`

### SAST — Static Application Security Testing

```sh
npm run scan:sast
```

Runs `semgrep` with four rule sets against `src/`:

| Ruleset | What it finds |
|---|---|
| `p/owasp-top-ten` | Injection, XSS, broken auth, sensitive data exposure, XXE, IDOR |
| `p/nodejs` | Prototype pollution, path traversal, `child_process` misuse |
| `p/typescript` | TypeScript-specific unsafe patterns |
| `p/secrets` | Hardcoded credentials, API keys, tokens |

Exits 1 on `ERROR` or `HIGH` severity findings.

**First run**: semgrep downloads rule sets from semgrep.dev (30–120 seconds). Subsequent runs use the local cache.

**CI / no-network**:

```sh
node scripts/scan-sast.mjs --offline
```

`--offline` passes `--disable-version-check` to semgrep and uses only locally cached rules. Requires at least one prior online run.

**Ignore file**: `.semgrepignore` (root of repo) excludes `node_modules/`, `dist/`, `coverage/`, test files, and `scripts/` (the scan scripts themselves contain intentional shell-exec patterns).

Output: `security-reports/sast-semgrep.json`, `security-reports/sast-report.md`

### Secrets detection

```sh
npm run scan:secrets
```

Two layers:
1. **gitleaks** scans the full git history for committed secrets
2. **Custom regex patterns** scan the working tree for common credential shapes: AWS keys, GitHub tokens, Stripe keys, generic `key=` assignments, Bearer tokens, PEM private keys, hardcoded JWTs

Matched values are redacted in output — the report shows which file and line, not the secret itself.

Exits 1 on any finding.

Output: `security-reports/secrets-gitleaks.json`, `security-reports/secrets-custom.json`, `security-reports/secrets-report.md`

### DAST — Dynamic Application Security Testing

```sh
# Start the server first
docker compose up -d

# Then run the scan
npm run scan:dast
```

Or against a k8s deployment:

```sh
kubectl port-forward svc/mcp-server 3000:80 &
npm run scan:dast
```

With a bearer token:

```sh
npm run scan:dast -- --token $MCP_AUTH_TOKEN
```

Against a non-default base URL:

```sh
npm run scan:dast -- --base http://staging.example.com:3000
```

Skip ZAP (MCP application probes only, no Docker required):

```sh
npm run scan:dast -- --skip-zap
```

**DAST is two-layer:**

**Layer 1 — OWASP ZAP baseline scan** (passive)

ZAP spiders the server and runs ~60 passive analysis rules. It detects missing security headers, cookie flag issues, information disclosure, CORS misconfiguration, insecure cache directives, and similar structural issues. The baseline scan sends no attack payloads — it is safe to run against production.

ZAP runs inside Docker. On macOS, Docker Desktop cannot reach `localhost` directly — the script substitutes `host.docker.internal` automatically. On Linux it uses `--network host`.

ZAP takes 2–5 minutes. The HTML report (`security-reports/dast-zap.html`) is human-readable and more detailed than the markdown summary.

**Layer 2 — MCP application probes**

Active HTTP probes specific to the MCP API surface that ZAP cannot discover automatically:

| Probe | What it checks |
|---|---|
| Auth enforcement | `/mcp` rejects unauthenticated POST; `/healthz`/`/readyz` allow unauthenticated GET |
| SSRF via tool arguments | `fetch_url` tool with AWS metadata, GCP metadata, RFC 1918, and link-local targets |
| Injection via tool arguments | XSS, SSTI, command injection, path traversal, null byte, Log4Shell payloads in `web_search` |
| Error disclosure | Stack traces and internal paths in error responses |
| HTTP method enforcement | `GET/PUT/PATCH/DELETE /mcp` rejected |
| CORS misconfiguration | Arbitrary `Origin` header not reflected back |

Exits 1 on `CRITICAL` or `HIGH` findings.

Output: `security-reports/dast-zap.json`, `security-reports/dast-zap.html`, `security-reports/dast-probes.json`, `security-reports/dast-report.md`

#### Active scan (do not run on production)

```sh
npm run scan:dast -- --active
```

Switches ZAP from `zap-baseline.py` (passive) to `zap-full-scan.py` (active). Active mode sends attack payloads — SQL injection, XSS, command injection, etc. Only run against a local or staging deployment you own.

---

## Interpreting reports

Each scan writes a `*-report.md` file structured for both human reading and agentic triage. Findings follow this format:

```
### FINDING: <ID>
Severity: CRITICAL | HIGH | MODERATE | LOW | INFO
File: src/...
Line: N
Description: ...

### VERDICT: CONFIRMED | FALSE_POSITIVE | ACCEPTED_RISK
Reason: ...

### FIX
...

### EFFORT: trivial | hours | days | milestone
```

**Severity guide:**

| Severity | Meaning | Action |
|---|---|---|
| CRITICAL | Actively exploitable with high impact (SSRF to metadata, LFI) | Fix before next deploy |
| HIGH | Serious vulnerability but requires specific conditions | Fix in current sprint |
| MODERATE | Real issue with lower impact or harder exploitation | Fix in next sprint |
| LOW | Defence-in-depth improvement | Address in hardening pass |
| INFO | Informational — no direct risk | Suppress or note |

**Common false positives:**

- SAST `p/secrets` on test fixtures containing dummy credential-shaped strings — verify the value is not a real credential, then add to `.semgrepignore`
- ZAP headers warnings on `/healthz` and `/readyz` which intentionally lack auth — accept risk and document
- gitleaks on committed test fixtures — verify dummy, add to `.gitleaksignore`

---

## CI integration

Add to your pipeline after `npm test`. Scans that require no external process can run unconditionally; DAST requires a live server.

### GitHub Actions example

```yaml
- name: Install security tools
  run: bash scripts/install-security-tools.sh --ci

- name: SCA + SAST + secrets
  run: npm run scan

- name: Upload security reports
  uses: actions/upload-artifact@v4
  if: always()
  with:
    name: security-reports
    path: security-reports/
    retention-days: 30
```

DAST in CI needs the server running in a service container or `docker compose up -d` before the scan step.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean — no findings at or above the fail threshold |
| 1 | Findings at or above the fail threshold (critical/high) |
| 2 | Tool not installed or scan infrastructure error |

---

## Agentic review

`npm run scan` produces `security-reports/REPORT.md` formatted for an LLM to triage. Each finding includes a `VERDICT` and `FIX` block for the agent to fill in, and an `EFFORT` tag so the agent can group by complexity.

To run an agentic review after scans complete:

```sh
npm run scan
# Then feed security-reports/REPORT.md to your agent workflow
# The agent should: read REPORT.md, confirm each finding is real (not false-positive),
# propose a fix, and create a task per confirmed finding ordered by severity.
```

The DAST report is separate (`security-reports/dast-report.md`) and should be included in the agentic pass when DAST was run.

---

## Adding rules

**SAST custom rules** — add a `.semgrep.yml` at the repo root or create `scripts/semgrep-local/`. Then extend `RULESETS` in `scripts/scan-sast.mjs`:

```js
const RULESETS = [
  'p/owasp-top-ten',
  'p/nodejs',
  'p/typescript',
  'p/secrets',
  './scripts/semgrep-local',  // custom rules
];
```

**Secrets custom patterns** — add to the `PATTERNS` array in `scripts/scan-secrets.mjs`.

**DAST probes** — extend the Layer 2 section of `scripts/scan-dast.mjs`. Each probe follows the `probe(method, path, opts)` → `finding()/pass()` pattern.

---

## Tool references

- [Semgrep docs](https://semgrep.dev/docs/)
- [Semgrep rule registry](https://semgrep.dev/r)
- [gitleaks](https://github.com/gitleaks/gitleaks)
- [OWASP ZAP](https://www.zaproxy.org/)
- [ZAP baseline scan](https://www.zaproxy.org/docs/docker/baseline-scan/)
- [ZAP full scan](https://www.zaproxy.org/docs/docker/full-scan/)
