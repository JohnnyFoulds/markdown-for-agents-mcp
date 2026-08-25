# Ownership and Support — markdown-for-agents-mcp

> **REQUIRED ACTION:** Replace `[OWNER_NAME]` and `[OWNER_EMAIL]` below with a real
> person before this document is used in any governance review. A team alias is not
> acceptable — the owner must be a named individual who can be paged. See Phase 6 DoD.

---

## Primary owner

| Field | Value |
|---|---|
| **Name** | [OWNER_NAME] |
| **Email** | [OWNER_EMAIL] |
| **GitHub / GitLab handle** | [OWNER_HANDLE] |
| **Team** | [TEAM_NAME] |
| **On-call rotation** | [ROTATION_NAME] |

The owner is the first point of contact for:
- Production incidents affecting the MCP server or worker
- Security vulnerability disclosures
- Feature requests and roadmap decisions
- Compliance and legal queries about this system

---

## Escalation path

| Tier | Contact | When |
|---|---|---|
| 1 — On-call engineer | [ROTATION_NAME] via PagerDuty / Opsgenie | Active incident, any hour |
| 2 — Primary owner | [OWNER_EMAIL] | Incident not resolved by on-call within 30 min |
| 3 — Engineering lead | [LEAD_EMAIL] | P1 incident, regulatory concern, or security breach |
| 4 — Legal / Compliance | [LEGAL_EMAIL] | POPIA data subject request, regulator inquiry |
| 5 — Security incident | Follow `RUNBOOK.md §10` first; escalate to tier 3 if unresolved within 1 h | SEC-01/02/03 alert firing, credential compromise, CVE requiring emergency patch |

---

## Support model

**This is internally supported software.** There is no vendor SLA. Support is
provided by the owning team on a best-effort basis within normal working hours
(SAST, Monday–Friday), with on-call coverage for P1/P2 incidents.

| Severity | Definition | Target response | Target resolution |
|---|---|---|---|
| P1 | Service down, all search broken, data loss | 30 min (on-call) | 4 h |
| P2 | Degraded search quality, one provider down | 2 h | 8 h (business hours) |
| P3 | Non-critical feature issue, performance | Next business day | 5 business days |
| P4 | Enhancement request, documentation | Backlog | Best effort |

---

## Patch cadence

| Activity | Frequency | Owner |
|---|---|---|
| Dependency updates (Dependabot + manual) | Dependabot weekly; immediately for CVSS ≥ 7.0 | [OWNER_NAME] |
| Playwright / Chromium updates | Monthly, or on security advisories | [OWNER_NAME] |
| SearXNG image updates | Monthly | [OWNER_NAME] |
| Model updates (`Xenova/bge-reranker-base`) | Quarterly, or on significant quality improvement | [OWNER_NAME] |
| k8s manifest review | Quarterly, or on Kubernetes minor version upgrade | [OWNER_NAME] |

**Dependency-update policy:** see [`docs/enterprise/DEPENDENCY_MANAGEMENT.md`](DEPENDENCY_MANAGEMENT.md) for the full SLA table, the exception process, and the Grade B dependency inventory.

Summary:
1. `npm audit --audit-level=moderate` runs in CI on every push/PR to `main` and `development`. **MODERATE and above blocks the merge** (not high/critical only — previous text was incorrect).
2. Dependabot raises PRs automatically on Monday each week. All production dependency updates go through the standard PR process with `npm test && npm run build` required to pass.
3. Breaking updates (major version) require a brief impact assessment comment in the PR before merge, and a re-assessment of any Grade B conformance the dependency carries.

---

## Known limitations

The following limitations are acknowledged and will not be addressed without a
separate work item:

1. **No warm index** — `advanced` depth latency is 10–20 s structural (see `SLO.md`)
2. **`clean` profile has lower recall than Google** — reranker recovers ranking quality
   but not recall; narrow-domain queries benefit from paid keys
3. **IP reputation ceiling** — sustained 10k+/day from one egress IP risks rate-limiting
4. **NetworkPolicy requires Calico/Cilium** — see `THREAT_MODEL.md §3`
5. **No per-user RBAC** — shared bearer token; see `THREAT_MODEL.md §1`

These are documented in `docs/enterprise/SLO.md` and `THREAT_MODEL.md`. Any deviation
from the documented posture requires owner sign-off.

---

## Handoff checklist (for owner transitions)

When ownership transfers, the incoming owner must confirm:

- [ ] Access to `mcp-system` namespace in production cluster
- [ ] Access to `mcp-secrets` Kubernetes Secret
- [ ] Access to Prometheus / Grafana for metrics
- [ ] Membership in the on-call rotation
- [ ] Familiarity with `docs/enterprise/RUNBOOK.md` (execute at least one procedure, including §10 security incidents)
- [ ] Familiarity with `docs/enterprise/THREAT_MODEL.md`
- [ ] Familiarity with [`docs/security/SECURITY_SCANNING.md`](../security/SECURITY_SCANNING.md) — scan tools, thresholds, CI gate
- [ ] Updated `OWNERSHIP.md` with new owner details, committed and merged
