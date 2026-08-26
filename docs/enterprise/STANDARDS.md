# Conformance Register — markdown-for-agents-mcp

> **How to use this document.**
> Claims here are graded, not a badge list. A standards claim is a claim like any
> other and gets the same evidentiary treatment: every Grade A row names the test
> that demonstrates it. `src/standards.test.ts` asserts that every cited test name
> exists and every cited file path resolves; the register cannot silently drift ahead
> of the code.
>
> **For marketing copy:** cite the grade, never the bare standard number. "Implements
> RFC 1928/1929 SOCKS5 with authentication" is defensible. "RFC 9309 compliant" is
> not while the default is `RESPECT_ROBOTS_TXT=false`.

---

## Grade A — Implemented and tested in this repository

Every row names its test. `src/standards.test.ts` verifies each entry is still true.

| Standard | Source | Test file | Test name |
|---|---|---|---|
| **RFC 1928** SOCKS5 proxy protocol | `src/proxy/socks5Server.ts` | `src/proxy/socks5Server.test.ts` | `SOCKS5 greeting / method negotiation` |
| **RFC 1929** SOCKS5 username/password authentication | `src/proxy/socks5Server.ts` | `src/proxy/socks5Server.test.ts` | `RFC 1929 userpass authentication` |
| **RFC 1918 / 3927 / 4193** private, link-local, and ULA address blocking | `src/utils/domainBlacklist.ts` | `src/utils/domainBlacklist.test.ts` | `should block 10.x.x.x RFC1918 addresses` |
| **RFC 9111** HTTP shared-cache — §3 storability, §3.5 `Authorization`, §4.1 `Vary`, §4.2 freshness | `src/http/cachePolicy.ts` | `src/http/cachePolicy.test.ts` | `cachePolicy.isStorable — RFC 9111 §3 / §3.5` |

---

## Grade B — Inherited from a dependency

Conformance holds because the named dependency implements the standard. A major-version
upgrade of that dependency can change behaviour silently; we have no clause-level tests
of our own.

| Standard | Dependency | Notes |
|---|---|---|
| **RFC 9110 / 9112** HTTP/1.1 semantics | `undici` ^8 | All outbound requests via `src/http/client.ts` |
| **RFC 9309** Robots Exclusion Protocol (parsing) | `robots-parser` ^3 | See Grade C for default and §2.3.1.4 deviation |
| **MCP** Model Context Protocol + **JSON-RPC 2.0** | `@modelcontextprotocol/sdk` ^1.29 | All tool registration and dispatch |
| **Prometheus** text exposition format | `prom-client` ^15 | Metrics endpoint at `/metrics` |
| **Sitemaps 0.9** | Grade B via `src/services/mapSite.ts` | Fetches and parses `sitemap.xml`; no independent clause tests |

---

## Grade C — Supported but not conformant by default

These entries are here because omitting them would make this document a false-confidence
artefact. Each deviation is a decision, not an oversight.

| Standard | Gap | Resolution |
|---|---|---|
| **RFC 9309** §2 — crawl rules | `RESPECT_ROBOTS_TXT` defaults to `false`; robots.txt is fetched but not honoured out of the box. Changing this default silently would break crawl-heavy use cases. | Set `RESPECT_ROBOTS_TXT=true` to opt in. |
| **RFC 9309** §2.3.1.4 — unreachable robots.txt | Code previously hardcoded 5xx → allow, where the RFC says SHOULD assume complete disallow. | Resolved in Phase 7: `ROBOTS_ON_ERROR=deny` now reaches the RFC-recommended behaviour. Default is `allow` (preserves prior behaviour). |
| **RFC 9111** §4.3 — conditional revalidation (`ETag`/`If-None-Match`) | Not implemented. A freshness optimisation, not a confidentiality control; out of scope for the POPIA remediation. | Document gap; revisit if cache hit-rate becomes a concern. |
| **HSTS / CSP / X-Frame-Options** | Deliberately omitted. The MCP server is not a browser-facing application. | See `docs/enterprise/THREAT_MODEL.md §2` for rationale. |
| **TLS intercept** | `SOCKS5_LISTEN_MODE=intercept` implements TLS MITM but is deliberately not the default (`tunnel`). Intercept mode requires an operator-supplied CA and creates a POPIA s20/21 processing obligation. | See `docs/enterprise/POPIA_ASSESSMENT.md §8`. |

---

## Process standards

These are followed by convention and CI enforcement, not by RFC number.

| Standard | Where enforced |
|---|---|
| Conventional Commits | PR title lint, `CHANGELOG.md` |
| Semantic Versioning | `package.json`, `CHANGELOG.md` |
| Keep a Changelog | `CHANGELOG.md` |
| Your organisation's internal engineering standards | `src/` via `process/spec-driven-development.md` §5–6 (RED before GREEN) |

---

## POPIA graded by section

See `docs/enterprise/POPIA_ASSESSMENT.md` for the full assessment. Summary of
controls implemented in this repository:

| POPIA section | Control | Status |
|---|---|---|
| s10 minimality | Dead fields (`JobSpec.query`, `relevanceThreshold`) removed | ✓ Phase 0 |
| s14 retention | `CRAWL_RETENTION_MS` sweep; `retention_last_sweep_timestamp_seconds` metric | ✓ Phase 2 |
| s19 security safeguards | RFC 9111 shared-cache; `DOWNLOAD_DIR_ALLOWLIST`; `allowRemoteModels:false` | ✓ Phase 1, 3 |
| s19 — log redaction | Per-process HMAC salt; `redactUrl()`/`redactHeaders()`; `scrubSensitiveKeys()` | ✓ Phase 5 |
| s22 audit | `emitAudit()` to stderr bypassing LOG_LEVEL/LOG_FORMAT; `audit_events_total` metric | ✓ Phase 4 |
| s72 trans-border | `SEARCH_ENABLE_DUCKDUCKGO` gate; s72 basis documented per provider | ✓ Phase 3 |
| s105(4) defence | PII detection (SA ID, MSISDN, PAN); `POPIA_MODE=enforce` blocks on detection | ✓ Phase 6 |
| s105(5) email | Email detected but not auto-blocked — **legal sign-off required** | ⚠ Phase 6 open item |
| s23–25 subject rights | Caller attribution available (`callerHash`) but data-subject identity is structural gap; the caller is not the data subject | ✗ Structural gap — deferred |

---

## Remaining ceilings

These are stated rather than claimed away:

1. **Detection is heuristic, not comprehensive.** Free-text names, addresses, and employee numbers are false negatives. See `src/privacy/detect.test.ts` (documented false-negative test).
2. **`POPIA_MODE=off` is one ConfigMap edit.** Anyone with namespace edit access can flip it. Startup warning and metric label are signals, not locks.
3. **Audit durability is at-most-once.** Pod OOMKill mid-buffer, log rotation before ship, shipper backpressure — any can lose events. Durability belongs to the cluster log pipeline.
4. **s72 is documented, not enforced.** Cross-border transfers still happen by default (Brave, Serper require API keys set). The assessment records the lawful basis.
5. **Chromium egress is unguarded.** `page.goto` in the Playwright tier bypasses `validateUrl`, `dnsGuard`, and the rate limiter.
6. **Grade B conformance is not our conformance.** A CVE or behaviour change in `undici`, `robots-parser`, or the MCP SDK can change what we deliver against the cited standard.
7. **This register is a snapshot.** `src/standards.test.ts` catches broken test references; it does not detect new deviations introduced by later changes.
