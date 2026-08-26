# Terms of Service — Engine Profile Compliance

This document states, per engine profile, which search engines are active and whether
automated access is permitted under their terms of service.

**This document is load-bearing for governance.** Any engine added to a profile must
be assessed here before the profile is used in production. A profile used in production
without a ToS entry for all its engines is a governance gap.

---

## Profile: `clean` (default — `SEARXNG_ENGINE_PROFILE=clean`)

All engines in this profile **permit automated/programmatic access**.

| Engine | ToS position | Notes |
|---|---|---|
| **Mojeek** | ✓ Permitted | Mojeek explicitly permits reasonable automated access for research; no API key required |
| **Marginalia** | ✓ Permitted | Independent search engine; permits automated use |
| **Brave (free web endpoint)** | ✓ Permitted (with limits) | Brave's free web endpoint permits automated use; rate limits apply |
| **Wikipedia** | ✓ Permitted | Wikipedia's Terms of Use and API policy permit programmatic access |
| **Wikidata** | ✓ Permitted | Open data; CC0 licence; programmatic access is the intended use |

**POPIA note:** With the `clean` profile and no paid keys, query strings are forwarded
to the above engines. All are permissive. No additional legal sign-off is required for
the engine selection itself (trans-border transfer sign-off in POPIA_ASSESSMENT.md §9
still applies).

---

## Profile: `full` (`SEARXNG_ENGINE_PROFILE=full`)

> **⚠ WARNING: This profile includes engines that PROHIBIT automated access.**
> Do not enable `SEARXNG_ENGINE_PROFILE=full` without explicit legal sign-off from
> the deploying organisation's legal team. The risk is service suspension, IP blocking, or legal action from the
> affected engine operators.

This profile adds the following engines to the `clean` set:

| Engine | ToS position | Notes |
|---|---|---|
| **Google** | ✗ PROHIBITED | Google Terms of Service (§5.3) prohibit scraping and automated access without a licence. The Google Custom Search API exists but is not this. |
| **Bing** | ✗ PROHIBITED | Microsoft Bing Terms of Service prohibit automated access. The Bing Search API (paid) is permitted, but SearXNG proxies the free endpoint. |
| **DuckDuckGo** | ✗ PROHIBITED | DuckDuckGo's Terms of Service prohibit automated scraping of their search results. |
| **Yahoo** | ✗ PROHIBITED | Oath/Verizon Terms of Service prohibit automated access. |

**The `full` profile is provided for completeness, not for production use.** It
may be appropriate for internal sandboxes, evaluation, or testing — never for sustained
production traffic at scale.

**Technical note:** The reranker (cross-encoder) substantially recovers quality on the
`clean` profile for most queries. The gap between `clean` and `full` is most visible on:
- Very recent news (Wikipedia/Wikidata lag behind Google on breaking news)
- Narrow domain-specific queries where Marginalia's academic focus does not apply
- Navigational queries (searching for a specific website)

For these cases, the correct mitigation is a paid key (`BRAVE_API_KEY` or
`SERPER_API_KEY`), not the `full` profile.

---

## Paid providers (`BRAVE_API_KEY`, `SERPER_API_KEY`)

| Provider | ToS position | Agreement type |
|---|---|---|
| **Brave Search API** | ✓ Permitted | Commercial API — access is contractually licensed per Brave's API Terms of Service |
| **Serper** | ✓ Permitted | Commercial API — access is contractually licensed per Serper's Terms |

Paid providers are licensed for programmatic access. This is the **recommended path**
for production deployments where the `clean` profile's recall limitations are
unacceptable and the `full` profile's ToS risk is not acceptable.

Setting `BRAVE_API_KEY` is a config-only change that activates Brave as the tier-1
provider with no code modification. See `src/search/fanout.paid.test.ts` for the
executable proof of this claim.

---

## Summary

| Scenario | Profile | Paid keys | Compliance |
|---|---|---|---|
| Zero-budget, ToS-clean | `clean` | None | ✓ Clean |
| Zero-budget, higher recall | `full` | None | ✗ Breaches Google/Bing/DDG ToS |
| Budget available, maximum quality | `clean` | Brave + Serper | ✓ Clean |
| Budget available, ToS risk eliminated | `clean` | Brave + Serper | ✓ Clean |

The recommended production configuration is `SEARXNG_ENGINE_PROFILE=clean` with
`BRAVE_API_KEY` (and optionally `SERPER_API_KEY`) when budget is available.
