# POPIA Assessment — markdown-for-agents-mcp

**Act:** Protection of Personal Information Act 4 of 2013 (POPIA), South Africa  
**Date of assessment:** 2026-08-24  
**Assessed by:** [ASSESSOR_NAME] — update before submission  
**Scope:** MCP server and worker as deployed via `deploy/k8s/` in the Vodacom environment

---

## Summary

| Condition | Status | Notes |
|---|---|---|
| Lawful processing | ✓ Compliant | Processing is for legitimate business purpose (internal AI tooling) |
| Purpose specification | ✓ Compliant | Query text used only to execute the search; not retained |
| Further processing limitation | ✓ Compliant | No secondary use of query data |
| Information quality | N/A | No personal records maintained |
| Openness | ✓ Compliant | This document is the disclosure |
| Security safeguards | ✓ Compliant with caveats | See §5 |
| Data subject participation | N/A | No identifiable data subjects |
| Trans-border flow | ⚠ Requires sign-off | See §6 |

---

## 1. What personal information is processed?

**Query text may constitute personal information** under POPIA s1 (definition of
"personal information") if the query contains names, identification numbers, or other
information that could identify a natural person.

This is a theoretical risk, not a systemic one. The tool is an internal AI search
assistant; queries are expected to be research queries, not personal records. However,
the system cannot distinguish between "best practices for kubernetes" and "John Smith
employee number 12345" — both are treated identically.

**No other personal information is processed.** There is no user profile, no session
identity, no IP address stored, and no browsing history.

---

## 2. Lawful basis for processing (POPIA s11)

**Legitimate interests of the responsible party (Vodacom)** — POPIA s11(1)(f):
providing an internal AI search capability to improve employee productivity. The
processing is proportionate: query text is used to execute the search and is not
retained beyond the request lifecycle.

Alternatively: **consent of the data subject** — employees using an internal tool
operated by their employer under normal employment terms.

---

## 3. Purpose specification and further processing (POPIA s13–15)

**Specified purpose:** Execute a web search on behalf of an internal AI agent.

**No further processing:** Query text is:
1. Hashed (first 16 hex chars of SHA-256) for the cache key — the original is not
   recoverable from the cache
2. Potentially forwarded to a search provider API (Brave, Serper, SearXNG) — see §6
3. Discarded after the response is returned

Query text is **not** stored in logs (at INFO/WARN/ERROR levels), not written to any
database, and not used for analytics or model training.

---

## 4. Retention (POPIA s14)

| Data | Retention period |
|---|---|
| Search result cache | `SEARCH_CACHE_TTL_MS` (default: 1 hour) |
| Application logs | Per Vodacom log retention policy (not set by this system) |
| Crawl job records | Until job is processed (minutes to hours) |

There is no long-term retention of query text, fetched content, or any data that could
be linked to a natural person.

---

## 5. Security safeguards (POPIA s19)

**Technical measures:**

- TLS for all external API calls
- `LOG_REDACT_QUERIES=true` (default): query text hashed/truncated at DEBUG level
- API keys stored as Kubernetes Secrets, not in ConfigMaps or logs
- Bearer token authentication for the MCP endpoint
- Container runs as non-root (`pwuser`, UID 1000)

**Organisational measures:**

- Access to the `mcp-secrets` Kubernetes Secret should be restricted via RBAC to the
  deployment pipeline and named operators (see `docs/enterprise/OWNERSHIP.md`)
- Log access should follow Vodacom's existing log access controls

**Caveat — SSRF and NetworkPolicy:**
See `docs/enterprise/THREAT_MODEL.md §3`. On clusters without Calico or Cilium, the
NetworkPolicy SSRF guard is inert. This is a security gap that must be assessed against
Vodacom's cluster CNI choice before production sign-off.

---

## 6. Trans-border information flows (POPIA s72)

When paid providers are active, query strings are sent outside South Africa:

| Provider | Destination country | Basis for transfer |
|---|---|---|
| Brave Search API | United States | Contractual terms — Brave's API terms include data processing obligations |
| Serper | United States | Contractual terms — Serper's API terms |
| SearXNG upstreams (clean profile) | Varies by engine | See `docs/enterprise/TERMS_OF_SERVICE.md` |

**With no paid keys and `SEARXNG_ENGINE_PROFILE=clean`:** Query strings leave the
cluster to SearXNG's upstream engines (Mojeek, Marginalia, Brave free endpoint,
Wikipedia). Mojeek and Marginalia are UK-based; Brave is US-based; Wikipedia is US-based.

**Assessment:** Transfer to countries without adequate POPIA-equivalent protection
(including the US) requires one of the lawful bases in POPIA s72(1):
- Consent (employee using internal tooling)
- Necessary for contract performance
- Contractual clauses providing adequate protection (Brave, Serper API agreements)

Vodacom's legal team should confirm which basis applies for the specific provider mix
before production deployment in a regulated context.

---

## 7. Data subject rights (POPIA Part 3)

No individual data subject can currently exercise rights over query data because:
1. Query text is not stored by the system (no records to produce, correct, or delete)
2. There is no mechanism to link a query to an individual (no user identity in the system)

If queries were stored (e.g., in logs), a data subject request would require searching
log aggregator infrastructure. Confirm with the log team whether query text appears in
any aggregated logs.

---

## 8. Operator vs responsible party

| Party | Role | Obligation |
|---|---|---|
| Vodacom | Responsible party | Defines purpose, controls deployment |
| Brave / Serper | Operator (when keys set) | Processes query strings per API agreement |
| SearXNG upstream engines | Sub-operator | Query forwarded by SearXNG; consent via engine ToS |

Vodacom is the responsible party. The paid API providers act as operators under Vodacom's
direction. Standard operator agreements (POPIA s20-21) must be confirmed for Brave and
Serper before those keys are activated in a regulated deployment.

---

## 9. Items requiring legal sign-off before production

- [ ] Confirm lawful basis for trans-border transfer (POPIA s72) for each active provider
- [ ] Confirm Brave Search API and Serper API agreements constitute adequate data
      processing agreements under POPIA
- [ ] Confirm Vodacom's log retention policy covers query text retention (even hashed)
- [ ] Confirm CNI choice (Calico/Cilium) for SSRF NetworkPolicy enforcement
- [ ] Internal disclosure to employees that an AI search tool processes query strings
      through external APIs (openness principle — POPIA s18)
