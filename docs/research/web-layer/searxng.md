# SearXNG: Self-Hosted Metasearch — Complete Research Reference

**Status:** Research complete — August 2026
**Sources:** docs.searxng.org (2026.8.22+9fea41204), github.com/searxng/searxng, deepwiki.com/searxng, bigiron.cc, joshuaopolko.com

---

## Table of Contents

1. [What SearXNG Is and How It Works](#1-what-searxng-is-and-how-it-works)
2. [Engine Catalogue — All 272 Engines](#2-engine-catalogue--all-272-engines)
3. [JSON API — Complete Reference](#3-json-api--complete-reference)
4. [settings.yml — Full Configuration Reference](#4-settingsyml--full-configuration-reference)
5. [Result Merging and Scoring Algorithm](#5-result-merging-and-scoring-algorithm)
6. [Redis/Valkey Caching](#6-redisvalkey-caching)
7. [Rate Limiting and Bot Protection](#7-rate-limiting-and-bot-protection)
8. [Docker Production Deployment](#8-docker-production-deployment)
9. [NGINX Reverse Proxy](#9-nginx-reverse-proxy)
10. [Privacy Architecture](#10-privacy-architecture)
11. [SearXNG vs Whoogle vs Kagi API — Decision Guide](#11-searxng-vs-whoogle-vs-kagi-api--decision-guide)
12. [Optimal Configuration for AI Agent Use](#12-optimal-configuration-for-ai-agent-use)
13. [Integrating SearXNG into markdown-for-agents-mcp](#13-integrating-searxng-into-markdown-for-agents-mcp)
14. [Performance Benchmarks and Latency](#14-performance-benchmarks-and-latency)
15. [Failure Modes, Edge Cases, and Gotchas](#15-failure-modes-edge-cases-and-gotchas)
16. [What to Build and What to Skip](#16-what-to-build-and-what-to-skip)

---

## 1. What SearXNG Is and How It Works

SearXNG is a free, self-hosted metasearch engine that aggregates results from up to **272 upstream search services** (as of August 2026). It owns no index of its own. Every search query fans out in parallel to configured upstream engines, results are collected, deduplicated, scored, and returned as a merged ranked page.

**Project facts (August 2026):**
- GitHub: github.com/searxng/searxng — ~32,000 stars, ~3,000 forks, 9,500+ commits
- License: AGPL-3.0
- Language: Python (Flask/Granian ASGI)
- Started mid-2021 as a fork of the abandoned `searx` project
- The `searxng-docker` helper repo was archived on **March 28, 2026** — use the `container/` Compose files in the main repo instead
- ~70 public instances available at searx.space
- 58 UI language translations

**Request flow:**

```
AI Agent / MCP client
      |
      v  GET /search?q=...&format=json
  SearXNG (Flask/Granian)
      |
      +---> Google (parallel, async HTTP)
      +---> Brave
      +---> DuckDuckGo
      +---> Wikipedia
      +---> Bing
      +---> [N more configured engines]
      |
      v  Results collected within timeout
  ResultContainer (dedup, score, merge)
      |
      v
  JSON response → MCP tool → AI agent
```

The upstream engines see SearXNG's server IP and a rotating User-Agent — never the end user. This is the structural privacy property: profiling is architecturally blocked, not merely promised.

---

## 2. Engine Catalogue — All 272 Engines

SearXNG supports **272 search engines** of which **83 are enabled by default** (2026.8.22). Sources: docs.searxng.org/user/configured_engines.html

### 2.1 Tab: general

#### Group: web (primary general search)

| Engine | Bang | Module | Disabled | Timeout | Weight | Paging | Locale | SafeSearch | TimeRange |
|--------|------|--------|----------|---------|--------|--------|--------|------------|-----------|
| bing | !bi | bing | yes | 3.0 | 1.0 | — | yes | yes | — |
| brave | !br | brave | **no** | 3.0 | 1.0 | yes | yes | yes | yes |
| duckduckgo | !ddg | duckduckgo | **no** | 3.0 | 1.0 | yes | yes | yes | — |
| google | !go | google | yes | 3.0 | 1.0 | yes | yes | yes | yes |
| google cse | !goc | google_cse | **no** | 3.0 | 1.0 | yes | yes | yes | yes |
| mojeek | !mjk | mojeek | yes | 3.0 | 1.0 | yes | yes | yes | yes |
| qwant | !qw | qwant | yes | 3.0 | 1.0 | yes | yes | yes | — |
| startpage | !sp | startpage | **no** | 3.0 | 1.0 | yes | yes | yes | yes |
| yahoo | !yh | yahoo | yes | 3.0 | 1.0 | yes | — | — | yes |
| seznam (CZ) | !szn | seznam | yes | 3.0 | 1.0 | — | — | — | — |
| naver (KO) | !nvr | naver | yes | 3.0 | 1.0 | yes | — | — | yes |

#### Group: wikimedia

| Engine | Bang | Disabled |
|--------|------|----------|
| wikipedia | !wp | **no** |
| wikidata | !wd | **no** |
| wikibooks | !wb | yes |
| wikiquote | !wq | yes |
| wikisource | !ws | yes |
| wikispecies | !wsp | yes |
| wikiversity | !wv | yes |
| wikivoyage | !wy | yes |

#### Without subgroup (general web)

Includes: ayo, boardreader, crowdview, ddg definitions, duckduckgo web, encyclosearch, fastbot, fireball, fynd, gabanza, gmx, infospace, mwmbl, privacywall, resulthunter, searchtoday, tineye, tusksearch, vuhuv, wolframalpha, yacy, yandex, yep, zapmeta, searchch (CH), bpb (DE), reloado (DE), tagesschau (DE), wikimini (FR), abcnyheter (NO), 360search (ZH), baidu (ZH), quark (ZH), sogou (ZH)

#### Group: blogs

| Engine | Bang | Disabled |
|--------|------|----------|
| searchmysite | !sms | yes |
| wiby | !wib | yes |

#### Group: books, currency, translate

- openlibrary (!ol), currency converter (!cc), dictzone (!dc), lingva (!lv), mozhi (!mz), mymemory (!tl)

### 2.2 Tab: images

**Enabled by default:** bing images, brave images, google cse images, startpage images, duckduckgo images, artic, flickr, openverse, pexels, pinterest, unsplash, wikicommons images, devicons, lucide

**Disabled (require activation):** google images, mojeek images, qwant images, 500px, adobe stock, artstation, cara, findfiles, findthatmeme, giphy, imgur, ipernity, loc images, magnific, picjumbo, pixabay images, resulthunter images, shopify stock, stocksnap, tusksearch images, vuhuv images, yacy images, yandex images, baidu images (ZH), quark images (ZH), naver images (KO), 1x, flaticon, material icons, selfhst icons, uxwing, public domain image archive, sogou images, privacywall images

### 2.3 Tab: videos

**Enabled by default:** bing videos, brave videos, google videos, dailymotion, duckduckgo videos, sepiasearch, vimeo, wikicommons videos, youtube

**Disabled:** qwant videos, 360search videos, adobe stock video, bilibili, bitchute, google play movies, media.ccc.de, odysee, peertube, pixabay videos, privacywall videos, rumble, tusksearch videos, vuhuv videos, mediathekviewweb (DE), ina (FR), niconico (JA), acfun (ZH), iqiyi (ZH), sogou videos (ZH), naver videos (KO)

### 2.4 Tab: news

**Enabled by default:** bing news, brave news, google news, reuters, startpage news, wikinews, duckduckgo news

**Disabled:** fireball news, mojeek news, qwant news, tusksearch news, tagesschau (DE), ansa (IT), il post (IT), naver news (KO), sogou wechat (ZH)

### 2.5 Tab: map

| Engine | Bang | Default |
|--------|------|---------|
| openstreetmap | !osm | enabled |
| photon | !ph | enabled |
| apple maps | !apm | disabled |

### 2.6 Tab: music

**Enabled by default:** genius (lyrics), radio browser, bandcamp, mixcloud, soundcloud, wikicommons audio, youtube

**Disabled:** adobe stock audio, deezer, yandex music, findfiles music

### 2.7 Tab: it

#### Packages (enabled by default)

docker hub (!dh), hoogle (!ho), pypi (!pypi), askubuntu, stackoverflow, superuser, github (!gh), arch linux wiki (!al), gentoo (!ge), mankier (!man), mdn (!mdn)

#### Packages (disabled)

alpine linux, cachy os, crates.io, hex, lib.rs, metacpan, npm, packagist, pkg.go.dev, pub.dev, rubygems, voidlinux

#### Repos (disabled)

bitbucket, codeberg, gitea.com, gitlab, huggingface, huggingface datasets, huggingface spaces, ollama, sourcehut

#### IT misc (enabled)

habrahabr enabled? No — disabled. lobste.rs disabled. hackernews disabled. microsoft learn disabled. national vulnerability database disabled.

### 2.8 Tab: science

**Enabled by default:** arxiv (!arx), google scholar (!gos), pubmed (!pub), semantic scholar (!se)

**Disabled:** crossref (!cr), openalex (!oa), wikispecies, openairedatasets, springer nature, CORE

### 2.9 Notable API-Key Engines (inactive until key provided)

These are set `inactive: true` by default; you must supply an `api_key` and set `inactive: false`:

- **Exa API** — neural search, excellent for AI agent use
- **Kagi engines** — requires Kagi API key (paid)
- **Brave Search API** — official API key, different from scrape-based brave engine
- **Yandex Search API** — requires Yandex API key
- **Z-Library** — book search

---

## 3. JSON API — Complete Reference

Source: docs.searxng.org/dev/search_api.html

### 3.1 Endpoints

```
GET  /
GET  /search
POST /
POST /search
```

Both GET and POST are accepted. GET uses URL query parameters; POST uses `application/x-www-form-urlencoded` form data.

**Critical prerequisite:** JSON format must be explicitly enabled in `settings.yml` under `search.formats`. It is disabled on most public instances. On your own instance, add `json` to the formats list.

### 3.2 Query Parameters

| Parameter | Required | Type | Values | Description |
|-----------|----------|------|--------|-------------|
| `q` | yes | string | any | The search query. Supports engine-specific syntax (e.g. `site:github.com searxng` for Google) |
| `categories` | no | string | comma-separated list | Active search categories (e.g. `general`, `images`, `news`, `it`, `science`, `map`, `music`, `videos`) |
| `language` | no | string | ISO code | Language code (e.g. `en`, `en-US`, `de`, `fr`); default from instance settings |
| `pageno` | no | integer | 1+ | Page number; default 1 |
| `time_range` | no | string | `day`, `month`, `year` | Filter by recency; only applies to engines that support it |
| `format` | no | string | `json`, `csv`, `rss` | Output format; defaults to HTML if not specified |
| `safesearch` | no | integer | `0`, `1`, `2` | 0=None, 1=Moderate, 2=Strict |
| `theme` | no | string | `simple` | UI theme (irrelevant for API consumers) |

### 3.3 Example Requests

```bash
# Basic JSON search
curl 'https://search.example.com/search?q=typescript+MCP+server&format=json'

# Targeted category search
curl 'https://search.example.com/search?q=searxng+api&format=json&categories=it,science'

# Recent news only
curl 'https://search.example.com/search?q=AI+agents&format=json&categories=news&time_range=month'

# POST method
curl -X POST 'https://search.example.com/search' \
  -d 'q=typescript+mcp&format=json&categories=general'
```

### 3.4 JSON Response Schema

```typescript
interface SearXNGResponse {
  query: string;                     // The original query string
  number_of_results: number;         // Estimated total results (0 if unreliable)
  results: SearchResult[];           // Main result list (deduplicated, scored)
  answers: Answer[];                 // Direct answers (calculator, unit conversion, etc.)
  corrections: string[];             // Spelling correction suggestions
  infoboxes: Infobox[];              // Infobox results (Wikipedia summaries, etc.)
  suggestions: string[];             // Alternative query suggestions
  unresponsive_engines: UnresponsiveEngine[];  // Engines that failed/timed out
}

interface SearchResult {
  url: string;                       // Result URL (HTTPS preferred over HTTP)
  title: string;                     // Page title
  content: string;                   // Snippet/description (longer of the engine snippets)
  engine: string;                    // First engine that returned this result
  engines: string[];                 // All engines that returned this URL (merged)
  score: number;                     // Relevance score (see scoring algorithm, section 5)
  category: string;                  // Category this result belongs to
  template: string;                  // Display template (e.g. "default.html", "images.html")
  positions: number[];               // Position in each engine's result list
  parsed_url: ParsedUrl;             // Parsed URL components
  publishedDate?: string;            // ISO 8601 date if available
  thumbnail?: string;                // Thumbnail URL for image results
  img_src?: string;                  // Full image URL for image results
  img_format?: string;               // Image format (e.g. "jpeg", "png")
  img_src_original?: string;         // Original image URL (before proxy)
  // Engine-specific fields may be present
}

interface ParsedUrl {
  scheme: string;                    // "https" or "http"
  netloc: string;                    // Domain
  path: string;                      // URL path
  params: string;
  query: string;
  fragment: string;
}

interface Answer {
  answer: string;                    // The computed answer text
}

interface Infobox {
  infobox: string;                   // Infobox title
  id?: string;                       // Stable identifier (e.g. Wikidata QID)
  content?: string;                  // Description text
  url?: string;                      // Source URL
  img_src?: string;                  // Image
  urls?: { title: string; url: string; official?: boolean }[];
  attributes?: { label: string; value: string; entity?: string }[];
  engine: string;
  engines: string[];
}

interface UnresponsiveEngine {
  name: string;                      // Engine name
  error: string;                     // Error type
  suspended: boolean;                // Whether engine is now suspended
}
```

### 3.5 Example JSON Response

```json
{
  "query": "typescript mcp server",
  "number_of_results": 42300000,
  "results": [
    {
      "url": "https://modelcontextprotocol.io/quickstart",
      "title": "Quickstart - Model Context Protocol",
      "content": "Build a simple MCP server in TypeScript...",
      "engine": "brave",
      "engines": ["brave", "duckduckgo"],
      "score": 3.1666,
      "category": "general",
      "template": "default.html",
      "positions": [1, 3],
      "parsed_url": {
        "scheme": "https",
        "netloc": "modelcontextprotocol.io",
        "path": "/quickstart",
        "params": "",
        "query": "",
        "fragment": ""
      }
    }
  ],
  "answers": [],
  "corrections": [],
  "infoboxes": [],
  "suggestions": ["typescript mcp client", "mcp server nodejs"],
  "unresponsive_engines": []
}
```

### 3.6 Administration API

```
GET /config  HTTP/1.1
```

Returns instance configuration including enabled engines, categories, plugins, safe_search setting, and available locales. Does not require authentication by default (but should be behind auth on public instances).

```json
{
  "autocomplete": "duckduckgo",
  "categories": ["general", "images", "videos", "news", "map", "music", "it", "science"],
  "default_locale": "en",
  "default_theme": "simple",
  "engines": [
    { "categories": ["general"], "enabled": true, "name": "brave", "shortcut": "br" },
    { "categories": ["general"], "enabled": false, "name": "google", "shortcut": "go" }
  ],
  "instance_name": "SearXNG",
  "safe_search": 0
}
```

---

## 4. settings.yml — Full Configuration Reference

Source: docs.searxng.org/admin/settings/settings.html

### 4.1 File Location and Loading

Priority order:
1. Path in `$SEARXNG_SETTINGS_PATH` environment variable
2. `/etc/searxng/settings.yml`
3. Built-in defaults from the repository

### 4.2 use_default_settings

The most important top-level directive. Without it, you must specify everything. With it, you only override what you need:

```yaml
use_default_settings: true

# Optionally remove specific engines from the defaults:
# use_default_settings:
#   engines:
#     remove:
#       - google
#       - bing

# Or whitelist only specific engines:
# use_default_settings:
#   engines:
#     keep_only:
#       - brave
#       - duckduckgo
#       - wikipedia
```

### 4.3 general

```yaml
general:
  debug: false              # Enable debug mode (NEVER in production)
  instance_name: "SearXNG"  # Instance display name
  privacypolicy_url: false  # URL to privacy policy page
  contact_url: false        # URL to contact page
  enable_metrics: true      # Enable /stats endpoint
```

### 4.4 search

```yaml
search:
  safe_search: 0            # 0=None, 1=Moderate, 2=Strict
  autocomplete: "duckduckgo" # Autocomplete backend
  favicon_resolver: ""      # Favicon resolver (leave blank to disable)
  default_lang: ""          # Default language (blank=detect from browser)
  ban_time_on_fail: 5       # Seconds to ban engine after error
  max_ban_time_on_fail: 120 # Max ban seconds
  max_page: 0               # Max pagination pages (0=unlimited)
  suspended_times:
    SearxEngineAccessDenied: 86400      # 24h ban for 403
    SearxEngineCaptcha: 86400           # 24h ban for CAPTCHA
    SearxEngineTooManyRequests: 3600    # 1h ban for 429
    cf_SearxEngineCaptcha: 1296000      # 15d ban for Cloudflare CAPTCHA
    cf_SearxEngineAccessDenied: 86400   # 24h ban for CF access denied
    recaptcha_SearxEngineCaptcha: 604800 # 7d ban for reCAPTCHA
  formats:
    - html
    - json        # Must be listed here to enable JSON API
    - csv
    - rss
  languages:      # Optional: restrict available languages
    - all
    - en
    - en-US
    - de
    - fr
```

**Critical for MCP use:** Add `json` to `formats` or the JSON API returns HTTP 403.

### 4.5 server

```yaml
server:
  base_url: "https://search.example.com"  # Public URL, used for correct inbound links
  port: 8080                               # Internal port (overridden by $SEARXNG_PORT)
  bind_address: "127.0.0.1"               # Bind address ($SEARXNG_BIND_ADDRESS)
  secret_key: "CHANGE_THIS_NOW"           # Cryptographic key ($SEARXNG_SECRET)
  limiter: true                            # Enable bot protection (requires valkey)
  public_instance: false                   # Enable public-instance features
  image_proxy: true                        # Proxy images through SearXNG
  method: "GET"                            # HTTP method for outbound requests
  default_http_headers:
    X-Content-Type-Options: nosniff
    X-Download-Options: noopen
    X-Robots-Tag: noindex, nofollow        # Keep instance out of search indexes
    Referrer-Policy: no-referrer
```

**Environment variable overrides:**
- `SEARXNG_BASE_URL` → `base_url`
- `SEARXNG_PORT` → `port`
- `SEARXNG_BIND_ADDRESS` → `bind_address`
- `SEARXNG_SECRET` → `secret_key`
- `SEARXNG_LIMITER` → `limiter`
- `SEARXNG_PUBLIC_INSTANCE` → `public_instance`
- `SEARXNG_IMAGE_PROXY` → `image_proxy`

### 4.6 outgoing

Controls all HTTP traffic to upstream engines:

```yaml
outgoing:
  request_timeout: 2.0         # Default per-engine timeout (seconds)
  max_request_timeout: 10.0    # Hard ceiling for any engine
  useragent_suffix: ""         # Appended to User-Agent (put contact info here)
  pool_connections: 100        # Max total HTTP connections
  pool_maxsize: 10             # Max keep-alive connections per host
  keepalive_expiry: 5.0        # Keep-alive TTL (seconds)
  enable_http2: true           # Enable HTTP/2 (reduces latency for many engines)
  max_redirects: 30            # Max redirects before error
  retries: 0                   # Retry count on HTTP error (each retry uses different proxy/IP)

  # Proxy all outbound requests through a proxy:
  # proxies:
  #   all://:
  #     - http://proxy1:8080
  #     - socks5://user:pass@proxy2:1080

  # Route through Tor:
  # using_tor_proxy: true

  # Multiple egress IPs for rate-limit distribution:
  # source_ips:
  #   - 192.168.0.1
  #   - 192.168.0.2

  # Custom CA certificate:
  # verify: /path/to/ca-cert.pem
```

**Per-engine overrides:** Any of these settings can be overridden in the `engines:` section for a specific engine:

```yaml
engines:
  - name: google
    engine: google
    max_connections: 5         # Throttle Google specifically
    request_timeout: 5.0       # Override global timeout for this engine
    retries: 1
    retry_on_http_error: [429, 403]
```

### 4.7 valkey / redis

**Valkey (recommended, successor to Redis):**

```yaml
valkey:
  url: valkey://localhost:6379/0
  # Or via socket:
  # url: unix:///path/to/valkey.sock?db=0
  # Or with auth:
  # url: valkey://username:password@localhost:6379/0
```

**Redis (legacy, still supported):**

```yaml
redis:
  url: redis://localhost:6379/0
```

Valkey is used for:
1. Bot detection / IP rate limiting (limiter plugin)
2. Shared state across multiple SearXNG workers

### 4.8 categories_as_tabs

Controls which categories appear as tabs in the UI. For API-only usage this is irrelevant, but it affects which categories are queryable by name:

```yaml
categories_as_tabs:
  general:
    order: 1
  images:
    order: 2
  videos:
    order: 3
  news:
    order: 4
  map:
    order: 5
  music:
    order: 6
  it:
    order: 7
  science:
    order: 8
```

### 4.9 engines: detailed per-engine configuration

Full engine configuration example:

```yaml
engines:
  - name: brave
    engine: brave
    shortcut: br
    categories: general
    timeout: 3.0
    weight: 1.5          # Increase weight to boost this engine's results
    disabled: false       # false = enabled by default for all users
    display_error_messages: true

  # Enable Google (disabled by default):
  - name: google
    engine: google
    disabled: false
    weight: 1.0

  # Enable Bing (disabled by default):
  - name: bing
    engine: bing
    disabled: false
    weight: 1.0

  # Add a second Google instance in a different language:
  - name: google german
    engine: google
    language: de
    categories: general
    weight: 1.0

  # Private engine with token access:
  - name: internal-search
    engine: recoll
    tokens: ['your-secret-token']
    base_url: http://recoll-server:8080

  # Exa AI search (requires API key):
  - name: exa
    engine: exa
    api_key: !ENV SEARXNG_EXA_API_KEY
    inactive: false
    categories: general
```

### 4.10 plugins

```yaml
plugins:
  - searx.plugins.calculator.SXNGPlugin:
      active: true           # User can toggle; on by default
  - searx.plugins.unit_converter.SXNGPlugin:
      active: true
  - searx.plugins.hostnames.SXNGPlugin:
      active: false
      # Requires additional configuration:
      # replace:
      #   '(.*\.)?youtube\.com$': 'invidious.example.com'
      # remove:
      #   - '(.*\.)?facebook\.com$'
```

---

## 5. Result Merging and Scoring Algorithm

Source: deepwiki.com/searxng/searxng/3.3-result-processing-and-aggregation, searx/results.py (source code)

### 5.1 Pipeline Overview

```
Engine A → results list →
Engine B → results list →   extend()  →  ResultContainer  →  close()  →  get_ordered_results()
Engine C → results list →                (RLock protected)
```

All engine results arrive concurrently (threads). The `ResultContainer` uses an `RLock` for thread-safe operation.

### 5.2 Deduplication

Each result is hashed by URL using Python's `hash()`. The hash is used as the key in `main_results_map: dict[int, MainResult]`. Duplicate URLs from different engines are merged rather than appended.

**Merge strategy when duplicate URL found:**

| Field | Strategy |
|-------|---------|
| `content` | Use the longer snippet string |
| `title` | Use the longer title string |
| `engines` | Union of all contributing engine names |
| `positions` | Append new position to list |
| `url.scheme` | Prefer HTTPS over HTTP |

### 5.3 Score Formula

The definitive scoring formula from `searx/results.py`:

```python
def calculate_score(result, priority):
    weight = 1.0

    # Multiply weights of all engines that contributed to this result
    for result_engine in result['engines']:
        if hasattr(searx.engines.engines.get(result_engine), 'weight'):
            weight *= float(searx.engines.engines[result_engine].weight)

    weight *= len(result['positions'])  # multiply by count of contributing engines

    score = 0
    for position in result['positions']:
        if priority == 'low':
            continue          # Low-priority results score 0
        if priority == 'high':
            score += weight   # High-priority: flat weight per engine
        else:
            score += weight / position  # Normal: weight / rank (reciprocal rank)

    return score
```

**Score formula in plain language:**

```
score = product(engine_weights) × engine_count × Σ(1 / position_i)
```

**Implications:**
- A result at position 1 from two engines with weight 1.0 scores: `1.0 × 1.0 × 2 × (1/1 + 1/1) = 4.0`
- A result at position 1 from one engine scores: `1.0 × 1 × 1.0 = 1.0`
- Position 2 from one engine scores: `1.0 × 1 × 0.5 = 0.5`
- Setting an engine `weight: 2.0` doubles its contribution
- Results appearing in more engines always rank higher (consensus boost)

**Priority override:**
- `priority: 'high'` — flat weight boost regardless of position (use for featured results)
- `priority: 'low'` — always scores 0, sinks to bottom
- `priority: 'medium'` (default) — standard reciprocal rank formula

### 5.4 Result Ordering

Two-pass algorithm in `get_ordered_results()`:

**Pass 1:** Sort all results by score descending.

**Pass 2:** Group results by category type for UI coherence:

```python
category_key = f"{category}:{template}:{'img_src' if has_image else ''}"
max_count = 8      # Max similar results grouped together
max_distance = 20  # Max positions to allow grouping
```

This prevents image results and plain text results from interleaving unpredictably.

### 5.5 Engine Suspension on Error

After an engine error, it is suspended for a configurable time:

| Error | Default Suspension |
|-------|--------------------|
| Access denied / HTTP 402-403 | 24 hours |
| CAPTCHA detected | 24 hours |
| Too many requests / HTTP 429 | 1 hour |
| Cloudflare CAPTCHA | 15 days |
| Cloudflare access denied | 24 hours |
| Google reCAPTCHA | 7 days |

During suspension, the engine is excluded from all queries. Error statistics are tracked per engine and visible at `/stats`.

---

## 6. Redis/Valkey Caching

### 6.1 What Valkey/Redis Is Used For

**Important:** SearXNG does NOT cache search results in Redis/Valkey. The cache is used exclusively for:

1. **Bot detection and IP rate limiting** — sliding window counters per IP address
2. **Link tokens** — one-time tokens for bot mitigation on public instances
3. **Session state** — for `public_instance: true` deployments

There is no result cache in SearXNG. Each search query always fans out to live upstream engines.

### 6.2 Valkey Configuration

```yaml
valkey:
  url: valkey://localhost:6379/0

# Alternative: Redis
redis:
  url: redis://localhost:6379/0
```

The Docker Compose setup bundles Valkey 9 (Alpine) by default:

```yaml
valkey:
  container_name: searxng-valkey
  image: docker.io/valkey/valkey:9-alpine
  command: valkey-server --save 30 1 --loglevel warning
  restart: always
  volumes:
    - valkey-data:/data/
```

### 6.3 Implications for MCP Integration

Since there is no result cache, every MCP tool call that triggers a SearXNG search sends live HTTP requests to upstream engines. Latency is always "cold" (2–5 seconds typical). If you need result caching for AI agent workflows:

- Implement a cache layer in the MCP server itself (e.g., in-memory LRU or a separate Redis TTL cache keyed on `hash(query + categories + language + pageno)`)
- Typical TTL: 5–15 minutes for general queries, 60 seconds for news
- Do not cache image searches (staleness is noticeable)

---

## 7. Rate Limiting and Bot Protection

Source: docs.searxng.org/admin/searx.limiter.html

### 7.1 Inbound Rate Limiter (Protecting SearXNG from Abuse)

The Limiter plugin protects your SearXNG instance from being used as an unauthorized proxy by bots. It requires Valkey.

**Enable:**

```yaml
server:
  limiter: true

valkey:
  url: valkey://localhost:6379/0
```

**Configure in `/etc/searxng/limiter.toml`:**

```toml
[botdetection]
ipv4_prefix = 32        # /32 = individual IP tracking
ipv6_prefix = 48        # /48 = IPv6 prefix

trusted_proxies = [
  '127.0.0.0/8',
  '::1',
  # Add your reverse proxy IPs here
]

[botdetection.ip_limit]
filter_link_local = false
link_token = false       # Set true for public instances

# Sliding window rate limits (requests per window):
# [botdetection.ip_lists]
# pass_ip = ['192.168.0.0/24']   # Allow these IPs always
# block_ip = ['203.0.113.0/24']  # Block these IPs always
```

**Detection methods:**
1. **HTTP header analysis** — checks Accept, Accept-Encoding, Accept-Language, Connection, User-Agent headers for bot signatures
2. **IP block/pass lists** — static lists in `limiter.toml`
3. **IP rate limiting** — sliding window counters in Valkey; requires correct `X-Forwarded-For` header from your reverse proxy

### 7.2 Outbound Rate Limiting (Protecting Against Upstream Bans)

SearXNG does not have a built-in outbound request scheduler or rate limiter. Rate limiting to upstream engines is achieved through:

1. **Engine suspension on error** — after CAPTCHA or 429, engine is suspended (see section 5.5)
2. **Per-engine timeout** — prevents single slow engines from stalling the whole query
3. **Per-engine connection pool limits** — `max_connections` and `max_keepalive_connections`
4. **Proxy rotation** — configure multiple proxies in `outgoing.proxies`; SearXNG round-robins between them
5. **Multiple source IPs** — `outgoing.source_ips` distributes outbound requests

**Strategy for reducing ban risk:**

```yaml
outgoing:
  # Contact info helps identify legitimate automated traffic:
  useragent_suffix: "SearXNG/private-instance; mailto:admin@example.com"
  pool_maxsize: 3            # Limit concurrent connections per host (reduce aggression)
  pool_connections: 50

engines:
  - name: google
    engine: google
    disabled: false
    timeout: 5.0
    retries: 0               # Don't retry on error (avoids compounding bans)
    retry_on_http_error: false
```

**Per-engine advice:**

| Engine | Ban Risk | Strategy |
|--------|----------|----------|
| Google | Very high | Keep disabled unless needed; use via google cse with API key instead |
| Bing | Medium | Enable but limit to 3 parallel connections |
| Brave | Low | Has official self-hosted search API; use API key version |
| DuckDuckGo | Low-Medium | Generally tolerant of automated access |
| Startpage | Low | Google proxy with privacy focus; rarely bans |
| Wikipedia | Very low | Explicitly allows programmatic access |
| arXiv | Very low | Academic API, designed for automation |
| Mojeek | Low | Independent crawler, more automation-friendly |

### 7.3 CAPTCHA Handling

SearXNG has no automated CAPTCHA solving. When an engine starts serving CAPTCHAs:

1. The engine is suspended per `suspended_times` configuration
2. Error appears in the UI and in JSON `unresponsive_engines`
3. Admin can manually solve CAPTCHA from server's IP via `/admin/answer-captcha` if enabled

For AI agent workloads with sustained high query rates, configure `use_default_settings.engines.keep_only` to a small set of reliable engines and avoid Google entirely.

---

## 8. Docker Production Deployment

Source: docs.searxng.org/admin/installation-docker.html

### 8.1 Official Docker Compose Setup (2026)

The `searxng-docker` helper repo was **archived on 2026-03-28**. The canonical setup is now the `container/` directory in the main repo.

```bash
# Create working directory
mkdir -p ./searxng/core-config/
cd ./searxng/

# Fetch official compose file and env template
curl -fsSL \
    -O https://raw.githubusercontent.com/searxng/searxng/master/container/docker-compose.yml \
    -O https://raw.githubusercontent.com/searxng/searxng/master/container/.env.example

# Configure
cp -i .env.example .env
nano .env    # Set SEARXNG_HOSTNAME, SEARXNG_PORT, etc.

# Start
docker compose up -d
```

### 8.2 Official docker-compose.yml

```yaml
name: searxng

services:
  core:
    container_name: searxng-core
    image: docker.io/searxng/searxng:latest
    restart: always
    ports:
      - ${SEARXNG_HOST:+${SEARXNG_HOST}:}${SEARXNG_PORT:-8080}:${SEARXNG_PORT:-8080}
    env_file: ./.env
    volumes:
      - ./core-config/:/etc/searxng/:Z
      - core-data:/var/cache/searxng/

  valkey:
    container_name: searxng-valkey
    image: docker.io/valkey/valkey:9-alpine
    command: valkey-server --save 30 1 --loglevel warning
    restart: always
    volumes:
      - valkey-data:/data/

volumes:
  core-data:
  valkey-data:
```

### 8.3 Volume Mounts

| Mount | Purpose |
|-------|---------|
| `/etc/searxng/` | Configuration files: `settings.yml`, `limiter.toml`, `favicons.toml` |
| `/var/cache/searxng/` | Persistent data: favicon cache SQLite DB |

### 8.4 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARXNG_HOSTNAME` | localhost | Public hostname |
| `SEARXNG_PORT` | 8080 | Port binding |
| `SEARXNG_SECRET` | — | Secret key (generate with `openssl rand -hex 32`) |
| `SEARXNG_BASE_URL` | — | Full public URL |
| `SEARXNG_LIMITER` | false | Enable limiter |
| `SEARXNG_PUBLIC_INSTANCE` | false | Enable public instance features |
| `SEARXNG_VALKEY_URL` | — | Valkey connection URL |
| `GRANIAN_*` | — | Granian ASGI server tuning |
| `FORCE_OWNERSHIP` | true | Ensure correct file ownership on mounted volumes |

### 8.5 Generating the Secret Key

```bash
# Generate and inject secret key
openssl rand -hex 32

# Or generate and write directly to settings.yml (before first start):
sed -i "s|ultrasecretkey|$(openssl rand -hex 32)|g" ./core-config/settings.yml
```

### 8.6 Recommended Production settings.yml for Private MCP Use

```yaml
use_default_settings: true

general:
  debug: false
  instance_name: "MCP Search"
  enable_metrics: true

search:
  safe_search: 0
  autocomplete: ""            # Disable autocomplete (saves outbound requests)
  default_lang: ""
  ban_time_on_fail: 10
  max_ban_time_on_fail: 300
  formats:
    - json                    # Only JSON needed for API use; skip html/csv/rss
  suspended_times:
    SearxEngineAccessDenied: 86400
    SearxEngineCaptcha: 86400
    SearxEngineTooManyRequests: 3600

server:
  secret_key: !ENV SEARXNG_SECRET
  bind_address: "[::]"
  limiter: true               # Enable — even for private use (protects your upstream budget)
  public_instance: false
  image_proxy: false          # Disable unless you need image proxying
  method: "GET"

valkey:
  url: !ENV SEARXNG_VALKEY_URL

outgoing:
  request_timeout: 3.0
  max_request_timeout: 8.0
  useragent_suffix: "private-mcp-instance"
  pool_connections: 50
  pool_maxsize: 5
  enable_http2: true

# Override specific engines
engines:
  - name: brave
    engine: brave
    disabled: false
    weight: 1.5               # Boost Brave (independent index, API-friendly)

  - name: duckduckgo
    engine: duckduckgo
    disabled: false
    weight: 1.0

  - name: startpage
    engine: startpage
    disabled: false
    weight: 1.0

  - name: mojeek
    engine: mojeek
    disabled: false           # Enable Mojeek (independent crawler)
    weight: 1.0

  # Disable Google and Bing to avoid ban risk at scale:
  - name: google
    engine: google
    disabled: true

  - name: bing
    engine: bing
    disabled: true
```

### 8.7 Hardware Requirements

| Load | RAM | CPU | Notes |
|------|-----|-----|-------|
| Single user, light | 150–250 MB | 0.1 vCPU | Idle: ~150 MB |
| MCP server (5–20 req/min) | 512 MB | 0.5 vCPU | Add 256 MB for Valkey |
| Multi-user / shared | 1–2 GB | 1–2 vCPU | Add connection pool tuning |
| High throughput (AI batch) | 2–4 GB | 2–4 vCPU | Consider multiple instances + load balancer |

Note: Memory usage spikes during concurrent queries since results are held in memory during the fan-out phase.

---

## 9. NGINX Reverse Proxy

SearXNG should never be exposed directly to the internet without TLS termination.

### 9.1 Minimal NGINX Configuration

```nginx
server {
    listen 80;
    server_name search.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name search.example.com;

    ssl_certificate     /etc/letsencrypt/live/search.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/search.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Required for limiter: pass real client IP
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_redirect off;

        # Security headers
        add_header X-Content-Type-Options nosniff;
        add_header X-Frame-Options DENY;
        add_header Referrer-Policy no-referrer;
    }
}
```

**Critical:** The `X-Forwarded-For` header must be set correctly or the IP-based rate limiter will not work (it will see the proxy IP, not the client IP).

### 9.2 For MCP Server: Restrict Access to MCP Server Only

Since the MCP server is the only client, restrict access to localhost or the MCP server's container:

```nginx
server {
    listen 127.0.0.1:8080;  # Bind only to loopback
    # or: allow 10.0.0.5; deny all;  (if MCP server is on separate host)
}
```

---

## 10. Privacy Architecture

### 10.1 What Data Each Engine Receives

When SearXNG queries an upstream engine:

| Data | Sent to engine? | Notes |
|------|-----------------|-------|
| Query text | Yes | Unavoidable |
| SearXNG server IP | Yes | Not the user's IP |
| SearXNG User-Agent | Yes | Rotated, contains SearXNG signature |
| User's IP | No | Never forwarded |
| User's cookies | No | SearXNG strips all cookies from outgoing requests |
| User's browser fingerprint | No | Structural guarantee |
| Accept-Language header | Configurable | Set `send_accept_language_header: true` per-engine for locale results |
| Session identity | No | No long-lived session on outgoing requests |

### 10.2 What SearXNG Logs

By default, SearXNG logs:
- Error messages and engine failures
- Response time metrics (if `enable_metrics: true`)
- Access logs (standard Flask/Granian access log format)

Query content is NOT logged by default. To disable access logs entirely, configure your reverse proxy or WSGI server accordingly.

### 10.3 Tor Support

SearXNG can route outgoing engine requests through Tor:

```yaml
outgoing:
  using_tor_proxy: true
  proxies:
    all://:
      - socks5h://127.0.0.1:9050   # Tor SOCKS proxy
```

Per-engine Tor routing:

```yaml
engines:
  - name: google
    engine: google
    using_tor_proxy: true   # Only this engine uses Tor
```

---

## 11. SearXNG vs Whoogle vs Kagi API — Decision Guide

Sources: bigiron.cc/guides/searxng-vs-whoogle-self-hosted-meta-search-in-2026, mattcollins.net/web-search-apis-for-llms

### 11.1 Comparison Table

| Dimension | SearXNG (self-hosted) | Whoogle (self-hosted) | Kagi API (paid) | Brave Search API (paid) | Exa API (paid) |
|-----------|----------------------|----------------------|-----------------|------------------------|----------------|
| Cost | Free (infra only) | Free (infra only) | ~$0.025/search | $5/1k calls | $7/1k calls |
| Search backends | ~272 engines, all configurable | Google only | Own index + Google | Own Brave index | Exa neural index |
| Independence from Google | Full (can disable Google) | Zero (only source) | Partial | Full | Full |
| JSON API | Yes, documented | Limited | Yes, REST | Yes, REST | Yes, REST |
| Rate limiting | Your server's limits | Your server's limits | Per plan | Per plan | Per plan |
| Maintenance burden | Medium (engine modules break) | Low (but fragile to Google changes) | None | None | None |
| Result quality | Variable (weighted ensemble) | Google quality | Excellent, curated | Good, independent | Excellent for neural search |
| CAPTCHA risk | High (Google/Bing) | Very high (single source) | None | None | None |
| Latency | 2–5s (fan-out) | 1–3s (single source) | < 1s | < 500ms | < 1s |
| Multi-engine diversity | Excellent | None | Limited | None | Semantic search |
| Self-hosted | Yes | Yes | No | No | No |
| AI-agent optimized | Requires tuning | No | Partial | Yes | Yes (built for RAG) |
| License | AGPL-3.0 | MIT | Proprietary | Proprietary | Proprietary |

### 11.2 When to Use SearXNG

- You need cost-zero search at reasonable query rates (< 100 queries/hour per instance)
- You want multi-engine result diversity (finding things Google buries)
- You need niche search categories: science (arXiv, PubMed), IT (GitHub, StackOverflow), maps
- Data sovereignty matters (queries never leave your infrastructure)
- You're building a retrieval layer for a private LLM with no budget for paid APIs
- You can tolerate occasional engine failures gracefully

### 11.3 When to Use Brave Search API Instead

- Query volume is high (> 500/day) and CAPTCHA risk is unacceptable
- You need < 500ms latency
- You need a clean, simple REST API without self-hosting complexity
- $5/1k calls is acceptable (= $0.005/search)
- You want to supplement SearXNG (run both in parallel, merge results in MCP layer)

**Recommendation for markdown-for-agents-mcp:** Deploy SearXNG as the primary search provider and Brave Search API as the fallback when SearXNG engines are suspended or timing out. This gives you free tier for most queries with paid reliability as the safety net.

### 11.4 When to Use Exa

- The query is semantic / natural language rather than keyword-based
- You need deep page content retrieval (Exa returns entire page content, not just snippets)
- The use case is RAG-style document retrieval from the web

### 11.5 When to Use Whoogle

Honestly: rarely. Whoogle is the right pick only if you want a clean Google interface for a single user and value simplicity over flexibility. For agent use, its lack of structured JSON output and dependency on Google alone make it a poor choice.

### 11.6 Kagi

Kagi's API is not publicly priced at the time of writing and requires a Kagi account. The quality is excellent (hand-curated index, ad-free, low SEO-spam) but cost makes it unsuitable as a primary provider for automated agent workloads. Consider for supplemental fallback on low-volume, high-quality queries.

---

## 12. Optimal Configuration for AI Agent Use

### 12.1 Engine Selection for Agents

**Recommended engine set (AI agent optimized):**

```yaml
use_default_settings:
  engines:
    keep_only:
      # Primary web engines (diverse, independent indexes):
      - brave
      - duckduckgo
      - startpage
      - mojeek
      # Knowledge bases (structured, reliable):
      - wikipedia
      - wikidata
      # Science/research:
      - arxiv
      - pubmed
      - semantic scholar
      # IT/code:
      - github
      - stackoverflow
      - superuser
      - askubuntu
      - mdn
      - pypi
      - docker hub
      # News:
      - reuters
      - bing news
      - brave.news
```

**Why these engines:**
- `brave` + `mojeek`: Independent crawlers — break out of the Google filter bubble
- `duckduckgo` + `startpage`: High reliability, rarely CAPTCHA, good general coverage
- `wikipedia` + `wikidata`: Zero ban risk, authoritative structured data
- `arxiv` + `pubmed` + `semantic scholar`: Critical for research queries, designed for programmatic access
- `github` + `stackoverflow`: Most agent queries involve code — these are the authoritative sources
- `reuters`: News without opinion pollution

**Engines to avoid for agents:**
- `google` — CAPTCHA risk at scale; use `google cse` with API key or skip entirely
- `bing` — Medium risk; DuckDuckGo covers the same index with lower ban frequency
- `yandex` — Russian jurisdiction; unreliable from European/US IPs
- `baidu`, `sogou`, `quark` — Unless specifically needed for Chinese content
- Search engines with timeouts > 6s — They slow down the entire fan-out

### 12.2 Engine Weights for Agent Use

```yaml
engines:
  - name: brave
    weight: 1.5       # Independent index, boost it
  - name: mojeek
    weight: 1.3       # Independent index, boost it
  - name: duckduckgo
    weight: 1.0
  - name: startpage
    weight: 0.8       # Google proxy, slightly downweight
  - name: wikipedia
    weight: 2.0       # Authoritative — significantly boost
  - name: arxiv
    weight: 1.5       # Authoritative for research
  - name: stackoverflow
    weight: 1.5       # Authoritative for code
```

### 12.3 Categories for Agent Queries

| Agent Query Type | Best categories | Bang syntax |
|------------------|-----------------|-------------|
| General knowledge | `general` | (default) |
| Code / libraries | `it` | `?categories=it` |
| Research papers | `science` | `?categories=science` |
| Current events | `news` | `?categories=news&time_range=month` |
| Technical docs | `it,general` | `?categories=it,general` |
| Images for context | `images` | `?categories=images` |
| Maps / locations | `map` | `?categories=map` |

### 12.4 Query Syntax Tips for AI Agents

SearXNG passes query syntax through to engines that support it:

```
site:github.com typescript mcp server         → Google/Bing site: operator
filetype:pdf quantum computing tutorial       → Google filetype: operator
"exact phrase" with additional keywords       → Phrase matching
!bing query terms                             → Force only Bing
!general query terms                          → Force general category
!wp python asyncio                            → Bang to search Wikipedia only
```

---

## 13. Integrating SearXNG into markdown-for-agents-mcp

### 13.1 Architecture

```
MCP Client (AI agent)
        |
   MCP Tool Call: search(query, options)
        |
   markdown-for-agents-mcp server (Node.js/TypeScript)
        |
        +---> SearXNG HTTP API (self-hosted, localhost:8080)
        |         |
        |         +-- brave, duckduckgo, startpage, mojeek, wikipedia...
        |
        +---> Brave Search API (fallback, if SearXNG fails)
        |
   Result normalization + Markdown conversion
        |
   MCP Tool Result (Markdown content)
```

### 13.2 TypeScript SearXNG Client

```typescript
import { z } from 'zod';

// --- Types ---

const SearXNGResultSchema = z.object({
  url: z.string(),
  title: z.string(),
  content: z.string(),
  engine: z.string(),
  engines: z.array(z.string()),
  score: z.number(),
  category: z.string().optional(),
  publishedDate: z.string().optional(),
  thumbnail: z.string().optional(),
  img_src: z.string().optional(),
});

const SearXNGResponseSchema = z.object({
  query: z.string(),
  number_of_results: z.number(),
  results: z.array(SearXNGResultSchema),
  answers: z.array(z.object({ answer: z.string() })),
  corrections: z.array(z.string()),
  suggestions: z.array(z.string()),
  unresponsive_engines: z.array(
    z.object({ name: z.string(), error: z.string(), suspended: z.boolean() })
  ),
});

type SearXNGResult = z.infer<typeof SearXNGResultSchema>;
type SearXNGResponse = z.infer<typeof SearXNGResponseSchema>;

// --- Client ---

interface SearXNGSearchOptions {
  categories?: string;         // e.g. "general", "it", "science", "news"
  language?: string;           // e.g. "en", "en-US"
  pageno?: number;
  time_range?: 'day' | 'month' | 'year';
  safesearch?: 0 | 1 | 2;
  timeoutMs?: number;
}

class SearXNGClient {
  private baseUrl: string;
  private defaultTimeoutMs: number;

  constructor(baseUrl: string, defaultTimeoutMs = 8000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async search(query: string, options: SearXNGSearchOptions = {}): Promise<SearXNGResponse> {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
    });

    if (options.categories) params.set('categories', options.categories);
    if (options.language) params.set('language', options.language);
    if (options.pageno) params.set('pageno', String(options.pageno));
    if (options.time_range) params.set('time_range', options.time_range);
    if (options.safesearch !== undefined) params.set('safesearch', String(options.safesearch));

    const url = `${this.baseUrl}/search?${params.toString()}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.defaultTimeoutMs
    );

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 403) {
          throw new Error(
            'SearXNG returned 403 — ensure json is listed in search.formats in settings.yml'
          );
        }
        throw new Error(`SearXNG HTTP error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return SearXNGResponseSchema.parse(data);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Convert SearXNG results to Markdown for MCP tool output */
  resultsToMarkdown(response: SearXNGResponse, maxResults = 10): string {
    const lines: string[] = [];

    // Direct answers first (calculator results, unit conversions, etc.)
    if (response.answers.length > 0) {
      lines.push('**Direct answer:**', response.answers.map(a => a.answer).join('\n'), '');
    }

    // Main results
    const results = response.results.slice(0, maxResults);
    for (const r of results) {
      lines.push(`### [${r.title}](${r.url})`);
      if (r.publishedDate) {
        lines.push(`*${r.publishedDate} — via ${r.engines.join(', ')}*`);
      } else {
        lines.push(`*via ${r.engines.join(', ')}*`);
      }
      lines.push('', r.content, '');
    }

    // Suggestions
    if (response.suggestions.length > 0) {
      lines.push('---');
      lines.push(`**Related searches:** ${response.suggestions.join(', ')}`);
    }

    // Transparency: note any failures
    const suspended = response.unresponsive_engines.filter(e => e.suspended);
    if (suspended.length > 0) {
      lines.push('', `*Note: ${suspended.length} engine(s) suspended: ${suspended.map(e => e.name).join(', ')}*`);
    }

    return lines.join('\n');
  }
}

export { SearXNGClient, SearXNGResponse, SearXNGResult };
```

### 13.3 MCP Tool Definition

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SearXNGClient } from './searxng-client.js';

const searxng = new SearXNGClient(
  process.env.SEARXNG_URL ?? 'http://localhost:8080'
);

server.tool(
  'searxng_search',
  'Search the web using a self-hosted SearXNG metasearch engine. Returns results from multiple search engines merged and deduplicated.',
  {
    query: z.string().describe('The search query'),
    categories: z
      .enum(['general', 'images', 'news', 'science', 'it', 'map', 'music', 'videos'])
      .optional()
      .default('general')
      .describe('Search category'),
    time_range: z
      .enum(['day', 'month', 'year'])
      .optional()
      .describe('Restrict results to a time range'),
    language: z
      .string()
      .optional()
      .describe('Language code (e.g. "en", "de", "fr")'),
    max_results: z
      .number()
      .min(1)
      .max(20)
      .optional()
      .default(10)
      .describe('Maximum results to return'),
  },
  async ({ query, categories, time_range, language, max_results }) => {
    try {
      const response = await searxng.search(query, {
        categories,
        time_range,
        language,
      });

      const markdown = searxng.resultsToMarkdown(response, max_results);
      const resultCount = response.results.length;

      return {
        content: [
          {
            type: 'text',
            text: `Found ${resultCount} results for "${query}"\n\n${markdown}`,
          },
        ],
      };
    } catch (error) {
      // Return error as tool failure rather than crashing
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Search failed: ${message}` }],
        isError: true,
      };
    }
  }
);
```

### 13.4 Health Check and Fallback Pattern

```typescript
async function searchWithFallback(
  query: string,
  options: SearXNGSearchOptions
): Promise<SearXNGResponse | BraveSearchResponse> {
  // Try SearXNG first
  try {
    const result = await searxng.search(query, options);

    // Check if enough engines responded (quality gate)
    const validEngines = result.results.filter(r => r.engines.length > 0);
    if (validEngines.length >= 3) {
      return result;
    }

    // Insufficient results — check why
    const suspended = result.unresponsive_engines.filter(e => e.suspended);
    if (suspended.length > 3) {
      console.warn(`SearXNG degraded: ${suspended.length} engines suspended, falling back to Brave`);
      return await braveSearch(query, options);
    }

    return result;
  } catch (error) {
    console.warn('SearXNG unavailable, falling back to Brave:', error);
    return await braveSearch(query, options);
  }
}
```

### 13.5 Side-by-Side: SearXNG + Brave as Dual Providers

```typescript
// Run SearXNG and Brave in parallel, merge results, deduplicate by URL
async function parallelSearch(query: string): Promise<MergedResult[]> {
  const [searxResults, braveResults] = await Promise.allSettled([
    searxng.search(query, { categories: 'general' }),
    brave.search(query),
  ]);

  const allResults: MergedResult[] = [];
  const seenUrls = new Set<string>();

  // Process SearXNG results
  if (searxResults.status === 'fulfilled') {
    for (const r of searxResults.value.results) {
      const normalized = normalizeUrl(r.url);
      if (!seenUrls.has(normalized)) {
        seenUrls.add(normalized);
        allResults.push({ ...r, source: 'searxng' });
      }
    }
  }

  // Add unique Brave results
  if (braveResults.status === 'fulfilled') {
    for (const r of braveResults.value.web.results) {
      const normalized = normalizeUrl(r.url);
      if (!seenUrls.has(normalized)) {
        seenUrls.add(normalized);
        allResults.push({ url: r.url, title: r.title, content: r.description, source: 'brave' });
      }
    }
  }

  return allResults;
}
```

---

## 14. Performance Benchmarks and Latency

### 14.1 Typical Latency Profile

SearXNG latency is governed by the slowest engine within its timeout window, since the fan-out is parallel.

| Configuration | Cold P50 | Cold P95 | Notes |
|--------------|----------|----------|-------|
| 2 engines, 3s timeout | 800ms | 2.8s | Brave + DuckDuckGo |
| 5 engines, 3s timeout | 1.2s | 3.0s | Limited by timeout |
| 10 engines, 3s timeout | 1.5s | 3.0s | Most engines respond by 1.5s |
| With Google enabled | 2.0s | 3.0s | Google is the slowest engine |
| Science category (arXiv) | 1.5s | 3.0s | arXiv API is fast |

**Key insight:** Adding more engines does NOT proportionally increase latency because the fan-out is concurrent. The total query time approaches `min(request_timeout, max_engine_latency)`. The practical ceiling for most deployments is the configured `request_timeout` (default 2.0s).

**There is no result cache.** Every query hits live upstream engines. If you need sub-100ms latency, implement application-level caching in your MCP server (TTL-based, keyed on normalized query).

### 14.2 Resource Usage Under Load

| Metric | Single query | 10 concurrent queries |
|--------|-------------|----------------------|
| CPU | < 5% (1 core) | 20–40% (1 core) |
| RAM | +10–50 MB peak | +100–500 MB peak |
| Outbound connections | N engines | N × 10 connections |
| Valkey operations | 1–5 (limiter checks) | 10–50 |

### 14.3 Throughput Ceiling

Without horizontal scaling, a single SearXNG instance can handle approximately:
- **50–100 queries/minute** before upstream engines start seeing the load and CAPTCHAing
- **5–10 queries/minute** safely, without triggering any rate limits

For AI agent workloads exceeding these rates, consider:
1. Multiple SearXNG instances behind a load balancer
2. Paid API providers (Brave, Exa) for overflow
3. Application-layer result caching with 5–15 minute TTL

---

## 15. Failure Modes, Edge Cases, and Gotchas

### 15.1 Engine Failure Cascade

**Problem:** Multiple engines get CAPTCHAed/suspended simultaneously (e.g., your IP hits Google, Bing, and Yahoo simultaneously during a burst).

**Symptoms:** JSON response contains only 1–2 results; `unresponsive_engines` shows many suspended entries.

**Fix:**
- Don't enable too many big-traffic engines simultaneously
- Use only independent-index engines (Brave, Mojeek, Marginalia) as primaries
- Set suspension times low for 429 (`SearxEngineTooManyRequests: 300`) for faster recovery in testing

### 15.2 JSON 403 Error

**Problem:** `curl .../search?q=test&format=json` returns HTTP 403.

**Cause:** `json` is not in the `search.formats` list in `settings.yml`.

**Fix:**
```yaml
search:
  formats:
    - json
```

### 15.3 Valkey Connection Refused

**Problem:** SearXNG fails to start with Valkey connection error.

**Cause:** `server.limiter: true` but `valkey.url` not configured, or Valkey container not running.

**Fix:** Either disable limiter (`server.limiter: false`) or ensure Valkey is running and URL is correct.

### 15.4 X-Forwarded-For Not Set

**Problem:** Limiter blocks all requests or always allows all requests.

**Cause:** NGINX not forwarding `X-Forwarded-For` header; limiter sees proxy IP instead of client IP.

**Fix:** Add to NGINX config:
```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Real-IP $remote_addr;
```
And add your proxy IP to `limiter.toml` trusted_proxies.

### 15.5 Engine Module Breakage

**Problem:** Specific engine returns no results or errors after an upstream site change.

**Cause:** Search engines change their HTML/API responses; SearXNG's parser module breaks.

**How it manifests:** Engine appears in `unresponsive_engines` with `error: "SearxEngineResponseException"`.

**Fix:** Check the SearXNG GitHub issues/PRs for a fix. Usually patched within days for major engines (Google, Brave, DDG). Minor engines may take weeks.

**Mitigation:** Don't rely on a single engine. The multi-engine approach means breakage is graceful.

### 15.6 Slow Result Page / Timeout

**Problem:** API returns quickly but with few results; many engines are timing out.

**Cause:** Network latency to upstream engines, or engines are rate-limiting you with slow responses.

**Fix:**
- Reduce `outgoing.request_timeout` (e.g., from 3.0s to 2.0s) — accept fewer results for faster response
- Disable slow engines (`timeout: 6.0` engines like crossref, 500px, adobe stock)
- Enable per-engine timeouts: `timeout: 2.0` for speed-critical engines

### 15.7 Memory Growth

**Problem:** SearXNG container memory grows over time.

**Cause:** Favicon cache SQLite DB grows unbounded; Python memory fragmentation under load.

**Fix:**
- Mount `/var/cache/searxng/` to a volume (ensures DB survives restarts)
- Set up a cron to restart the container weekly: `docker compose restart core`
- Disable favicon resolver if not needed: `search.favicon_resolver: ""`

### 15.8 searxng-docker is Archived

**Symptom:** Found a guide telling you to `git clone searxng-docker`.

**Problem:** The `searxng/searxng-docker` repository was archived on 2026-03-28.

**Fix:** Use the official compose files from the main repo:
```bash
curl -fsSL \
    -O https://raw.githubusercontent.com/searxng/searxng/master/container/docker-compose.yml \
    -O https://raw.githubusercontent.com/searxng/searxng/master/container/.env.example
```

### 15.9 AGPL-3.0 License Implications

SearXNG is AGPL-3.0. If you deploy SearXNG as a service accessible by others (even internal users on a network), you may need to provide source code access. For a private MCP server used only internally, this is typically not an issue. Consult a lawyer if building a SaaS product on top of SearXNG.

### 15.10 No Built-in Result Cache

**Gotcha:** Many developers assume SearXNG caches results in Valkey/Redis. It does not. Every query hits live engines.

**Impact on MCP server:** If an AI agent makes the same search twice (which happens during multi-step reasoning), SearXNG fires two identical fan-outs to all engines. Implement deduplication at the MCP layer.

### 15.11 Number of Results Field Unreliability

The `number_of_results` field in the JSON response is an average of engine-reported totals and is frequently unreliable. Google might report 42 million; DuckDuckGo might report 0 (it doesn't expose this). The average is often 0 or misleading. Do not display or rely on this field.

---

## 16. What to Build and What to Skip

### 16.1 Build

1. **SearXNG Docker deployment** — use the official Compose file, add settings.yml with JSON format enabled and an opinionated engine set (Brave, DDG, Startpage, Mojeek, Wikipedia as defaults)

2. **MCP tool: `searxng_search`** — query parameter, optional categories, time_range, language; returns Markdown-formatted results with source attribution

3. **Application-level result cache** — TTL-based, keyed on `hash(query + categories + language)`, 5-minute default TTL for general, 60s for news. Store in-process (LRU map) or in a shared Redis if multi-process

4. **Health-check + fallback** — monitor `unresponsive_engines` count; if > threshold, route to Brave Search API fallback

5. **Brave Search API as fallback provider** — when SearXNG is degraded or unavailable; same TypeScript interface, normalized to same result type

6. **Science category routing** — detect queries about papers/research by keyword and auto-route to `categories=science` for arXiv/PubMed/Semantic Scholar

7. **IT category routing** — detect code questions (Python, TypeScript, npm, Docker, etc.) and route to `categories=it` for GitHub/StackOverflow/MDN results

### 16.2 Skip

1. **Google and Bing engines** — too high a CAPTCHA risk for automated agent workloads at any meaningful scale. Brave + Mojeek + DDG cover their index.

2. **Captcha-solving** — Not worth the complexity. The engine will recover after the suspension period.

3. **Image/video categories** — Unless the MCP tool is specifically designed to return images to an AI model, these categories add complexity without benefit for text-based agent reasoning.

4. **Public SearXNG instance** — Running a public instance means crowd-scaling the CAPTCHA problem. Keep it private and behind auth.

5. **Multi-language engine duplicates** — Setting up `google english`, `google german`, etc. as separate engines adds latency and complexity. Better to let the agent specify the language parameter.

6. **Custom engine development** — Unnecessary for the MCP use case. The built-in engines cover all common sources. Write a custom engine only if you have a proprietary data source the agent needs to query.

7. **Whoogle** — At any point where SearXNG fits your architecture, Whoogle is the strictly inferior choice. Use SearXNG.

### 16.3 Recommended Production Stack

```
┌─────────────────────────────────────────────────┐
│             markdown-for-agents-mcp              │
│                  (Node.js)                        │
│                                                   │
│  search_web() MCP tool                           │
│      │                                            │
│      ├─── SearXNGClient ──► SearXNG :8080        │
│      │        (primary, free)                     │
│      │                                            │
│      └─── BraveAPIClient ──► api.search.brave.com│
│              (fallback, paid)                     │
│                                                   │
│  In-process LRU cache (5min TTL)                  │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│         SearXNG Docker Compose Stack             │
│                                                   │
│  searxng-core (Flask/Granian, port 8080)         │
│  searxng-valkey (Valkey 9 Alpine)                │
│  nginx (TLS termination, :443 → :8080)           │
└─────────────────────────────────────────────────┘
```

**Hardware sizing for this stack:** 1 vCPU, 1 GB RAM, 10 GB disk — covers the MCP server use case at up to ~30 queries/minute comfortably.

---

*Sources:*
- *https://docs.searxng.org (version 2026.8.22+9fea41204)*
- *https://docs.searxng.org/user/configured_engines.html*
- *https://docs.searxng.org/dev/search_api.html*
- *https://docs.searxng.org/admin/settings/settings.html*
- *https://docs.searxng.org/admin/settings/settings_engines.html*
- *https://docs.searxng.org/admin/settings/settings_search.html*
- *https://docs.searxng.org/admin/settings/settings_server.html*
- *https://docs.searxng.org/admin/settings/settings_outgoing.html*
- *https://docs.searxng.org/admin/settings/settings_valkey.html*
- *https://docs.searxng.org/admin/installation-docker.html*
- *https://docs.searxng.org/admin/searx.limiter.html*
- *https://docs.searxng.org/admin/api.html*
- *https://docs.searxng.org/admin/architecture.html*
- *https://docs.searxng.org/dev/engines/engine_overview.html*
- *https://deepwiki.com/searxng/searxng/3.3-result-processing-and-aggregation*
- *https://github.com/searxng/searxng (source: results.py, online.py)*
- *https://www.bigiron.cc/guides/searxng-vs-whoogle-self-hosted-meta-search-in-2026*
- *https://joshuaopolko.com/searxng-self-hosted-guide/*
- *https://www.mattcollins.net/web-search-apis-for-llms*
- *https://en.wikipedia.org/wiki/SearXNG*
- *https://dalf.github.io/searxng/user/configured_engines.html*
