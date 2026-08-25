# Dependency and Vulnerability Management

> **Scope.** This document records the controls in place for third-party dependency management, states the remediation SLA policy, and identifies structural gaps that are not claimed away.
>
> The **security scanning suite** — npm audit, SAST, secrets, licence checks — is documented in full at [`docs/security/SECURITY_SCANNING.md`](../security/SECURITY_SCANNING.md). Read that document for tool configuration, output format, and the rationale for each check. This document adds only what is genuinely policy: the SLA table and the exception process.

---

## 1. Automated controls

| Control | Tool | Trigger | Coverage |
|---|---|---|---|
| Dependency version bumps | Dependabot | Weekly (Monday) | npm packages, GitHub Actions, Docker base image |
| Vulnerability audit | `npm audit --audit-level=moderate` | Every push/PR to `main` and `development` | npm dependency tree |
| SCA report | `scripts/scan-sca.mjs` | Same CI job | npm + licence check; report uploaded as `security-reports/` artifact (30-day retention) |
| SAST | Semgrep + project rules | Same CI job | Source code, custom invariants in `security/semgrep/` |
| Secrets | gitleaks + custom scanner | Same CI job | Git history and working tree |

Dependabot configuration: `.github/dependabot.yml` — npm (open-PR limit 5, dev-deps grouped), GitHub Actions (limit 5), Docker (limit 3).

### 1.1 Effective CI threshold — authoritative

`npm audit --audit-level=moderate` runs first in the `security` CI job.  **Any vulnerability at MODERATE severity or above fails the build** and blocks merge to `main` and `development`.

`scan-sca.mjs` exits 1 on critical or high only (MODERATE is included in the report but does not cause a second exit code).  The binding gate is therefore `npm audit`, not `scan-sca.mjs`.

**Two documentation sources previously overstated or understated this:** `OWNERSHIP.md` said "high/critical blocks the merge" (understated — MODERATE also blocks); `SECURITY_SCANNING.md` listed MODERATE as "fix in next sprint" (overstated permissiveness — MODERATE fails CI). Those documents have been corrected. This section is the authoritative statement.

---

## 2. Remediation SLA

| CVSS band | Dependabot / CI behaviour | Remediation target |
|---|---|---|
| Critical (9.0–10.0) | CI fails; Dependabot raises PR immediately | Fix or accept within **2 business days** |
| High (7.0–8.9) | CI fails; Dependabot raises PR | Fix or accept within **5 business days** |
| Moderate (4.0–6.9) | CI fails (see §1.1) | Fix or accept within **14 calendar days** |
| Low (0.1–3.9) | Reported, does not fail CI | Fix at next planned maintenance cycle |
| Info | Informational only | No remediation required |

"Fix" means: update to a non-vulnerable version, or vendor a patched copy.  "Accept" means: complete the exception process (§3).

---

## 3. Exception process — un-fixable CVEs

Some CVEs have no upstream fix at the time of discovery (zero-day, dependency chain gap, or disputed upstream).  The process is:

1. **Document** the CVE, affected package, and assessed exploitability in the `docs/enterprise/PRODUCTION_AUTHORISATION.md` §6 risk register.
2. **Mitigate** at the configuration or network level where possible (e.g. block the affected code path, restrict inbound/outbound reach).
3. **Review** at the next planned sprint; if upstream has not patched within 30 days, evaluate a fork or replacement dependency.
4. **Re-assess** at every Dependabot bump cycle until the CVE is resolved.

Accepted exceptions must be noted in the ATO risk register to maintain ATO validity.

---

## 4. Grade B dependency inventory

Grade B conformance means this system's compliance with a published standard depends on a dependency's correct implementation.  A major-version upgrade of a Grade B dependency can silently change what this system delivers against the cited standard.  See `docs/enterprise/STANDARDS.md §3` for the full definition.

| Dependency | Version constraint | What depends on it | Major-version upgrade risk |
|---|---|---|---|
| `undici` | `^8` | RFC 9110/9112 HTTP/1.1 semantics — all outbound requests via `src/http/client.ts` | HTTP/1.1 behaviour changes, new `fetch()` deviation from spec |
| `robots-parser` | `^3` | RFC 9309 Robots Exclusion Protocol parsing — `src/fetcher.ts` | Parsing of edge-case `Disallow`/`Allow` directives |
| `@modelcontextprotocol/sdk` | `^1` | MCP wire protocol, tool-call dispatch, `extra.requestInfo` per-POST attribution | Protocol version bump may change `extra` shape; ALS verification above would need re-running |
| `prom-client` | `^15` | Prometheus text exposition format — `/metrics` endpoint | Label-name escaping, histogram bucket format |

**`@modelcontextprotocol/sdk` note.** Per-caller attribution (`src/server/registry.ts`) relies on `extra.requestInfo.headers` being built per-POST at `webStandardStreamableHttp.js:388`.  This is supported public API (`RequestInfo` in `types.d.ts`), but a major-version bump should trigger a re-run of the concurrent-callers verification established during the Phase A design review.

---

## 5. No SBOM generated

No Software Bill of Materials (SBOM) in CycloneDX or SPDX format is generated as part of the build or release process.  Claiming one would be false.

`npm ls --json` produces a dependency tree but is not a standards-compliant SBOM.  If a TPRM function requires a CycloneDX SBOM, it must be generated as an additional artefact — e.g. using `@cyclonedx/cyclonedx-npm` — and is not covered by current CI.

---

## 6. Out of scope

- **SBOM generation.** Not present; see §5.
- **Container image scanning.** Docker layer scanning (e.g. Trivy, Snyk container) is not in the current CI pipeline.  The Playwright base image (`mcr.microsoft.com/playwright`) is updated by Dependabot on a weekly schedule, which surfaces known CVEs as PRs, but no layer-level scan runs on the built image.
- **Runtime dependency pinning.** `package-lock.json` is committed and used in CI (`npm ci`), which provides reproducibility but not runtime attestation.
