# FSP Deployment Addendum

> **Purpose.** This document is addressed to the compliance, technology-risk, model-risk, and TPRM functions of a regulated South African financial services provider (FSP) supervised by the FSCA.
>
> **What this document is not.** It is not a second POPIA assessment (see `POPIA_ASSESSMENT.md`), not a second Authorisation to Operate (see `PRODUCTION_AUTHORISATION.md`), and not legal advice. It maps FSP-specific obligations and risk frameworks onto the evidence already assembled in this pack, and states plainly what is outside this repository's control.
>
> **Limitation on reliance.** This document summarises controls and gaps. Each FSP's compliance, risk, and legal functions must make their own assessments and sign their own approvals.

---

## 1. TPRM assessment — evidence map

A TPRM function evaluating this system will ask for evidence across several standard domains.  The table below maps each domain to the location in this pack that contains the primary evidence.

| TPRM domain | Where to look in this pack |
|---|---|
| Data classification and handling | `POPIA_ASSESSMENT.md` §2–§5; `DATA_FLOW.md` |
| Privacy / POPI Act compliance | `POPIA_ASSESSMENT.md`; `PRODUCTION_AUTHORISATION.md` §2 (IO series conditions) |
| Security architecture | `THREAT_MODEL.md`; `TRUST_OVERVIEW.md` |
| Vulnerability and patch management | `DEPENDENCY_MANAGEMENT.md`; `docs/security/SECURITY_SCANNING.md` |
| Incident response | `RUNBOOK.md` §10 |
| Business continuity / availability | `SLO.md`; `RUNBOOK.md` |
| Access controls | `THREAT_MODEL.md` §1; `PRODUCTION_AUTHORISATION.md` §3 (PLT-03) |
| Audit and logging | `POPIA_ASSESSMENT.md` §5; `DATA_FLOW.md` |
| Data retention and deletion | `POPIA_ASSESSMENT.md` §4 (s14); `RUNBOOK.md` §10.1 |
| Change management | `PRODUCTION_AUTHORISATION.md` §7 (Revision history); `RUNBOOK.md` §10.5 |
| Ownership and accountability | `OWNERSHIP.md` |
| Subprocessor / cross-border transfers | `POPIA_ASSESSMENT.md` §6 (s72); `DATA_FLOW.md` §4 |
| SLA and performance | `SLO.md` |

---

## 2. FSCA overlay — regulatory context

This system is a developer tool (a web-fetch and search MCP server).  The FSP is the **data controller** under POPIA; this system operates as a data processor when deployed to process information in the FSP's environment.

Obligations specific to FSCA-supervised entities that are **not** POPIA obligations and are **not** addressed inside this repository:

| Obligation | FSP's responsibility |
|---|---|
| FSCA Technology Risk Guidelines (TRG) — material system classification | The FSP must assess whether this system meets the materiality threshold and apply the TRG accordingly. |
| Third-Party Risk Management (TPRM) policy compliance | The FSP's TPRM committee must complete its standard vendor assessment.  This pack is evidence; it does not replace the committee's finding. |
| Model risk management (if applicable) | See §3 below. |
| Conduct standard — fair customer outcomes | The FSP must assess whether the system's outputs influence customer-facing decisions and apply TCF obligations accordingly. |
| POPIA s18 employee notice | A template is provided at §5.  The FSP must issue it, record the method and date, and retain evidence. |
| Incident reporting to FSCA | The FSP's regulatory affairs function determines whether a security or data incident triggers reporting obligations. |

---

## 3. Model-risk positioning

The system includes one statistical component: the reranker (`Xenova/bge-reranker-base`, a cross-encoder).

**Position for a model-risk function:**

- The reranker is a **deterministic cross-encoder** that scores document–query relevance.  It does not generate text, make customer-facing decisions, set prices, approve or decline applications, or produce regulatory output.
- The model reorders search results; it does not select or suppress them.  A lower-ranked result is still returned.
- The model can be disabled entirely (`RERANK_BACKEND=none`) with no change to the system's other functionality.
- Model inputs (query + page excerpt) and outputs (a relevance score) are not retained beyond the request lifecycle.
- The reranker is **not** a generative AI model.  The material distinction for a model-risk function is: this model does not produce free-text output that could constitute advice, guidance, or a recommendation to a customer.

**FSP determination.** Whether this system's outputs are used in any customer-facing or regulatory decision is determined by **how the FSP deploys and integrates it**, not by this repository.  If the FSP's AI agent uses this system's results to produce customer-facing output, the FSP's model-risk governance applies to that agent and the end-to-end pipeline — not only to this component.

**Reranker off.** Set `RERANK_BACKEND=none` to remove the statistical component entirely.  The system degrades gracefully to lexicographic ranking.

---

## 4. Per-caller attribution — capability and ceiling

This system supports optional per-caller attribution via the `x-mcp-caller-id` HTTP header.  Audit events include a 16-hex HMAC of the value (field: `callerHash`).

**What it delivers (POPIA s19 safeguards / s22 accountability):**
- An operator can trace which agent or service invoked which tool, using the hashed value as a correlation key.
- The hash is stable within a process when the same `MCP_CALLER_ID_SALT` is set across replicas, enabling fleet-wide incident attribution.
- `callerHash` appears on every tool-call audit event alongside `requestId`, `tool`, `outcome`, and `piiClasses`.

**The self-asserted ceiling — state plainly:**
- `MCP_AUTH_TOKEN` is a **single shared bearer token**.  Every caller holding the token can send any value in the `x-mcp-caller-id` header, including another caller's value.
- Attribution is **only trustworthy when a trusted upstream gateway sets the header AND strips any client-supplied copy** (e.g. nginx `proxy_set_header X-Mcp-Caller-Id $upstream_identity;` with no `proxy_pass_header` equivalent).
- Without gateway enforcement, this field is an accountability aid, not authenticated identity.

**POPIA s23–25 data-subject rights (IO-03):**
- The caller is the operator invoking the tool.  The data subject is the person whose information appears *inside* a query or a fetched page.  These are different.
- Per-caller attribution does **not** resolve the s23–25 structural gap.  `IO-03` in the ATO remains an accepted limitation.

**Crawl worker:**
- Tool-call audit events (`crawl_start`) carry `callerHash`.  The crawl worker's own events (`job_started`, `job_finished`) are emitted without HTTP context and carry `callerHash: null`.  An audit trail will show attributed tool-call lines followed by anonymous worker lines for the same job.  This is a documented gap, not an oversight.

**Configuration:**

| Variable | Default | Notes |
|---|---|---|
| `MCP_REQUIRE_CALLER_IDENTITY` | `false` | Set `true` only after confirming traffic is sending identity (`caller_identity_total{present="true"}`). |
| `MCP_CALLER_ID_SALT` | per-process random | **Store in Secrets Manager.** Without a shared salt, hashes are uncorrelatable across replicas and restarts. |

---

## 5. DLP — outbound query text

Search queries and fetch URLs leave the deployment environment and reach third-party endpoints (search API providers, web servers).  DLP considerations:

- **Query text is not retained** in the system's own storage beyond the request lifecycle (no query log, no history).
- **Query text is hashed in application logs** (`LOG_REDACT_QUERIES=true`, default).  The hash is an HMAC-SHA-256 of the query text, not the plaintext.
- **The caller controls query content.** If the FSP's agents include personal information in queries (e.g. "find information about John Smith, SA ID 8001015009087"), that information reaches the target URL and any search provider in the fanout.
- **Provider reach.** `DATA_FLOW.md §4` lists all outbound endpoints and their POPIA s72 basis (cross-border transfer).  Tier 1 providers (Brave, Serper) have no data-processing agreement; `POPIA_ASSESSMENT.md §6` assesses this as an accepted gap.
- **Mitigation.** Set `POPIA_MODE=enforce` (default) to block requests where PII is detected in tool arguments.  This cannot detect PII embedded in URLs or fetched from external sources.

---

## 6. POPIA s18 employee notice — template

`PRODUCTION_AUTHORISATION.md` condition `IO-02` requires a POPIA s18 operator notification when the system is used by employees whose activities may be monitored.  The FSP must issue this notice, record the date and method, and retain the record.

The following is a draft template.  The FSP's legal or compliance function must review and approve it before issue.

---

> **Notice in terms of the Protection of Personal Information Act 4 of 2013 (POPIA)**
>
> **To:** [Name of employee / job title / team]
> **From:** [Name of responsible party / department]
> **Date:** [Date of issue]
>
> This notice is given in terms of sections 18 and 19 of the Protection of Personal Information Act 4 of 2013.
>
> **1. System.** [FSP name] has deployed the `markdown-for-agents-mcp` tool-assisted search system (the System) to support [describe use case, e.g. "AI-assisted research and web search activities of the [team name] team"].
>
> **2. Personal information processed.** The System processes:
> - Queries you submit, which may contain personal information if you include it.
> - URLs you request, which may link to pages containing personal information.
> - Audit records including: a timestamp, tool name, request identifier, POPIA enforcement action, and (where configured) a pseudonymous identifier linked to your session.
>
> **3. Purpose of processing.** The personal information is processed for the purpose of providing the web-search and fetch functionality, for POPIA compliance audit in terms of section 22, and for security incident investigation.
>
> **4. Retention.** Audit records are retained for [insert retention period] in accordance with [insert FSP data retention policy reference].  Query text is hashed in application logs and is not stored in plaintext.
>
> **5. Your rights.** You have the right to request access to, or correction of, your personal information as provided in sections 23–25 of POPIA.  Requests should be directed to [insert information officer contact].
>
> **6. Queries.** Contact [insert information officer name and contact details] with any questions about this notice.

---

*Record of issue: Date __________ | Method __________ | Issued by __________*

---

## 7. Conditions outside this repository's control

The following are necessary for an FSP deployment and require FSP action:

1. **TPRM committee sign-off.** This pack is evidence, not a vendor approval.
2. **FSCA technology-risk materiality assessment.** The FSP must determine whether this system is material under its TRG.
3. **`OWNERSHIP.md` placeholder completion.** IO-Owner, Engineering-Owner, and Legal-Review fields must be filled by named FSP individuals before the ATO is valid.  See `PRODUCTION_AUTHORISATION.md` IO-01.
4. **s18 notice issued and dated.** The FSP must issue the §6 template (or its own equivalent), record it, and satisfy IO-02.
5. **Gateway identity enforcement.** If per-caller attribution is required, the FSP's ingress layer must set `x-mcp-caller-id` and strip client-supplied copies.  The code does not substitute for this gateway control.
6. **Credential rotation schedule.** `MCP_AUTH_TOKEN`, `BRAVE_API_KEY`, `SERPER_API_KEY`, and `MCP_CALLER_ID_SALT` require a documented rotation schedule under the FSP's secrets management policy.  See `RUNBOOK.md §10` for the rotation procedure.
7. **Data-processing agreement with search providers.** If Brave or Serper are used, the FSP must assess the s72 cross-border transfer basis and execute or review any required agreement.
8. **Model-risk determination.** The FSP's model-risk function must determine whether the reranker or any downstream use of the system's output falls within model-risk governance scope.
