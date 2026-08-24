# Enterprise Readiness Assessment

> **Status: pre-production.** The code is production-quality. The deployment has not
> yet been stood up, SLO numbers have not been measured, and the governance checklist
> is not fully signed off. This document is honest about the gap between "the code
> works" and "this is ready for a governance board."

---

## Would an enterprise like Vodacom use this?

It depends on which team is asking and what they are comparing it to.

---

## Where the answer is yes

A platform or AI engineering team that already runs Kubernetes and owns their own
LLM pipeline would find this compelling on four dimensions:

**Data sovereignty.** Every query stays inside the cluster. With the `clean` engine
profile and no paid API keys, the only outbound traffic is SearXNG's upstream search
requests and standard HTTP GETs to result URLs. No query text reaches a US SaaS
data processor. For a telco handling customer data under POPIA, this is a substantive
compliance argument, not a marketing claim. See `docs/enterprise/DATA_FLOW.md`.

**Zero per-query cost.** At 10 000 searches per day, Tavily costs roughly R650 000
per year at ~$0.01/search. This tool's marginal cost is compute — which the platform
team already pays for.

**Compliance posture.** The governance pack is complete: POPIA assessment, data flow
inventory, threat model with honest ceilings, terms-of-service analysis per engine
profile, runbook, and SLO template. Most open-source tools ship none of this. A
security or legal reviewer can read everything they need without digging through code.

**Auditable and self-hosted.** The security team can read every line. There is no
black-box SaaS to trust, no vendor dependency for availability, and no risk of a
provider changing pricing or ToS mid-contract.

---

## Where the answer is no, or not yet

**No warm index — latency gap is structural.**
`advanced` search fetches and renders live pages via Chromium, then runs cross-encoder
scoring. This takes 10–20 seconds at p95. Tavily and Exa serve from a pre-crawled
corpus and respond in ~2 seconds. This gap is not tunable — closing it requires
building an index, which is a different product. For agent workflows where the user
is waiting, this is a product-level objection. For batch pipelines or background
agents it is acceptable. See `docs/enterprise/SLO.md` Ceiling #1.

**Free-tier recall is lower than Google.**
The `clean` engine profile (Mojeek, Marginalia, Brave free) has narrower coverage
than Google or Bing. The cross-encoder reranker recovers much of the ranking quality
from what the engines do return, but it cannot retrieve pages the engines never
indexed. Ambiguous or domain-specific queries (product FAQs, regulatory documents,
narrow technical topics) are most affected. This is the real cost of the
ToS-compliant posture. See `docs/enterprise/TERMS_OF_SERVICE.md` and
`docs/enterprise/SLO.md` Ceiling #2.

**Operationally immature — no measured numbers yet.**
SLO targets are structural estimates based on the architecture; none have been
measured against a live deployment. A governance board will ask "what is your p95
latency?" and the current answer is TBD. An untested runbook is a guess with
formatting. See `docs/enterprise/SLO.md` (all values marked TBD) and
`docs/enterprise/RUNBOOK.md`.

**Requires internal ownership.**
This is internally supported software with no vendor SLA. Operating it requires a
team that understands Kubernetes, Prometheus, SearXNG, and Node.js. If that team
does not exist, the tool does not help. The operational cost is real even if the
software licence is free. See `docs/enterprise/OWNERSHIP.md`.

---

## Gaps to close before sign-off

| Gap | Evidence | Owner |
|---|---|---|
| SLO numbers are TBD | All rows in `SLO.md` summary table are unmeasured | Platform team |
| Runbook untested | No procedure in `RUNBOOK.md` has been executed against a live deployment | Platform team |
| OWNERSHIP.md has placeholders | `[OWNER_NAME]`, `[OWNER_EMAIL]`, `[OWNER_HANDLE]` not filled | Engineering lead |
| POPIA §9 checklist unsigned | Five-item legal checklist in `POPIA_ASSESSMENT.md §9` not signed off | Legal / DPO |
| HPA custom-metric scaling unverified | `prometheus-adapter` must be installed and `mcp_inflight_requests` must drive real scale events under load | Platform team |
| `test:smoke` and `test:k8s` not run against live deployment | Eight end-to-end verification gates in `TAVILY_PARITY_PLAN.md §Verification` are all open | Platform team |

---

## What would close the deal

These four things, in order:

**1. Stand up the deployment and measure the SLOs.**
Run `node scripts/load-test.mjs` against the k8s cluster and fill in the TBD values
in `docs/enterprise/SLO.md`. This turns "we believe p95 is under 8 seconds" into
"we measured 4.2 seconds on 2026-MM-DD against this cluster." That is the difference
between a draft and a contract.

```sh
node scripts/load-test.mjs \
  --base https://mcp.internal.vodacom.co.za \
  --concurrency 10 \
  --queries 100 \
  --depths fast,basic,advanced
```

**2. Name an owner.**
Fill `[OWNER_NAME]`, `[OWNER_EMAIL]`, and `[OWNER_HANDLE]` in
`docs/enterprise/OWNERSHIP.md`. A governance board needs a named human who will
answer a 2am page — a team alias is not sufficient. This is a five-minute edit with
a real person's name.

**3. Legal sign-off on POPIA.**
The five-item checklist in `docs/enterprise/POPIA_ASSESSMENT.md §9` is the minimum
legal review required before query data from Vodacom users flows through this system.
The assessment is written; it needs a signature, not more analysis.

**4. Run a relevance demo on Vodacom-domain queries.**
Show `advanced` returning the correct result for three to five real queries —
roaming policy, network coverage, a product FAQ, a regulatory document. Record
`basic` vs `advanced` on the same query so the reranker's value is visible.
`rerank_duration_seconds` should be populated in `/metrics` after the demo.

Without items 1 and 4, the governance conversation stalls before it starts. Without
items 2 and 3, it cannot complete.

---

## The realistic adoption path

An internal AI or data platform team is building an agent infrastructure and does not
want to route all queries through a US SaaS for compliance or cost reasons. They
already run Kubernetes. They are comfortable owning a Node.js service. They start on
the `clean` profile and add `BRAVE_API_KEY` once budget is approved — no code change
required, only a Kubernetes Secret.

That team is the target adopter. The tool is genuinely better than Tavily for them
on the dimensions they care about: data locality, compliance, full-page markdown
rather than snippets, and zero marginal cost. The latency gap on `advanced` is real
and must be disclosed, not minimised.

---

## Summary scorecard

| Dimension | Status | Notes |
|---|---|---|
| Code quality | ✅ Production-ready | 662 tests, RED-first TDD, all phases shipped |
| Observability | ✅ Complete | All metrics wired; HPA signals exist |
| Security posture | ✅ Complete | securityContext, NetworkPolicy, SSRF guards, non-root image |
| Governance documentation | ✅ Complete | All six enterprise docs present |
| Measured SLOs | ❌ Not done | All values TBD — deployment never stood up |
| Runbook exercised | ❌ Not done | No procedure tested against live system |
| Named owner | ❌ Not done | Placeholders in OWNERSHIP.md |
| Legal sign-off (POPIA) | ❌ Not done | Checklist written, not signed |
| HPA verified under load | ❌ Not done | Requires live cluster + prometheus-adapter |
| Relevance demonstrated | ❌ Not done | No domain-specific query results on record |
