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
| Node.js ≥ 22 | SCA, SAST, secrets, DAST | pre-installed |
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

**Ignore file**: `.semgrepignore` (root of repo) excludes `node_modules/`, `dist/`, `coverage/`, test files, and the specific scan scripts (`scripts/scan-*.mjs`, `scripts/security-scan.mjs`, `scripts/install-security-tools.sh`). `scripts/install-playwright.js` is intentionally NOT excluded — it ships in the published package as the `postinstall` hook and must remain under SAST coverage. Rule fixtures in `security/semgrep/fixtures/` are also excluded (they contain intentional violations).

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

Active HTTP probes specific to the MCP JSON-RPC surface that ZAP cannot discover automatically. **Note on ZAP's boundary:** ZAP does not speak JSON-RPC; `zap-api-scan.py` consumes OpenAPI/SOAP/GraphQL, none of which MCP is. ZAP's role is the HTTP envelope only (headers, TLS, CORS, cache directives, info disclosure). Layer 2 is the application-layer engine.

Probes are **generated automatically from the live `tools/list` response** — every tool returned by the server is probed according to its parameter types. A coverage gate exits the scan with code 2 if any tool has zero generated probes. This prevents the false-confidence failure where a new tool is silently unprobed.

| Probe category | Tools covered | Payload class |
|---|---|---|
| SSRF | fetch_url, fetch_urls, extract_urls, map_site, download_file, crawl_site, crawl_start | AWS/GCP metadata, RFC1918, link-local, file://, gopher:// |
| Path traversal / arbitrary write | download_file.outputPath | /etc/passwd, /app/dist/index.js, relative traversal, null byte |
| Header injection (CRLF) | fetch_url.headers, fetch_urls.headers | CRLF injection, forwarded Authorization, Host override |
| Injection | web_search.query, crawl_start.query, crawl_{status,results,cancel}.jobId | XSS, SSTI, command, path traversal, null byte, Log4Shell |
| Auth enforcement | /mcp (all methods) | Unauthenticated request with token set → 401 |
| Error disclosure | /mcp (malformed body) | Stack traces and internal paths in error responses |
| HTTP method enforcement | /mcp | GET/PUT/PATCH rejected; DELETE → 200 (correct: session teardown) |
| CORS misconfiguration | /mcp | Arbitrary Origin header not reflected back |

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
| MODERATE | Real issue with lower impact or harder exploitation | **Blocks CI** (see note below); fix or accept within 14 calendar days |
| LOW | Defence-in-depth improvement | Address in hardening pass |
| INFO | Informational — no direct risk | Suppress or note |

> **CI gate note.** `npm audit --audit-level=moderate` is the binding CI gate — it fails the `security` job for MODERATE and above. `scan-sca.mjs` runs in the same job but exits 1 only on critical/high. The "fix in next sprint" guidance above was incorrect; see `docs/enterprise/DEPENDENCY_MANAGEMENT.md §1.1` for the authoritative statement.

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

**SAST custom rules** — add YAML rule files to `security/semgrep/`. They are already in `RULESETS` in `scripts/scan-sast.mjs`. Each rule **must** ship with a positive fixture (code that should fire) and a negative fixture (correct code that should not fire) in `security/semgrep/fixtures/`. Verify with `semgrep --test security/semgrep/`.

The five project invariants in `security/semgrep/project-invariants.yaml` are:
1. `no-process-env-outside-config` — all env reads must go through `src/config.ts`
2. `shell-injection-interpolation` — `execSync()` with non-literal argument
3. `no-direct-fetch-bypass-guard` — direct `fetch()` in tools/services bypasses SSRF guard
4. `sensitive-var-in-console-log` — query/token/key/secret in raw `console.log`
5. `no-security-headers-in-writehead` — security headers in `res.writeHead()` override `applyBaseHeaders()`

**Secrets custom patterns** — add to the `PATTERNS` array in `scripts/scan-secrets.mjs`.

**DAST probes** — probes are **generated automatically** from the live `tools/list` response (Phase 4.1). Do NOT hand-extend the probe list. Instead:
- To add probes for a **new parameter name**: add a `classifyParam` case in `buildProbesForTool()` in `scripts/scan-dast.mjs`
- To add probes for a **new payload class**: add a payload constant (e.g. `NEW_PAYLOADS`) and handle the class in `evaluateProbeResponse()`
- To whitelist a **no-attack-surface tool**: add it to `NO_ATTACK_SURFACE_TOOLS` in both `scripts/scan-dast.mjs` and `src/tools/definitions.test.ts`

The coverage gate automatically fails the scan when a new tool appears in `tools/list` with no probe mapping. The vitest contract test in `src/tools/definitions.test.ts` catches the same gap at build time.

---

## Tool references

- [Semgrep docs](https://semgrep.dev/docs/)
- [Semgrep rule registry](https://semgrep.dev/r)
- [gitleaks](https://github.com/gitleaks/gitleaks)
- [OWASP ZAP](https://www.zaproxy.org/)
- [ZAP baseline scan](https://www.zaproxy.org/docs/docker/baseline-scan/)
- [ZAP full scan](https://www.zaproxy.org/docs/docker/full-scan/)
