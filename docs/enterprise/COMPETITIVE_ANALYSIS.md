# Competitive Analysis: markdown-for-agents-mcp

**Prepared:** August 2026 · **Scope:** Web fetch/search MCP layer and enterprise knowledge index (Phase 2)

---

## Executive Summary

No single product does what this one does — and that is not a gap in the research; it is the finding.

The market splits cleanly across two layers: *web fetch/search* tools that give AI agents internet access, and *enterprise knowledge index* tools that give AI agents access to internal corporate knowledge. Every major player serves one or the other. This project addresses both in a unified MCP server — web intelligence today, knowledge index in Phase 2 — and does so as a self-hosted, MIT-licensed, 7-dependency service deployable inside the operator's infrastructure perimeter.

The closest competitors each solve part of this picture:

- **Glean** and **Microsoft 365 Copilot** are the enterprise knowledge leaders, but both are cloud SaaS products with no self-hosted option and no SA data residency without significant Azure configuration.
- **Onyx (formerly Danswer)** is the strongest open-source enterprise search competitor: MIT-licensed, 50+ connectors, permission-aware ACL, and its own MCP server. But it ships as a 6-service Docker Compose stack (16 GB RAM minimum) and is a full *user-facing application*, not infrastructure.
- **Airweave** is an open-source context retrieval layer with an MCP server and 50+ connectors, but it is cloud-first with no published self-hosted pricing.
- **Firecrawl** is the closest web crawl/extract competitor but is AGPL-licensed, requires 6–7 services, and has no MCP server of its own.
- **SearXNG, DuckDuckGo MCP, Tavily, Brave, Jina, Exa** are the web search layer — all either cloud-only SaaS or metasearch only (no fetch/extract, no MCP-native interface).

The combination of *agent-native MCP design + self-hosted SA deployment + single-service footprint + MIT licence + Phase 2 knowledge index* is genuinely unoccupied. The only credible POPIA-clean path that competes on all four dimensions is "deploy Onyx on OpenShift and add its MCP server" — but that requires 16 GB RAM, a full application team, and produces a user-facing search UI, not infrastructure.

---

## Market Landscape

### Layer 1 — Web Fetch / Search

These tools give AI agents access to the public internet.

| Tool | Type | Self-hostable | MCP-native | SA data residency | Fetch + Extract | Price |
|---|---|:---:|:---:|:---:|:---:|---|
| **Tavily** | Cloud SaaS | No | Yes (cloud-hosted) | No | Yes | $0.005/credit (Growth) |
| **Firecrawl** | Cloud SaaS + OSS | Yes (AGPL, 7 services) | No | Yes (self-hosted) | Yes | $83/mo std, $333/mo growth |
| **Brave Search API** | Cloud SaaS | No | Community | No | No (search only) | $0.005/query |
| **Jina AI** | Cloud SaaS | No | Yes (cloud-hosted) | No | Yes | Usage-based |
| **Exa** | Cloud SaaS | No | Yes (cloud-hosted) | No | Yes | Usage-based |
| **SearXNG** | OSS metasearch | Yes (single service) | Community | Yes | No (search only) | Free |
| **DuckDuckGo MCP** | Cloud search | No | Yes (cloud-hosted) | No | No | Free (no DPA) |
| **markdown-for-agents-mcp** | OSS | Yes (3 services) | Yes (first-class) | Yes | Yes (3-tier render) | Infrastructure only |

**Key gap:** No existing self-hosted MCP server combines web search *and* full-page fetch/extract with a documented POPIA posture. SearXNG is the closest self-hostable search option, but it has no fetch capability, no MCP server, and no extraction pipeline.

### Layer 2 — Enterprise Knowledge Index

These tools give AI agents access to internal corporate documents.

| Tool | Type | Self-hostable | MCP server | SA data residency | Multi-source ACL | Approx. cost |
|---|---|:---:|:---:|:---:|:---:|---|
| **Glean** | Cloud SaaS | No | Yes (endpoint) | No | Yes (275+ connectors) | ~$50–75/user/mo; min ~$60k/yr |
| **Microsoft 365 Copilot** | Cloud SaaS | No (Azure BYO possible) | Via Graph API | **Yes (SA North)** | Yes (delegated) | ~$30/user/mo add-on |
| **Onyx (Danswer)** | OSS (MIT) | Yes (Docker Compose) | Yes (first-class) | Yes (self-hosted) | Yes (source-mirrored) | Free CE; Enterprise tier |
| **Airweave** | OSS (GitHub) | Yes | Yes (v0.5.7 Streamable HTTP) | Yes (self-hosted) | Partial | Cloud: usage-based; self-host: unpublished |
| **AnythingLLM** | OSS | Yes (Docker) | No | Yes (self-hosted) | Workspace-level only | Free / cloud tier |
| **PrivateGPT** | OSS | Yes (Python) | No | Yes (self-hosted) | No | Free |
| **markdown-for-agents-mcp Phase 2** | OSS (MIT) | Yes (OpenShift) | Yes (same server) | Yes (self-hosted) | Yes (Entra `transitiveMemberOf`) | Infrastructure only |

---

## Competitor Deep-Dives

### Glean

**What it is:** The premium enterprise Work AI platform. Combines enterprise search, AI assistant, agent builder, and 275+ connectors (including MCP-based ones). Enforces source-system ACLs at retrieval time across all connected systems. Has a documented MCP endpoint.

**Why enterprises buy it:** Fragmented SaaS knowledge, permission-sensitive content, employees needing one answer layer across Slack, Drive, Confluence, Jira, Salesforce. The developer platform lets Claude Code, Cursor, and other MCP hosts call Glean as a grounding source.

**The blocker for a POPIA-strict SA enterprise:** Glean is cloud SaaS only — no self-hosted deployment option exists. Enterprise contracts start at ~$60 000/year (100 seats minimum at ~$50–75/user/month). At 500 users this is R14–17 million/year at current exchange rates. There is no SA data residency commitment — Glean's infrastructure is US/EU. POPIA Section 72's cross-border transfer prohibition makes this a legal risk for any workload involving personal information, which in a consumer-facing enterprise includes most of them.

**Bottom line:** Best-in-class for knowledge search, unusable for POPIA-strict deployments, and priced for organisations where $300k+/year is a rounding error.

---

### Microsoft 365 Copilot + Copilot Studio

**What it is:** Microsoft Copilot is an umbrella over six products — M365 Copilot in Word/Outlook, Copilot Studio for custom agents, GitHub Copilot, Power Platform Copilot, Dynamics 365, and Copilot Chat. The underlying inference is Azure OpenAI.

**Critical finding:** Microsoft is the **only major LLM vendor with a South Africa inference region**. The `southafricanorth` (Johannesburg) Azure region hosts Azure OpenAI with GPT-4o and embedding models. OpenAI direct, Anthropic, and Google Gemini have no SA inference region as of August 2026. AWS Bedrock has af-south-1 but frontier Claude models route via cross-region inference, leaving SA.

**The POPIA-clean Microsoft path:**
1. *M365 Copilot with SA Geo* — set tenant `preferredDataLocation: ZAF`; grounding data (SharePoint, OneDrive, Teams) stays at rest in SA Geo. LLM compute still runs in Microsoft's global pool — the asterisk for SARB-strict workloads.
2. *Copilot Studio + BYO Azure OpenAI in SA North* — custom agents in Copilot Studio pinned to a customer-owned Azure OpenAI resource in southafricanorth. Prompts, completions, tool-call traces, and conversation history all sit on infrastructure the customer controls. This is the defensible path for SARB Directive 6 and POPIA s.26 (special personal information).

**SharePoint / Entra integration:** The official Microsoft 365 connector for Claude uses delegated Graph permissions — Claude can search SharePoint and read documents as the signed-in user, respecting existing ACLs without privilege escalation. Read-only posture. Data stays in the Microsoft tenant.

**The limitations:**
- Requires full M365 ecosystem buy-in. Not available to organisations on Google Workspace, on-premise, or mixed-cloud stacks.
- Copilot Studio + BYO Azure OpenAI requires Azure engineering to configure and maintain.
- Reasoning models (o3, o1) still route outside SA as of 2026.
- Not a self-hosted MCP server — it is a Microsoft-managed SaaS product with an MCP connector.
- Cost: ~$30/user/month Copilot add-on on top of existing M365 E3/E5 licensing.

**Strategic implication for this project:** Microsoft is the only vendor that credibly competes on SA data residency for enterprise knowledge. If the operator's agent platform is deeply embedded in Azure / M365, the Microsoft path is the honest alternative to evaluate. If it is on OpenShift/AWS, or if the agents need SharePoint+Confluence+web in a unified interface, Microsoft's solution does not close the gap.

---

### Onyx (formerly Danswer)

**What it is:** MIT-licensed open-source enterprise AI search platform. ~30k GitHub stars. Combines agentic RAG, hybrid vector+keyword search, 50+ connectors, and a first-class MCP server. The Community Edition is free; Enterprise Edition adds SCIM, advanced analytics, and whitelabelling.

**Capabilities:**
- Permission-aware ACL via source-system mirroring: users only see RAG results from documents they can access in the source system (Google Drive, Confluence, Jira, Slack, etc.)
- MCP server: exposes the Onyx knowledge base, web search (Serper/Brave/SearXNG), and document management as MCP tools. Any MCP-compatible client (Claude Desktop, Claude Code, Cursor, Windsurf) can query it.
- Deep research: multi-step research flows, topped public benchmarks. Web search via Serper, Brave, SearXNG.
- Any LLM: OpenAI, Anthropic, Gemini, or self-hosted Ollama/vLLM. Hybrid setups supported.
- Air-gapped deployment option.

**Why Onyx is the most formidable open-source competitor:**
It ships a web fetch + enterprise knowledge + MCP server all in one. That is the Phase 2 target in a single open-source package. If the question is "can we just deploy Onyx instead?", the honest answer deserves care.

**The honest gap between Onyx and this project:**

| Dimension | Onyx | markdown-for-agents-mcp |
|---|---|---|
| Primary interface | User-facing chat UI (application) | MCP server (infrastructure) |
| Deployment footprint | 16 GB RAM, 6+ Docker services (vector DB, Redis, MinIO, indexing workers, web server, model containers) | 3 services, ~2 GB RAM |
| Licence | MIT (Community Edition) | MIT |
| Web crawl/extract | Built-in crawler + web search | Three-tier render ladder (HTTP → Lightpanda → Playwright), configurable providers |
| ACL enforcement | Source-system permission mirroring | Phase 2: Entra `transitiveMemberOf` query-time enforcement (Pattern C) |
| POPIA posture | Depends on deployment; fully self-hostable | Fully self-hostable; zero external calls in clean profile |
| MCP server | Yes (add-on to the application) | Yes (core interface; everything is MCP) |
| Governance pack | Enterprise Edition (paid) | POPIA_ASSESSMENT, THREAT_MODEL, DATA_FLOW, PRODUCTION_AUTHORISATION |
| Cost floor | $48–74/mo VM + 16 GB RAM | $48–74/mo VM + 2 GB RAM |

**Bottom line:** Onyx is a complete enterprise application. This project is infrastructure. The right mental model is not "Onyx vs. this" but "Onyx is what you deploy when you need a user-facing enterprise search application; this is what you deploy when your agent platform needs a tool to call". They serve different roles in the stack. An enterprise agent platform could plausibly use *both* — Onyx as the knowledge application for users, and this as the MCP tool for agents running on the platform.

---

### Airweave

**What it is:** Open-source context retrieval layer for AI agents and RAG pipelines. Connects to 50+ data sources (including SharePoint, Confluence, Slack, Notion, GitHub, Stripe, and more), syncs continuously, and exposes a unified LLM-friendly search interface. Ships an MCP server (v0.5.7, Streamable HTTP transport, stateless) at `mcp.airweave.ai` and as a self-hosted option.

**Key differentiator:** Airweave is positioned as *shared retrieval infrastructure*, not a user-facing application. That framing is the closest to what Phase 2 of this project is. The MCP server exposes collections as searchable tools — agents call `search()` against a named collection the same way they would call this project's `search_knowledge()`.

**Limitations:**
- Cloud-first: pricing page returns 404 as of August 2026; self-hosted cost/support is unpublished.
- No web fetch/crawl layer: Airweave handles internal sources, not the live web. Agents need a separate tool for public internet access.
- ACL enforcement: described as "Airweave connects to apps and syncs their data" — the permission model is collection-level, not query-time user token enforcement per the Entra `transitiveMemberOf` pattern. Adequate for some use cases; insufficient for SharePoint libraries with per-document ACLs.
- Relatively early-stage: v0.5.7 MCP server, limited enterprise track record.

**Strategic implication:** Airweave is the closest architectural analogue to Phase 2 (a retrieval infrastructure layer with MCP). Its existence validates the approach. But it does not cover the web fetch layer, and its ACL story for enterprise SharePoint is weaker.

---

### Firecrawl

**What it is:** Cloud SaaS + AGPL-3.0 open-source web crawl and extract platform. The closest competitor on the fetch/extract side. Used by many agent frameworks as the "turn any URL into LLM-ready markdown" service.

**Limitations vs. this project:**
- AGPL-3.0: viral licence; any modification or service offering must be open-sourced under AGPL. Not acceptable for some enterprise legal teams. This project is MIT.
- 6–7 services: API + workers + Playwright + Redis + RabbitMQ + PostgreSQL + optional FoundationDB. No persistent volumes defined by default. Unauthenticated by default.
- No MCP server: agents call the Firecrawl HTTP API directly; no standard MCP interface.
- No search layer: Firecrawl does crawl/extract only, not search. Agents need a separate search tool.
- No internal knowledge source: web only.

**Cost context (from the project's existing cost model):**
- Firecrawl Standard: $83/mo for 100k pages/month.
- At the `$100/mo ongoing` infrastructure floor of this project, Mode G becomes cheaper above ~100k pages/month.
- At the amortised `$527/mo` figure (including engineering), break-even against Firecrawl Scale ($599/mo for 1M pages) is ~1M pages/month.

---

## Where This Project Wins

### 1. POPIA Section 72 compliance, by design

Every cloud SaaS competitor in this space — Glean, Tavily, Firecrawl cloud, Brave, Exa, Jina, Airweave cloud — fails POPIA Section 72's cross-border transfer prohibition for personal information. They are US- or EU-hosted with no SA data residency guarantee. Self-hosted deployment eliminates the cross-border question entirely. This is not a marketing claim — it is an architectural fact. See [POPIA_ASSESSMENT.md](POPIA_ASSESSMENT.md) for the full analysis.

Microsoft Copilot is the only cloud competitor with a credible SA data residency path (via Azure southafricanorth), but it requires full M365 ecosystem investment and is not an MCP server.

### 2. Agent-native design — it is infrastructure, not an application

Glean, Onyx, AnythingLLM all have user-facing web UIs as their primary interface. Their MCP servers are add-ons or afterthoughts. This project has *no UI* — it exposes `fetch()`, `search()`, and (Phase 2) `search_knowledge()` as MCP tools. An AI agent calls them directly, mid-reasoning. The design philosophy aligns with how LLMs actually use tools.

### 3. MIT licence + 7 runtime dependencies

| Competitor | Licence | Services | Runtime deps |
|---|---|---|---|
| Firecrawl | AGPL-3.0 | 6–7 | Many |
| Onyx | MIT (CE) | 6+ | Many |
| Airweave | Apache-2.0 | Multi | Many |
| **markdown-for-agents-mcp** | **MIT** | **3** | **7** |

Fewer services means fewer attack surfaces, cheaper infrastructure, simpler security review, and a smaller change-approval package for a regulated enterprise.

### 4. Three-tier render ladder — Playwright as a last resort, not a default

SearXNG returns metasearch results only. Firecrawl uses Playwright for all renders. This project's heuristic escalation ladder (HTTP → Lightpanda → Playwright) means the majority of fetches never touch a Chromium instance. At scale, this is a real cost and latency advantage. The tier memoisation (5% decay) learns which sites need heavy rendering and promotes/demotes automatically.

### 5. Unified web + enterprise interface — Phase 2

When `search_knowledge()` lands, a single MCP tool call will return results from both the live web and the enterprise knowledge index. An agent doesn't need to choose or route — the server handles it. No competitor today ships this combination in a self-hosted, sub-4-service footprint.

### 6. Governance pack

This project ships documented security, privacy, threat model, and production authorisation artefacts that enterprise security teams can evaluate without a sales process. Glean's governance requires an enterprise contract. Onyx's is in the paid Enterprise Edition. This is available today, for free, in the repository.

---

## Where Competitors Win (Honest Assessment)

### Microsoft 365 Copilot wins if:
- The operator's agent platform is built on Azure/M365.
- The workload requires only SharePoint + OneDrive + Teams + Outlook (no Confluence, no public web, no external connectors).
- The "Copilot Studio + BYO Azure OpenAI SA North" pattern has been validated with the InfoSec and Legal teams.
- At ~$30/user/month at scale, cost per user is reasonable for large M365 footprints.

### Glean wins if:
- The operator can accept US/EU data processing (i.e., the personal information concern is manageable via DPA, or the workload avoids s.26 special personal information).
- 275 connectors, enterprise governance, and managed SaaS operations are worth $300k+/year.
- The enterprise knowledge search surface needs to be user-facing (people searching, not agents calling).

### Onyx wins if:
- The primary need is a user-facing enterprise search application (employees asking questions, not agents calling tools).
- 16 GB RAM and a Docker Compose stack are acceptable on OpenShift.
- The team can operate 6 services and wants the full application layer (personas, agents, deep research, UI).

### Firecrawl wins if:
- The only need is web crawl/extract at high volume (>1M pages/month).
- AGPL licence is acceptable.
- A managed SaaS with uptime guarantees is preferred over self-hosting.

---

## Competitive Position: Summary Matrix

| Criterion | Glean | M365 Copilot | Onyx | Airweave | Firecrawl | **This project** |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Self-hostable | ✗ | Partial | ✓ | ✓ | ✓ | ✓ |
| SA data residency (inherent) | ✗ | Partial | ✓ | ✓ | ✓ | ✓ |
| MCP server (first-class) | Partial | ✗ | ✓ | ✓ | ✗ | ✓ |
| Web fetch + extract | ✗ | ✗ | Partial | ✗ | ✓ | ✓ |
| Enterprise knowledge index | ✓ | ✓ | ✓ | ✓ | ✗ | Phase 2 |
| Per-user ACL at query time | ✓ | ✓ | ✓ | Partial | N/A | Phase 2 |
| MIT licence | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ |
| Sub-4-service deployment | ✗ | N/A | ✗ | ✗ | ✗ | ✓ |
| Governance pack (open) | ✗ | ✗ | Partial | ✗ | ✗ | ✓ |
| Cost floor | ~$60k/yr | ~$30/user/mo | ~$74/mo VM | Unpublished | $83/mo | ~$74/mo VM |

---

## Strategic Recommendations

### Strategic anchor: lead with the knowledge index

The enterprise knowledge index is the right conversation anchor. The market research confirms:

1. **Nothing self-hosted achieves the full combination.** Self-hosted + MCP-native + multi-source (SharePoint + Confluence + web) + per-user ACL + POPIA residency + MIT licence + sub-4-service footprint is unoccupied.

2. **Microsoft is the only competitor with SA inference.** If the operator is deep in Azure/M365, this is worth explicitly scoping. The question is: does the agent platform call an MCP tool, or does it use Copilot Studio? These are different architectural choices.

3. **Onyx is the credible open-source alternative** — but it is an *application*, not *infrastructure*. If the platform team wants a user-facing enterprise search tool alongside the agent infrastructure, Onyx is worth evaluating in parallel rather than instead.

4. **Phase 2 is the differentiator** — the web fetch/search layer is real value today, but the enterprise knowledge index is what makes this system unique in the market. The `search_knowledge()` tool call, backed by a BM25+vector index with Entra ID ACL enforcement, is something no other self-hosted MCP server offers.

### For the Week 1–2 decisions

The competitive research reinforces two early architectural decisions:

- **Confirm OpenShift as deployment target**: OpenShift is the right platform for the 3-service footprint. Onyx would need a 16 GB VM; this needs 2–4 GB. The smaller footprint makes the change-approval path shorter.
- **Initiate the Microsoft Graph app registration**: The Entra ID delegated permission model (required for per-user ACL enforcement in Phase 2) is the same model Microsoft uses for its own official SharePoint connector. Starting the app registration now unblocks the path to Phase 2 without committing to its full scope.

---

## Research Caveats

- Glean pricing is sales-led; the $50–75/user/month figure is from third-party estimate aggregators (CostBench, GoSearch, ToolRadar), not published by Glean. Verified against multiple sources; confidence: medium.
- Airweave pricing page was unavailable (404) as of August 2026. Self-hosted licensing terms not confirmed.
- Microsoft's SA inference region (`southafricanorth`) availability verified against know.2nth.ai (updated April 2026) and Microsoft's official November 2025 announcement. Reasoning model availability in region not confirmed — standard models only.
- Onyx MCP server capabilities verified against official Onyx documentation and GitHub repository. Enterprise Edition pricing not published.

---

*Sources: aipedia.wiki/tools/glean (verified 2026-06-25), know.2nth.ai/explainers/tech/microsoft/copilot-sa (updated April 2026), skiln.co SharePoint MCP guide (2026-06-28), privateaiguide.com private document AI comparison (2026-05-25), mcpfind.org internal docs MCP comparison, airweave.ai (August 2026), onyx-dot-app/onyx GitHub (August 2026), mcp.directory best web search MCP servers (2026).*
