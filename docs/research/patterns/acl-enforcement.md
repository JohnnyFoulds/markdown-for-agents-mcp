# Per-User ACL Enforcement in Enterprise Search

**Research area:** Access control patterns for the Phase 2 enterprise knowledge index  
**Scope:** SharePoint, Confluence, and future connectors. Entra ID group resolution. Qdrant + pgvector enforcement.  
**Status:** Reference — informs Phase 2 implementation decisions  
**Last updated:** 2026-08-26

---

## Table of Contents

1. [Why ACL enforcement matters for RAG](#1-why-acl-enforcement-matters-for-rag)
2. [The three canonical patterns](#2-the-three-canonical-patterns)
3. [Pattern comparison table](#3-pattern-comparison-table)
4. [Pattern C in depth: crawl-time snapshot + query-time token validation](#4-pattern-c-in-depth-crawl-time-snapshot--query-time-token-validation)
5. [Entra ID transitiveMemberOf: exact API and response format](#5-entra-id-transitivememberof-exact-api-and-response-format)
6. [Redis caching for group membership](#6-redis-caching-for-group-membership)
7. [SharePoint permission inheritance resolution](#7-sharepoint-permission-inheritance-resolution)
8. [Confluence permission model](#8-confluence-permission-model)
9. [Slack channel membership approach](#9-slack-channel-membership-approach)
10. [Qdrant payload filtering for ACL](#10-qdrant-payload-filtering-for-acl)
11. [pgvector + PostgreSQL RLS for ACL](#11-pgvector--postgresql-rls-for-acl)
12. [Competitor implementations](#12-competitor-implementations)
13. [Security failure modes and mitigations](#13-security-failure-modes-and-mitigations)
14. [Audit logging for POPIA compliance](#14-audit-logging-for-popia-compliance)
15. [Complete TypeScript ACL resolver implementation](#15-complete-typescript-acl-resolver-implementation)
16. [Decision: what to build and what to skip](#16-decision-what-to-build-and-what-to-skip)

---

## 1. Why ACL enforcement matters for RAG

Vector embeddings carry zero knowledge of file permissions. A pure similarity search across an enterprise corpus will return board meeting minutes to an intern, executive salary data to an engineer, and a disciplinary letter to the subject's colleagues — all with high confidence scores and no error messages.

The failure is architectural. When an organization indexes SharePoint libraries, Confluence spaces, and Jira tickets into a vector store, it creates a consolidated semantic index. Document-level permissions that existed in source systems do not follow the document into high-dimensional vector space unless you explicitly model them.

Attempting to solve this at the prompt layer ("Do not reveal confidential information to non-authorized users") is completely ineffective. LLM guardrails are trivially bypassed by prompt injection, jailbreaks, or indirect retrieval. Security boundaries must be enforced in the retrieval layer — before any document text reaches the model context window.

This is not a compliance footnote. It is the fundamental architectural constraint that shapes every design decision in Phase 2.

Sources: [permission-aware-rag-access-boundaries](https://digitalelliptical.com/blog/permission-aware-rag-access-boundaries/), [tianpan.co enterprise RAG access control](https://tianpan.co/blog/2026-05-04-permission-aware-retrieval-enterprise-rag-access-control)

---

## 2. The three canonical patterns

### Pattern A: Index-time stamping (static filter)

**How it works:**
At crawl/index time, the connector resolves the full set of users and groups that have read access to each document and writes that list as a flat string array field on the indexed vector chunk. At query time, the application passes the caller's user ID and group IDs as a filter against this stored array.

```
Chunk payload:
{
  "doc_id": "sp://sites/hr/docs/policy.docx",
  "content": "...",
  "allowed_principals": ["user:alice@acme.com", "group:HR-Team", "group:All-Employees"]
}

Query filter:
{ "allowed_principals": { "$in": caller_principals } }
```

**Advantages:**
- Zero latency overhead at query time beyond the filter evaluation
- Works with any vector store that supports array membership filtering
- No runtime dependency on identity provider
- Simple to implement, reason about, and test

**Disadvantages:**
- Stale ACL window: If a user's group membership changes or a document's permissions are revoked, the index still contains the old ACL until the next crawl. This can be hours or days.
- Re-index overhead: Updating a permission requires touching every chunk derived from that document
- Group explosion problem: A document accessible to 50,000 employees stores 50,000 entries in the `allowed_principals` array — or a single group ID, but then you must expand groups at query time anyway
- POSIX-like ACL inheritance must be resolved at crawl time, which means the crawl must call Graph API for every document

**When to use:** Low-sensitivity content where a 1-hour staleness window is acceptable. Good for public-within-tenant content (e.g., all-hands wiki pages, policy documents).

---

### Pattern B: Query-time filter (pure runtime)

**How it works:**
The index stores no ACL data. At query time, the caller's identity token is passed to the identity provider to resolve current group membership. The resolved group list is injected as a pre-filter on the vector query. Alternatively, the search engine calls the identity provider natively (as Azure AI Search does with `x-ms-query-source-authorization`).

**Advantages:**
- Always uses live membership — no stale window
- Permission changes (revocation, role changes) take effect within the cache TTL
- Index payloads are smaller

**Disadvantages:**
- Adds latency: every query requires an identity provider round-trip (or cache hit)
- Creates a runtime dependency on the identity provider (availability coupling)
- If the identity provider is unavailable, search is unavailable
- Cannot handle pre-filter acceleration unless groups are resolved and stored transiently

**When to use:** High-sensitivity content (legal, HR, M&A) where correctness must be instantaneous. Azure AI Search uses this approach natively for SharePoint ACLs.

---

### Pattern C: Crawl-time snapshot + query-time token validation (hybrid)

**How it works:**
This is the pattern we implement. At crawl time, the connector resolves the effective set of *group IDs* (not expanded user lists) for each document and stores them as a `allowed_groups` array in the vector chunk payload. At query time, the caller's Entra ID token is validated and their transitive group memberships are resolved from a Redis cache (populated on first request, refreshed on TTL). The resolved group set is intersected against the `allowed_groups` payload field as a pre-filter on the Qdrant query.

```
Crawl-time payload stored in Qdrant:
{
  "allowed_groups": [
    "7c20b451-...",   // Entra group OID: Finance-Team
    "a4d2e912-...",   // Entra group OID: AllStaff
  ],
  "allowed_users": [  // Direct user grants (e.g., document owner)
    "b3f1a200-..."    // Entra user OID
  ],
  "source_type": "sharepoint",
  "site_url": "https://acme.sharepoint.com/sites/finance",
  "acl_snapshot_at": 1724633600,   // Unix timestamp of last permission crawl
  "is_public_within_tenant": false
}
```

At query time:
```
1. Validate caller's Entra ID access token (JWT signature + audience claim)
2. Extract caller's OID (sub claim) from token
3. Look up Redis key: acl:groups:{oid}  → array of group OIDs
4. Cache miss → call Graph API transitiveMemberOf → store in Redis with TTL 300s
5. Build Qdrant filter: allowed_groups $has_any caller_groups OR allowed_users $has caller_oid
6. Execute vector similarity search with pre-filter
```

**Advantages:**
- No user list explosion: group OIDs are compact and bounded
- Staleness controlled: group membership cache TTL is configurable (default 5 min)
- Document ACL staleness window bounded to crawl interval (configurable, default 1 hour for SharePoint delta queries)
- Qdrant pre-filter uses indexed keyword fields — fast bitset evaluation
- Resilient to temporary Graph API unavailability via Redis cache
- Audit log can record both the filter used and the ACL snapshot timestamp

**Disadvantages:**
- Two-layer staleness: group membership can be up to TTL seconds stale, AND document ACL can be up to crawl-interval seconds stale
- Must handle the case where `allowed_groups` is empty (use `is_public_within_tenant` flag)
- Entra group OIDs must be resolved correctly (transitive membership, not just direct)

**This is what we build.**

Sources: [Azure AI Search document-level access overview](https://learn.microsoft.com/en-us/azure/search/search-document-level-access-overview), [devblogs.microsoft.com sharepoint-doc-level-access](https://devblogs.microsoft.com/ise/sharepoint-doc-level-access/)

---

## 3. Pattern comparison table

| Dimension | Pattern A (Index-time) | Pattern B (Query-time) | Pattern C (Hybrid — ours) |
|---|---|---|---|
| Permission freshness | Stale until re-crawl | Live (cache TTL) | Group: cache TTL; Doc ACL: crawl interval |
| Query latency overhead | Near zero | +50–200ms (IdP call) | +5–20ms (Redis hit), +100ms (Redis miss) |
| Index payload size | Large (user lists) | Small (no ACL) | Medium (group OIDs) |
| IdP availability dependency | None at query time | Hard | Soft (Redis fallback) |
| Supports group changes | No (until re-index) | Yes | Yes (within TTL) |
| Supports permission revocation | No (until re-crawl) | Yes | Within crawl interval |
| Implementation complexity | Low | High | Medium |
| Audit trail quality | Low (snapshot age unknown) | High | High (snapshot timestamp stored) |
| Recommended for | Low-sensitivity bulk content | High-sensitivity live content | General enterprise (our target) |

---

## 4. Pattern C in depth: crawl-time snapshot + query-time token validation

### 4.1 Data model for vector chunk payloads

Every vector chunk stored in Qdrant (or pgvector) must carry the following ACL fields. These are indexed as keyword/array payload fields for fast pre-filter evaluation.

```typescript
interface ChunkAclPayload {
  // Group OIDs from Entra ID (transitive membership resolved at crawl time)
  allowed_groups: string[];      // e.g. ["7c20b451-...", "a4d2e912-..."]
  
  // Direct user OIDs (for direct grants, not group-derived)
  allowed_users: string[];       // e.g. ["b3f1a200-..."]
  
  // Fallback: if true, accessible to all authenticated users in the tenant
  is_public_within_tenant: boolean;
  
  // Source system identifier for connector-specific logic
  source_type: "sharepoint" | "confluence" | "slack" | "web";
  
  // When the ACL snapshot was taken (Unix timestamp)
  acl_snapshot_at: number;
  
  // Source URL for provenance
  source_url: string;
  
  // Tenant ID for multi-tenant deployments
  tenant_id: string;
}
```

### 4.2 Crawl-time ACL resolution flow

```
For each document discovered by the connector:
  1. Fetch document metadata including permission scope
  2. Resolve effective permissions:
     a. Walk the inheritance hierarchy (site → library → folder → file)
     b. Find the nearest ancestor with unique permissions
     c. Collect all role assignments at that scope
  3. For each role assignment:
     a. If assigned to a user → add to allowed_users[]
     b. If assigned to a SharePoint group → expand to Entra group OIDs
     c. If assigned to an Entra group → add OID directly to allowed_groups[]
  4. Store resolved ACL arrays in chunk payload with acl_snapshot_at = now()
```

### 4.3 Query-time enforcement flow

```
Incoming query request:
  1. Authenticate: validate Entra ID JWT (RS256 signature, aud, iss, exp)
  2. Extract caller OID from token.oid claim
  3. Resolve caller's transitive group memberships:
     a. Check Redis: GET acl:groups:{oid}
     b. If cache hit: use cached group OID array (TTL ~300s)
     c. If cache miss: call Graph API transitiveMemberOf → cache result
  4. Build Qdrant pre-filter (see Section 10 for exact syntax)
  5. Execute vector search with pre-filter
  6. Log: request_id, caller_oid, group_count, filter_applied, results_count, timestamp
  7. Return results (never expose allowed_groups/allowed_users fields in response)
```

### 4.4 Deny-by-default semantics

If `allowed_groups` and `allowed_users` are both empty arrays AND `is_public_within_tenant` is false, the chunk is inaccessible to all users. This is the correct behavior for documents that were found to have no readable ACL (e.g., permissions-only accessible by site owners during crawl). The crawler must log a warning when this condition is detected, as it may indicate a permissions resolution failure.

---

## 5. Entra ID transitiveMemberOf: exact API and response format

### 5.1 Endpoint and permissions

Source: [Microsoft Graph API docs](https://learn.microsoft.com/en-us/graph/api/user-list-transitivememberof)

```
GET https://graph.microsoft.com/v1.0/users/{id | userPrincipalName}/transitiveMemberOf
GET https://graph.microsoft.com/v1.0/users/{id}/transitiveMemberOf/microsoft.graph.group
```

To get only groups (not directory roles or admin units), use the OData cast form. This is what we want for ACL resolution.

**Required permission (application context — our connector runs as a service principal):**
- `User.Read.All` (least privileged)
- `GroupMember.Read.All` (if specifically needed)
- `Directory.Read.All` (broader, avoid unless necessary)

**Required request header for OData queries:**
```
ConsistencyLevel: eventual
```
This is required when using `$select`, `$filter`, `$count`, or `$search` with directory objects.

### 5.2 Response format

```json
{
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#groups(id)",
  "@odata.count": 7,
  "value": [
    {
      "@odata.type": "#microsoft.graph.group",
      "id": "11111111-2222-3333-4444-555555555555",
      "displayName": "Finance-Team",
      "mailEnabled": false,
      "mailNickname": "financeteam",
      "securityEnabled": true
    }
  ],
  "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/{id}/transitiveMemberOf/microsoft.graph.group?$skiptoken=..."
}
```

**Important:** The response is paginated. Default and maximum page sizes are 100 and 999 objects respectively. You must follow `@odata.nextLink` until it is absent.

### 5.3 Efficient group-only query

To retrieve only group IDs (minimizing response payload), use `$select`:

```
GET https://graph.microsoft.com/v1.0/users/{oid}/transitiveMemberOf/microsoft.graph.group?$select=id&$count=true
ConsistencyLevel: eventual
```

Response will contain only `id` fields — exactly what we need for ACL filter construction.

### 5.4 Rate limits for transitiveMemberOf

Source: [Microsoft Graph throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits)

| Limit scope | Limit |
|---|---|
| Global (all services, per app across all tenants) | 130,000 requests per 10 seconds |
| Identity and access — per app for all tenants | 122 requests per 10 seconds |
| Identity and access — per app per tenant | 5 requests per 10 seconds |

**The per-app-per-tenant limit of 5 req/10s (effectively 0.5 req/s) is the binding constraint.** With 100 concurrent users, this limit will be hit within milliseconds if we call Graph API on every query. This is why Redis caching is not optional — it is architecturally mandatory.

When throttled, Microsoft Graph returns HTTP 429 with a `Retry-After` header. Implement exponential backoff with jitter. Do not retry immediately.

### 5.5 TypeScript implementation of the Graph API call

```typescript
import { Client } from "@microsoft/microsoft-graph-client";

interface GraphGroup {
  id: string;
}

async function fetchTransitiveMemberOf(
  accessToken: string,
  userOid: string
): Promise<string[]> {
  const client = Client.initWithMiddleware({
    authProvider: {
      getAccessToken: async () => accessToken,
    },
  });

  const groupIds: string[] = [];
  let nextLink: string | undefined =
    `/users/${userOid}/transitiveMemberOf/microsoft.graph.group?$select=id&$count=true`;

  while (nextLink) {
    const response: {
      value: GraphGroup[];
      "@odata.nextLink"?: string;
    } = await client.api(nextLink).header("ConsistencyLevel", "eventual").get();

    groupIds.push(...response.value.map((g) => g.id));
    nextLink = response["@odata.nextLink"];
  }

  return groupIds;
}
```

**Note:** The service principal used by the connector must be granted `GroupMember.Read.All` (application permission, not delegated) in Entra ID and admin-consented by a tenant administrator. The access token passed to this function must be obtained by the connector's service principal, not the end-user's delegated token.

---

## 6. Redis caching for group membership

### 6.1 Why Redis

Group membership lookups must be fast. A 100ms identity provider call on every vector search query would double retrieval latency and exceed Graph API rate limits. Redis provides sub-millisecond key-value lookup, built-in TTL, and atomic operations for cache refresh.

### 6.2 Key schema

```
acl:groups:{user_oid}         → JSON array of group OIDs (string[])
acl:groups:{user_oid}:ts      → Unix timestamp of last refresh (for audit)
acl:version                   → Global cache version (for forced invalidation)
```

Example:
```
acl:groups:b3f1a200-9b1c-4e2a-8d3f-7f6e5d4c3b2a
→ ["7c20b451-...", "a4d2e912-...", "3d41b7c2-..."]
TTL: 300 seconds
```

### 6.3 TTL policy

| Content sensitivity | Recommended TTL |
|---|---|
| General enterprise (our default) | 300 seconds (5 minutes) |
| High-sensitivity (HR, legal, M&A) | 60 seconds |
| Low-sensitivity (public wiki) | 1800 seconds (30 minutes) |

**Do not set TTL to 0 (no expiry).** Group membership changes — new hires, leavers, role changes — must propagate within a bounded window. A former employee must not continue to have search access after their account is disabled.

The 300-second default means a user removed from a group will continue to see that group's content for up to 5 minutes. This is the "soft" staleness window. For content where this is unacceptable, use the 60-second TTL tier (configurable per-connector or per-document-sensitivity-label).

### 6.4 Cache invalidation triggers

Beyond TTL-based expiry, implement active invalidation for:

1. **User token revocation webhook:** If Entra sends a token revocation event (via Azure Event Grid or a webhook), immediately delete `acl:groups:{oid}` from Redis. This ensures immediate enforcement.
2. **Connector crawl completion:** When a full permission recrawl completes, increment `acl:version` to invalidate all cached entries that predate the recrawl.
3. **Manual admin flush:** Provide an `/api/admin/acl/flush?user={oid}` endpoint for emergency invalidation (required for immediate offboarding).

### 6.5 Cache refresh implementation

```typescript
import { createClient } from "redis";

const redis = createClient({ url: process.env.REDIS_URL });

const GROUP_CACHE_TTL_SECONDS = 300;

export async function resolveUserGroups(
  userOid: string,
  graphAccessToken: string
): Promise<string[]> {
  const cacheKey = `acl:groups:${userOid}`;

  // 1. Try cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as string[];
  }

  // 2. Cache miss — fetch from Graph API
  const groupIds = await fetchTransitiveMemberOf(graphAccessToken, userOid);

  // 3. Store in cache with TTL
  await redis.set(cacheKey, JSON.stringify(groupIds), {
    EX: GROUP_CACHE_TTL_SECONDS,
  });

  // 4. Store refresh timestamp for audit
  await redis.set(`${cacheKey}:ts`, String(Date.now()), {
    EX: GROUP_CACHE_TTL_SECONDS + 60, // slightly longer so audit can always read it
  });

  return groupIds;
}

export async function invalidateUserGroupCache(userOid: string): Promise<void> {
  await redis.del(`acl:groups:${userOid}`);
  await redis.del(`acl:groups:${userOid}:ts`);
}
```

### 6.6 Redis data structure choice

Use **String** (not Hash or Set) for the group ID array. JSON serialization is cheap for arrays of 36-character UUID strings. The key lookup and JSON parse are both O(1). For a user with 500 group memberships (a heavy enterprise user), the stored value is roughly 20KB — easily within Redis memory budgets.

Do **not** use Redis Sets for group IDs. The `SMEMBERS` operation returns members in undefined order, which is fine, but Redis Sets have per-member overhead compared to a single serialized JSON string. The primary operation is "does caller's group list intersect with document's group list?" — which is best done in application code after fetching both arrays, not with Redis set operations.

### 6.7 Graph API circuit breaker

If Graph API is unavailable and the cache key has expired:

```typescript
export async function resolveUserGroupsWithFallback(
  userOid: string,
  graphAccessToken: string
): Promise<{ groups: string[]; fromCache: boolean; cacheAge: number | null }> {
  const cacheKey = `acl:groups:${userOid}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    const tsKey = `${cacheKey}:ts`;
    const ts = await redis.get(tsKey);
    const cacheAge = ts ? Date.now() - Number(ts) : null;
    return { groups: JSON.parse(cached), fromCache: true, cacheAge };
  }

  try {
    const groupIds = await fetchTransitiveMemberOf(graphAccessToken, userOid);
    await redis.set(cacheKey, JSON.stringify(groupIds), {
      EX: GROUP_CACHE_TTL_SECONDS,
    });
    return { groups: groupIds, fromCache: false, cacheAge: 0 };
  } catch (err) {
    // Graph API unavailable — fail closed (deny access)
    // Do NOT fail open — that would be a security vulnerability
    throw new Error(
      `ACL resolution failed for user ${userOid}: Graph API unavailable and cache expired. Access denied.`
    );
  }
}
```

**Fail closed, not open.** If group membership cannot be resolved and there is no cached value, deny the request with 503. Do not fall back to returning all documents.

---

## 7. SharePoint permission inheritance resolution

### 7.1 SharePoint permission hierarchy

Source: [Microsoft Learn SharePoint permission inheritance](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/role-inheritance-elevation-of-privilege-and-password-changes-in-sharepoint)

Every SharePoint object (site collection → site → library → folder → item/file) either inherits permissions from its parent or has unique permissions. The hierarchy is:

```
Site Collection (root scope)
  └── Site
        └── Document Library
              └── Folder
                    └── File / List Item
```

**Rules:**
- An object inherits permissions by default
- Inheritance is broken when an admin runs "Stop Inheriting Permissions," which copies the parent's role assignments into a new independent scope on the child
- SharePoint does NOT support partial inheritance (inherit some + add own)
- Permissions are either fully inherited or fully unique at each object level

**To resolve effective permissions for a file:**
1. Check if the file has unique permissions (`HasUniqueRoleAssignments = true`)
2. If yes → use the file's role assignments
3. If no → check the parent folder
4. If folder has unique permissions → use folder's role assignments
5. If no → check the document library
6. Continue up the hierarchy until an object with unique permissions is found
7. The site collection always has unique permissions (root)

### 7.2 SharePoint REST API calls for permission resolution

```typescript
// Check if a document has unique permissions
const metadata = await sharepointClient.get(
  `${siteUrl}/_api/web/GetFileByServerRelativeUrl('${fileUrl}')/ListItemAllFields?$select=HasUniqueRoleAssignments`
);

// Get role assignments for an item with unique permissions
const permissions = await sharepointClient.get(
  `${siteUrl}/_api/web/GetFileByServerRelativeUrl('${fileUrl}')/ListItemAllFields/RoleAssignments?$expand=Member,RoleDefinitionBindings`
);
```

**RoleAssignments response includes:**
- `Member`: the principal (user or group) — has `PrincipalType` (1=user, 4=SP group, 8=distribution list), `LoginName`, `Id`
- `RoleDefinitionBindings`: list of roles (e.g., "Read", "Contribute", "Full Control")

### 7.3 Converting SharePoint groups to Entra group OIDs

SharePoint groups are SharePoint-specific; they don't map directly to Entra groups. A SharePoint group can contain:
- Entra users (identified by `i:0#.f|membership|user@domain.com` login name)
- Entra groups (identified by `c:0t.c|tenant|{entra-group-oid}` login name)
- Other SharePoint groups (nested, resolved recursively)

**Algorithm:**
```
for each RoleAssignment in permissions:
  if Member.PrincipalType == 1:  // Direct user
    extract Entra OID from LoginName
    add to allowed_users[]
  if Member.PrincipalType == 4:  // SharePoint group
    fetch SharePoint group members (recursive)
    for each member:
      if Entra user → add OID to allowed_users[]
      if Entra group → add group OID to allowed_groups[]
  if Member.PrincipalType == 8:  // Distribution list
    resolve via Graph API → add to allowed_groups[]
```

To extract the Entra group OID from a SharePoint group member's LoginName:
```
c:0t.c|tenant|7c20b451-1234-5678-9abc-def012345678
                       ^--- this is the Entra group OID
```

### 7.4 SharePoint delta queries for incremental permission sync

Source: [Azure AI Search incremental SharePoint permissions sync](https://en.ittrip.xyz/microsoft-365/sharepoint-acl-sync)

Use Microsoft Graph change notifications or SharePoint delta queries to detect permission changes since the last crawl:

```
GET https://graph.microsoft.com/v1.0/sites/{site-id}/drive/root/delta?token={delta-token}
```

This returns only changed items since the last delta token. For each changed item, re-resolve effective permissions and update the Qdrant payload. This avoids full re-crawls for large libraries.

**Recommended crawl cadence:**
- Full permission crawl on initial index
- Delta crawl every 60 minutes
- On-demand crawl triggered by SharePoint webhook on `file.modified` or `permissions.changed` events

---

## 8. Confluence permission model

### 8.1 Permission layers

Confluence has three independent permission layers that ALL must be checked:

1. **Global permissions** — site-level. `Can Use` permission is the gate to entering Confluence at all. Assigned to users or groups via the Confluence admin panel.

2. **Space permissions** — each space has independent permissions. Controls who can `View Space`, `Add Pages`, `Add Blog Posts`, `Add Comments`, etc. Managed per-space by space administrators.

3. **Page restrictions** — individual pages can be restricted for `View` and/or `Edit` to specific users or groups. Page restrictions override space permissions (more restrictive).

Source: [Atlassian Confluence permissions and restrictions](https://confluence.atlassian.com/docm/latest/permissions-and-restrictions-986874941.html)

### 8.2 Effective permission resolution algorithm

A user can view a page if and only if ALL of the following are true:
- User has global `Can Use` permission (or is included via group that does)
- User has space `View Space` permission (or is in a group with this permission)
- The page has no View restriction, OR the user (or one of their groups) is explicitly in the View restriction list

```typescript
interface ConfluenceAcl {
  allowed_groups: string[];   // Group IDs with view access at space level
  allowed_users: string[];    // User IDs with direct view access
  has_page_restriction: boolean;
  page_restriction_groups: string[];  // Only populated if has_page_restriction = true
  page_restriction_users: string[];
  space_key: string;
}

function resolveConfluenceEffectiveAcl(
  spacePermissions: SpacePermission[],
  pageRestrictions: PageRestriction[]
): ConfluenceAcl {
  // Start with space-level view permissions
  const spaceViewGroups = spacePermissions
    .filter(p => p.operation.key === 'read' && p.subject.type === 'group')
    .map(p => p.subject.identifier);
    
  const spaceViewUsers = spacePermissions
    .filter(p => p.operation.key === 'read' && p.subject.type === 'user')
    .map(p => p.subject.identifier);

  // Check for page-level view restrictions (more restrictive)
  const viewRestrictions = pageRestrictions
    .filter(r => r.operation === 'view');

  if (viewRestrictions.length === 0) {
    // No page restriction — effective ACL is the space permissions
    return {
      allowed_groups: spaceViewGroups,
      allowed_users: spaceViewUsers,
      has_page_restriction: false,
      page_restriction_groups: [],
      page_restriction_users: [],
      space_key: '',
    };
  }

  // Page has restrictions — effective ACL is the INTERSECTION:
  // Must be in space permissions AND in page restriction list
  const restrictionGroups = viewRestrictions
    .filter(r => r.subject.type === 'group')
    .map(r => r.subject.identifier);
    
  const restrictionUsers = viewRestrictions
    .filter(r => r.subject.type === 'user')
    .map(r => r.subject.identifier);

  return {
    allowed_groups: spaceViewGroups.filter(g => restrictionGroups.includes(g)),
    allowed_users: [
      ...spaceViewUsers.filter(u => restrictionUsers.includes(u)),
      ...restrictionUsers, // direct restriction grants override space
    ],
    has_page_restriction: true,
    page_restriction_groups: restrictionGroups,
    page_restriction_users: restrictionUsers,
    space_key: '',
  };
}
```

### 8.3 Confluence REST API v2 endpoints

Source: [Atlassian Confluence Cloud REST API v2](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space-permissions/)

```
GET /wiki/api/v2/spaces/{space-id}/permissions
  → Returns space permissions (viewer requires: 'Can use' global permission)

GET /wiki/api/v2/pages/{page-id}/restrictions
  → Returns view/edit restrictions on a specific page

GET /wiki/api/v2/pages/{page-id}/ancestors
  → Returns ancestor hierarchy (for inherited restrictions)
```

**Note:** Confluence page restrictions do NOT inherit. A restriction on a parent page does not automatically apply to child pages. Child pages inherit the space-level ACL unless they have their own restrictions. This is different from SharePoint which inherits down the hierarchy.

### 8.4 Confluence group ID format

Confluence uses Atlassian's account ID system. Groups have UUIDs in the format `ari:cloud:identity::group/{uuid}`. Users have Atlassian Account IDs (`accountId`). These are NOT the same as Entra group OIDs.

For enterprises using Entra ID + Atlassian Access (SSO), the mapping between Entra groups and Confluence groups must be maintained via SCIM provisioning. The connector must either:
1. Store Atlassian group IDs and map them to Entra group OIDs via a maintained mapping table, or
2. At query time, translate the caller's Entra group OIDs to Atlassian group IDs before applying the filter

**Recommendation:** Store Atlassian group IDs in the payload AND maintain a mapping table `{ atlassian_group_id → entra_group_oid }` populated during the initial identity sync crawl. Refresh this mapping on the same schedule as the group membership cache.

---

## 9. Slack channel membership approach

### 9.1 Slack's permission model for search

Slack's access model for channel messages is:
- Public channels: visible to all workspace members
- Private channels: only visible to members of that channel
- Direct messages: only visible to participants
- Shared channels (Enterprise Grid): visible to members across connected workspaces

There are no role-based permissions within a channel — you either are a member or you are not.

### 9.2 Recommended approach: member-list at crawl time

For Slack connectors, the correct pattern is:

1. At crawl time, enumerate all channels using `conversations.list` (paginated, type=`private_channel,mpim`)
2. For each private channel, fetch its member list using `conversations.members`
3. Store the member Slack User IDs as `allowed_users[]` in the chunk payload

Source: [Slack conversations.members API](https://docs.slack.dev/reference/methods/conversations.members/)

```
GET https://slack.com/api/conversations.members?channel={channel_id}&limit=200
Headers: Authorization: Bearer xoxb-...
```

Response:
```json
{
  "ok": true,
  "members": ["U1234567", "U2345678", "U3456789"],
  "response_metadata": {
    "next_cursor": "dGVhbTpDMDYxRkFUMkY="
  }
}
```

### 9.3 Slack user ID to Entra OID mapping

Slack User IDs (`U1234567`) are not Entra OIDs. Enterprise workspaces configured with Entra ID SSO will have a user identity link. To build the mapping:

```
GET https://slack.com/api/users.info?user={slack_user_id}
→ Response includes profile.email

Then:
GET https://graph.microsoft.com/v1.0/users?$filter=mail eq '{email}'&$select=id
→ Returns Entra user OID
```

Build and maintain a `{ slack_user_id → entra_oid }` mapping table. Use this to store Entra OIDs in `allowed_users[]` for Slack chunks, keeping consistent with the SharePoint/Confluence ACL model.

### 9.4 What to skip for Slack

Do not attempt to model DM access control. Index only public channels and (optionally) private channels. DM content is too sensitive and too granular to index safely. If a user asks about a topic that was discussed in a DM they were party to, the answer is that DM content is not indexed.

---

## 10. Qdrant payload filtering for ACL

### 10.1 Why Qdrant for this use case

Qdrant's payload filtering system is purpose-built for the pattern we need: boolean pre-filtering on array metadata fields before vector similarity search. The filter is evaluated against a payload index (not a sequential scan), making it efficient at scale.

Source: [Qdrant filtering documentation](https://qdrant.tech/documentation/concepts/filtering/)

### 10.2 Required payload indexes

Before ingesting any data, create keyword payload indexes on the ACL fields:

```typescript
import { QdrantClient } from "@qdrant/js-client-rest";

const qdrant = new QdrantClient({ url: process.env.QDRANT_URL });

// Create indexes for ACL fields (do this once at collection creation)
await qdrant.createPayloadIndex("enterprise_knowledge", {
  field_name: "allowed_groups",
  field_schema: "keyword",  // keyword type supports array values and MatchAny
});

await qdrant.createPayloadIndex("enterprise_knowledge", {
  field_name: "allowed_users",
  field_schema: "keyword",
});

await qdrant.createPayloadIndex("enterprise_knowledge", {
  field_name: "is_public_within_tenant",
  field_schema: "bool",
});

await qdrant.createPayloadIndex("enterprise_knowledge", {
  field_name: "tenant_id",
  field_schema: "keyword",
});
```

**Critical:** Create payload indexes BEFORE ingesting data, not after. Qdrant builds the index incrementally as data is ingested. Creating an index on an existing collection with data triggers a rebuild, which can be slow.

### 10.3 ACL filter construction

```typescript
interface QdrantAclFilter {
  must: AclMustClause[];
}

function buildAclFilter(
  callerOid: string,
  callerGroupIds: string[],
  tenantId: string
): object {
  // The filter reads:
  // (tenant_id == our_tenant)
  // AND
  // (
  //   is_public_within_tenant == true
  //   OR allowed_users contains caller_oid
  //   OR allowed_groups contains any of caller_group_ids
  // )

  return {
    must: [
      {
        key: "tenant_id",
        match: { value: tenantId },
      },
      {
        should: [
          {
            key: "is_public_within_tenant",
            match: { value: true },
          },
          {
            key: "allowed_users",
            match: { value: callerOid },  // "match.value" on keyword array = contains
          },
          ...(callerGroupIds.length > 0
            ? [
                {
                  key: "allowed_groups",
                  match: { any: callerGroupIds },  // MatchAny — efficient batch membership test
                },
              ]
            : []),
        ],
      },
    ],
  };
}
```

**Use `match.any` instead of multiple `should` conditions for group list matching.** From [Qdrant documentation](https://qdrant.tech/documentation/concepts/filtering/): "If all conditions inside `should` target the same field, use `match any` instead. It's faster, especially when filtering on a large number of values." This is the `MatchAny` condition.

### 10.4 Full vector search with ACL pre-filter

```typescript
async function searchWithAcl(
  queryVector: number[],
  callerOid: string,
  callerGroupIds: string[],
  tenantId: string,
  topK: number = 10
): Promise<SearchResult[]> {
  const aclFilter = buildAclFilter(callerOid, callerGroupIds, tenantId);

  const results = await qdrant.search("enterprise_knowledge", {
    vector: queryVector,
    filter: aclFilter,
    limit: topK * 2, // Over-fetch because ACL filter may trim ANN candidates
    with_payload: true,
    with_vectors: false,
    score_threshold: 0.5,
  });

  // Strip ACL fields from returned payload — callers should not see who else has access
  return results.map((r) => ({
    id: r.id,
    score: r.score,
    payload: {
      source_url: r.payload?.source_url,
      source_type: r.payload?.source_type,
      content: r.payload?.content,
      // Deliberately exclude: allowed_groups, allowed_users, is_public_within_tenant
    },
  }));
}
```

**Over-fetch:** Request `topK * 2` from Qdrant when ACL filters are applied. Qdrant's HNSW index does approximate nearest-neighbor search on the full corpus, then the payload filter trims the result set. If you request exactly `topK`, you may get fewer than `topK` results after trimming. Over-fetching ensures the final result list is adequately populated.

### 10.5 Handling empty group list

If the caller has no group memberships (rare but possible for service accounts or edge cases), the `match.any` clause will have an empty array. Test this edge case:

```typescript
// Edge case: caller has no groups
if (callerGroupIds.length === 0) {
  // Remove the allowed_groups clause entirely — don't send match.any with empty array
  // Qdrant behavior with empty match.any array is undefined across versions
  return buildAclFilterUsersOnly(callerOid, tenantId);
}
```

---

## 11. pgvector + PostgreSQL RLS for ACL

### 11.1 When to use pgvector instead of Qdrant

pgvector with PostgreSQL RLS is the right choice when:
- You are already running PostgreSQL (Supabase, AWS RDS, self-hosted)
- You need transactional consistency between the vector store and a relational data model
- You want database-enforced isolation (not application-enforced)
- You have moderate scale (< 10M vectors)

For our Phase 2, Qdrant is the primary vector store. This section documents pgvector as a secondary option and provides the security-correct implementation pattern.

### 11.2 The security-definer trap

Source: [Virginia Mwega — pgvector RLS multi-tenant isolation](https://virginiamwegahashnodedev.hashnode.dev/pgvector-rls-multi-tenant-isolation)

This is the most common and dangerous pgvector security mistake:

```sql
-- DANGEROUS: security definer bypasses RLS
CREATE FUNCTION match_documents(query_embedding vector(1536), match_count int)
RETURNS SETOF embeddings
LANGUAGE sql
SECURITY DEFINER  -- ← THIS BYPASSES ROW LEVEL SECURITY
AS $$
  SELECT * FROM embeddings
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
```

A function marked `SECURITY DEFINER` runs with the privileges of the function owner, not the calling user. RLS policies are evaluated based on the calling role. If the function owner has `BYPASSRLS` privilege, **all RLS policies are silently ignored** and every user can see every row.

**Correct implementation:**
```sql
-- Enable RLS on the embeddings table
ALTER TABLE embeddings ENABLE ROW LEVEL SECURITY;

-- Force RLS even for table owner
ALTER TABLE embeddings FORCE ROW LEVEL SECURITY;

-- Policy: users can only see their own tenant's embeddings
CREATE POLICY "tenant_isolation" ON embeddings
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- SAFE: security invoker (default) — RLS applies based on the CALLING user
CREATE FUNCTION match_documents(query_embedding vector(1536), match_count int)
RETURNS SETOF embeddings
LANGUAGE sql
SECURITY INVOKER  -- ← explicit, RLS still applies
AS $$
  SELECT * FROM embeddings
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
```

**Set the tenant context before each query:**
```typescript
await pool.query(
  `SET LOCAL app.current_tenant_id = $1`,
  [callerTenantId]
);
const results = await pool.query(
  `SELECT *, embedding <=> $1 as distance 
   FROM embeddings 
   WHERE allowed_groups && $2::uuid[]
      OR allowed_users @> ARRAY[$3::uuid]
      OR is_public_within_tenant = true
   ORDER BY distance
   LIMIT $4`,
  [queryEmbedding, callerGroupIds, callerOid, topK]
);
```

### 11.3 PostgreSQL array operators for ACL

```sql
-- Does allowed_groups array overlap with caller's groups?
allowed_groups && ARRAY['uuid1', 'uuid2']::uuid[]   -- overlap operator

-- Does allowed_users contain the caller's OID?
allowed_users @> ARRAY['caller-oid']::uuid[]        -- contains operator

-- Create GIN index for array overlap queries
CREATE INDEX ON embeddings USING GIN(allowed_groups);
CREATE INDEX ON embeddings USING GIN(allowed_users);
```

### 11.4 Performance warning for pgvector + RLS

The pgvector HNSW index does approximate nearest-neighbor search before RLS predicates are applied. The index returns ~`ef_search` candidates, then RLS trims them. If your RLS policy filters out most candidates, you may get fewer than `LIMIT` results back. The solution is the same as Qdrant: over-fetch (multiply `LIMIT` by 2–3x).

---

## 12. Competitor implementations

### 12.1 Azure AI Search (Microsoft)

Source: [Azure AI Search document-level access overview](https://learn.microsoft.com/en-us/azure/search/search-document-level-access-overview)

Azure AI Search (2026-05-01-preview) supports four access control approaches:

| Approach | Description |
|---|---|
| Security filters | Application passes user/group ID as string filter. API-agnostic, generally available. |
| POSIX-like ACL / RBAC scopes (preview) | Entra token compared to permission metadata stored on each document. For ADLS Gen2 and Azure blobs. |
| Microsoft Purview sensitivity labels (preview) | Extracts labels from SharePoint, ADLS Gen2, OneLake. Query-time enforcement via Purview policies. |
| SharePoint in Microsoft 365 ACLs (preview) | Native SharePoint permission ingestion, query-time enforcement. Uses `x-ms-query-source-authorization` header. |

**How they do it:** The SharePoint ACL approach extracts permission metadata during indexing and stores it in the search index. At query time, the caller passes their Entra token via `x-ms-query-source-authorization` header. Azure AI Search checks the token against stored permission metadata before returning results.

**How we do something similar:** We implement the same logical flow but in a self-hosted, open-source stack: Entra JWT validation + Redis group cache + Qdrant payload pre-filter.

**Limitation of their approach:** The 2026-05-01-preview has a timing lag before permission changes are recognized. Same staleness problem we have. No magic here.

### 12.2 Elasticsearch document-level security

Source: [Elastic document-level security](https://www.elastic.co/docs/deploy-manage/users-roles/cluster-or-deployment-auth/controlling-access-at-document-field-level)

Elasticsearch enforces DLS via role queries:
```json
POST /_security/role/hr_viewer {
  "indices": [{
    "names": ["enterprise-*"],
    "privileges": ["read"],
    "query": {
      "template": {
        "source": {
          "terms": { "allowed_groups": {{#toJson}}_user.metadata.group_ids{{/toJson}} }
        }
      }
    }
  }]
}
```

The `_user.metadata.group_ids` is populated from the user's metadata at authentication time. This is elegant but requires all users to have their group list pre-populated in Elasticsearch's user store — which means syncing group membership from Entra ID into Elasticsearch user metadata on every login. That's a heavy operational requirement.

**How we do something similar:** We inline the resolved group list directly into the Qdrant pre-filter at query time, without requiring a separate user metadata store. Our Redis cache serves the same purpose as the ES user metadata, but without the ES-specific operational overhead.

### 12.3 Qdrant multitenancy guide

Source: [Qdrant multitenancy documentation](https://qdrant.tech/documentation/manage-data/multitenancy/)

Qdrant's official recommendation for multi-tenant isolation is: use a `tenant_id` payload field combined with a mandatory `must` predicate. Their pattern does not natively support ACL arrays — that's a custom implementation.

For permission-aware RAG, the community pattern (from [bestaiweb.ai](https://www.bestaiweb.ai/how-to-implement-metadata-filtering-in-qdrant-weaviate-milvus-and-pinecone-in-2026/)) is:
- Isolation at the tenant level via `must` on `tenant_id`
- ACL enforcement inside the tenant scope via `should` on `allowed_groups`/`allowed_users`

This is exactly what we implement.

### 12.4 What competitors skip that we should not skip

1. **ACL snapshot timestamp in payload:** Almost no reference implementation stores `acl_snapshot_at`. Without it, you cannot tell users how fresh their access control is, and you cannot detect crawl failures. We store it.

2. **Fail-closed on cache miss:** Many implementations fail open ("if we can't check permissions, show results"). This is a security vulnerability. We fail closed with a 503.

3. **Stripping ACL fields from query responses:** Reference implementations often return the full payload including `allowed_groups`. This leaks access control metadata to callers. We strip all ACL fields from query responses.

4. **POPIA audit log:** No reference implementation covers South African POPIA audit trail requirements. We include a dedicated audit log structure (see Section 14).

---

## 13. Security failure modes and mitigations

### 13.1 Stale ACL cache attack

**Scenario:** User Alice is a member of the "Executives" group and reads confidential M&A documents. Alice is terminated and removed from the "Executives" Entra group. However, her group membership is still cached in Redis for up to 300 seconds. For the next 5 minutes, Alice can still query the system and retrieve M&A documents she is no longer authorized to see.

**Severity:** High for sensitive content (M&A, HR, legal)

**Mitigations:**
1. Set cache TTL to 60 seconds for high-sensitivity document spaces
2. Implement a webhook that calls `invalidateUserGroupCache(oid)` when Entra fires a group membership change event
3. Invalidate Alice's access token at the application level upon offboarding (separate from Entra token revocation)
4. For the highest sensitivity documents, bypass the cache and call Graph API directly (per-document-class config)

### 13.2 Privilege escalation via document ACL staleness window

**Scenario:** A new Confluence page is created with restricted access (only legal team). The connector does not crawl this page for 45 minutes. During those 45 minutes, the document DOES NOT appear in search results (it's not indexed yet). However, once indexed, it carries the correct restricted ACL — so this is not actually a privilege escalation, just a discovery delay.

**Actual risk scenario:** A document's permissions are LOOSENED (originally restricted to legal, opened to all-staff). The connector crawls this change after 45 minutes. During those 45 minutes, the document still appears restricted in search results. This is a false negative (authorized users can't find content), not a privilege escalation.

**True privilege escalation risk:** A document's permissions are TIGHTENED (was accessible to all-staff, restricted to legal only). The connector has not yet crawled this change. During the staleness window, the old ACL allows all-staff to find the document. This is the actual attack vector.

**Mitigation:** For sensitive content, use SharePoint webhooks and Confluence webhook events to trigger on-demand permission re-crawl immediately on permission change events. Target sub-5-minute latency for permission tightening events.

### 13.3 Group ID spoofing

**Scenario:** A malicious caller crafts a JWT with forged group membership claims. If the application trusts JWT group claims directly without verifying against the authoritative Graph API source, the caller can gain access to any document.

**Mitigation:** Never trust group claims from the caller's JWT token. The JWT contains an OID (user identity) which is cryptographically signed and verified. Use the OID to look up authoritative group membership from Graph API / Redis cache. Do not use the JWT's `groups` claim for ACL enforcement.

**Note:** Entra ID JWTs contain a `groups` claim, but it is subject to the "groups overage" problem: if a user is a member of more than 200 groups, the claim is omitted and replaced with a `_claim_names` object indicating that groups must be fetched from the Graph API endpoint. Building a system that relies on JWT groups claim will silently fail for heavy enterprise users with 200+ group memberships.

### 13.4 Metadata drift (payload not updated after permission change)

**Scenario:** A document's Qdrant payload has `allowed_groups: ["finance-team"]`. The Finance team Entra group is deleted. A new Entra group with the same name but a different OID is created. The chunk payload still contains the old (deleted) OID. No user can now match against this OID in their group membership list. The document becomes effectively inaccessible — a false negative, not a security breach.

**Mitigation:** During full re-crawls, explicitly detect deleted groups (Graph API returns 404 for unknown group OIDs) and either:
1. Remove the stale OID from `allowed_groups`
2. Mark the document for manual review

Log all cases where chunk ACL contains unknown group OIDs.

### 13.5 Prompt injection extracting ACL metadata

**Scenario:** A document contains the text "These salary figures are only for HR_TEAM_OID: a4d2e912-..." A malicious user crafts a query that retrieves this document and instructs the LLM to "output the OIDs you can see." The LLM reveals group OIDs.

**Mitigation:** Strip ACL fields from the context passed to the LLM. Only pass `content`, `source_url`, `source_type` to the model. ACL fields are purely for retrieval filtering and must never reach the model's context window.

### 13.6 Timing side-channel

**Scenario:** Query response time varies based on how many results the ACL filter passes. A user with broad access gets faster responses (more cache hits, fewer filter evaluations). A user could infer the approximate size of access-controlled corpora by timing responses.

**Severity:** Low — requires adversarial user with statistical sophistication

**Mitigation:** Add constant-time padding to API responses (fixed minimum response time). This is optional for Phase 2 but worth noting.

---

## 14. Audit logging for POPIA compliance

### 14.1 POPIA accountability principle

The South African Protection of Personal Information Act (POPIA) Condition 8 (Accountability) requires responsible parties to:
- Maintain records of personal information processing
- Be able to demonstrate compliance
- Keep audit trails of data access

Source: [POPIA compliance audit requirements](https://audgov.com/explore/risk-popia-privacy-controls)

For an enterprise search system that retrieves content potentially containing personal information (employee records, communications, HR documents), every retrieval must be auditable.

### 14.2 What to log per query

```typescript
interface AclAuditEvent {
  // Event identity
  event_id: string;          // UUID
  event_type: "search_query" | "acl_cache_miss" | "acl_resolution_failure";
  timestamp: string;         // ISO 8601 UTC

  // Caller identity
  caller_oid: string;        // Entra user OID (NOT email — immutable identifier)
  caller_tenant_id: string;
  session_id?: string;       // Correlate with authentication session

  // ACL resolution
  group_count: number;       // How many groups resolved
  groups_from_cache: boolean;
  cache_age_ms: number | null;
  
  // Query
  query_hash: string;        // SHA-256 of query text — do NOT log raw query (may contain PII)
  filter_applied: boolean;

  // Results
  results_returned: number;
  result_source_urls?: string[];  // Optional — omit for high-volume systems; log for compliance audits

  // Enforcement
  acl_snapshot_ages?: number[];   // Age in seconds of ACL snapshots for returned docs
  max_acl_snapshot_age: number;   // Worst-case staleness in this response
}
```

### 14.3 What NOT to log

- Raw query text (may contain personal data — names, medical conditions, etc.)
- Document content
- The caller's email address as the primary key (use OID — email can change)
- Entra group names (GUIDs are sufficient for audit; names may be sensitive)

### 14.4 Audit log storage and retention

- Store audit logs in append-only storage (never update or delete — use S3 with Object Lock or Azure Blob with immutability policy)
- Retain for minimum 3 years for POPIA compliance (match your organization's retention schedule)
- Index by `caller_oid` and `timestamp` for efficient retrieval during regulatory enquiries
- Encrypt at rest using customer-managed keys

### 14.5 TypeScript audit logger

```typescript
import crypto from "crypto";

export async function logAclAuditEvent(
  event: Omit<AclAuditEvent, "event_id" | "timestamp">
): Promise<void> {
  const auditEvent: AclAuditEvent = {
    ...event,
    event_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };

  // Write to append-only audit log (implementation depends on storage backend)
  await auditLogStorage.append(JSON.stringify(auditEvent) + "\n");
}
```

---

## 15. Complete TypeScript ACL resolver implementation

This is the full Phase 2 ACL resolver, integrating all components from the sections above.

```typescript
import { createClient } from "redis";
import { Client as GraphClient } from "@microsoft/microsoft-graph-client";
import { QdrantClient } from "@qdrant/js-client-rest";
import crypto from "crypto";

// ============================================================
// Configuration
// ============================================================

interface AclConfig {
  redis: { url: string };
  qdrant: { url: string; collection: string };
  graph: { tenantId: string; clientId: string; clientSecret: string };
  cache: {
    defaultTtlSeconds: number;
    highSensitivityTtlSeconds: number;
  };
}

// ============================================================
// Type definitions
// ============================================================

interface CallerContext {
  oid: string;          // Entra user OID (from validated JWT)
  tenantId: string;     // Entra tenant ID
  accessToken: string;  // The caller's access token (for on-behalf-of Graph calls)
}

interface SearchResult {
  id: string | number;
  score: number;
  content: string;
  source_url: string;
  source_type: string;
  acl_snapshot_at: number;
}

// ============================================================
// ACL Resolver
// ============================================================

export class AclResolver {
  private redis: ReturnType<typeof createClient>;
  private qdrant: QdrantClient;
  private config: AclConfig;

  constructor(config: AclConfig) {
    this.config = config;
    this.redis = createClient({ url: config.redis.url });
    this.qdrant = new QdrantClient({ url: config.qdrant.url });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  // ----------------------------------------------------------
  // Step 1: Resolve caller's transitive group memberships
  // ----------------------------------------------------------

  async resolveGroups(caller: CallerContext): Promise<string[]> {
    const cacheKey = `acl:groups:${caller.oid}`;
    
    // Try cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as string[];
    }

    // Cache miss — fetch from Graph API with pagination
    const groupIds = await this.fetchGroupsFromGraph(caller);
    
    // Cache result
    await this.redis.set(
      cacheKey,
      JSON.stringify(groupIds),
      { EX: this.config.cache.defaultTtlSeconds }
    );
    await this.redis.set(
      `${cacheKey}:ts`,
      String(Date.now()),
      { EX: this.config.cache.defaultTtlSeconds + 60 }
    );

    return groupIds;
  }

  private async fetchGroupsFromGraph(caller: CallerContext): Promise<string[]> {
    const graphClient = GraphClient.initWithMiddleware({
      authProvider: {
        getAccessToken: async () => caller.accessToken,
      },
    });

    const groupIds: string[] = [];
    let nextLink: string | undefined =
      `/users/${caller.oid}/transitiveMemberOf/microsoft.graph.group?$select=id&$count=true`;

    while (nextLink) {
      try {
        const response = await graphClient
          .api(nextLink)
          .header("ConsistencyLevel", "eventual")
          .get();

        groupIds.push(...response.value.map((g: { id: string }) => g.id));
        nextLink = response["@odata.nextLink"];
      } catch (err: unknown) {
        const graphErr = err as { statusCode?: number; message?: string };
        if (graphErr.statusCode === 429) {
          // Rate limited — throw to trigger retry with backoff at caller
          throw new Error(`Graph API rate limited for user ${caller.oid}: ${graphErr.message}`);
        }
        throw err;
      }
    }

    return groupIds;
  }

  // ----------------------------------------------------------
  // Step 2: Build Qdrant ACL pre-filter
  // ----------------------------------------------------------

  buildAclFilter(
    callerOid: string,
    callerGroupIds: string[],
    tenantId: string
  ): object {
    const accessConditions: object[] = [
      {
        key: "is_public_within_tenant",
        match: { value: true },
      },
      {
        key: "allowed_users",
        match: { value: callerOid },
      },
    ];

    if (callerGroupIds.length > 0) {
      accessConditions.push({
        key: "allowed_groups",
        match: { any: callerGroupIds },
      });
    }

    return {
      must: [
        {
          key: "tenant_id",
          match: { value: tenantId },
        },
        {
          should: accessConditions,
        },
      ],
    };
  }

  // ----------------------------------------------------------
  // Step 3: Execute search with ACL enforcement
  // ----------------------------------------------------------

  async search(
    queryVector: number[],
    caller: CallerContext,
    topK: number = 10
  ): Promise<SearchResult[]> {
    const startMs = Date.now();

    // Resolve group membership (Redis cache or Graph API)
    let callerGroupIds: string[];
    let groupsFromCache = true;
    let cacheAge: number | null = null;

    const cacheKey = `acl:groups:${caller.oid}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      callerGroupIds = JSON.parse(cached) as string[];
      const tsStr = await this.redis.get(`${cacheKey}:ts`);
      cacheAge = tsStr ? Date.now() - Number(tsStr) : null;
    } else {
      groupsFromCache = false;
      callerGroupIds = await this.resolveGroups(caller);
    }

    // Build pre-filter
    const aclFilter = this.buildAclFilter(
      caller.oid,
      callerGroupIds,
      caller.tenantId
    );

    // Execute vector search with ACL pre-filter
    const qdrantResults = await this.qdrant.search(
      this.config.qdrant.collection,
      {
        vector: queryVector,
        filter: aclFilter,
        limit: topK * 2,  // Over-fetch to account for ANN + filter interaction
        with_payload: true,
        with_vectors: false,
        score_threshold: 0.5,
      }
    );

    // Trim to topK
    const trimmed = qdrantResults.slice(0, topK);

    // Compute ACL snapshot ages for audit
    const now = Math.floor(Date.now() / 1000);
    const snapshotAges = trimmed.map((r) => {
      const snapshotAt = r.payload?.acl_snapshot_at as number | undefined;
      return snapshotAt ? now - snapshotAt : -1;
    });
    const maxSnapshotAge = Math.max(...snapshotAges.filter((a) => a >= 0), 0);

    // Write audit log
    await logAclAuditEvent({
      event_type: "search_query",
      caller_oid: caller.oid,
      caller_tenant_id: caller.tenantId,
      group_count: callerGroupIds.length,
      groups_from_cache: groupsFromCache,
      cache_age_ms: cacheAge,
      query_hash: crypto.createHash("sha256")
        .update(queryVector.toString())
        .digest("hex"),
      filter_applied: true,
      results_returned: trimmed.length,
      acl_snapshot_ages: snapshotAges,
      max_acl_snapshot_age: maxSnapshotAge,
    });

    // Return results with ACL fields stripped
    return trimmed.map((r) => ({
      id: r.id,
      score: r.score,
      content: r.payload?.content as string,
      source_url: r.payload?.source_url as string,
      source_type: r.payload?.source_type as string,
      acl_snapshot_at: r.payload?.acl_snapshot_at as number,
    }));
  }

  // ----------------------------------------------------------
  // Invalidation
  // ----------------------------------------------------------

  async invalidateUserCache(userOid: string): Promise<void> {
    await this.redis.del(`acl:groups:${userOid}`);
    await this.redis.del(`acl:groups:${userOid}:ts`);
  }
}
```

### 15.1 SharePoint connector ACL extraction

```typescript
interface SharePointItem {
  id: string;
  driveItem: { name: string; webUrl: string };
  hasUniqueRoleAssignments: boolean;
  roleAssignments: RoleAssignment[];
}

interface RoleAssignment {
  member: {
    principalType: 1 | 4 | 8;  // 1=user, 4=SP group, 8=DL
    loginName: string;
    id: number;
  };
  roleDefinitionBindings: { name: string }[];
}

export async function resolveSharePointItemAcl(
  siteUrl: string,
  serverRelativeUrl: string,
  sharepointClient: SPHttpClient
): Promise<{ allowed_groups: string[]; allowed_users: string[] }> {
  const allowed_groups: string[] = [];
  const allowed_users: string[] = [];

  // Walk up the hierarchy to find the nearest unique permissions scope
  let currentUrl = serverRelativeUrl;
  let hasUnique = false;
  let roleAssignments: RoleAssignment[] = [];

  while (!hasUnique && currentUrl !== "") {
    const res = await sharepointClient.get(
      `${siteUrl}/_api/web/GetItemByServerRelativeUrl('${encodeURIComponent(currentUrl)}')/HasUniqueRoleAssignments`
    );
    hasUnique = res.value;
    if (hasUnique) {
      const raRes = await sharepointClient.get(
        `${siteUrl}/_api/web/GetItemByServerRelativeUrl('${encodeURIComponent(currentUrl)}')/RoleAssignments?$expand=Member,RoleDefinitionBindings`
      );
      roleAssignments = raRes.value;
    }
    // Walk up
    currentUrl = currentUrl.substring(0, currentUrl.lastIndexOf("/"));
  }

  // Process role assignments
  for (const ra of roleAssignments) {
    const hasReadAccess = ra.roleDefinitionBindings.some(
      (r) => ["Read", "Contribute", "Edit", "Full Control"].includes(r.name)
    );
    if (!hasReadAccess) continue;

    if (ra.member.principalType === 1) {
      // Direct user — extract Entra OID from claim
      const oid = extractEntraOidFromLoginName(ra.member.loginName);
      if (oid) allowed_users.push(oid);
    } else if (ra.member.principalType === 4) {
      // SharePoint group — expand members
      const members = await expandSharePointGroup(
        siteUrl,
        ra.member.id,
        sharepointClient
      );
      allowed_groups.push(...members.groupOids);
      allowed_users.push(...members.userOids);
    }
  }

  return { allowed_groups, allowed_users };
}

function extractEntraOidFromLoginName(loginName: string): string | null {
  // Format: "i:0#.f|membership|user@domain.com" for users
  // Format: "c:0t.c|tenant|{guid}" for groups
  const groupMatch = loginName.match(/c:0t\.c\|tenant\|([0-9a-f-]{36})/i);
  if (groupMatch) return groupMatch[1];
  // For user OIDs, must look up via Graph API using email
  return null;
}
```

---

## 16. Decision: what to build and what to skip

### 16.1 Build now (Phase 2 MVP)

| Component | Rationale |
|---|---|
| Qdrant payload indexes for `allowed_groups`, `allowed_users`, `tenant_id` | Foundation — must exist before any data is ingested |
| Redis group membership cache with 300s TTL | Architecturally mandatory due to Graph API rate limits |
| Entra ID transitiveMemberOf resolver with pagination | Groups overage problem means we must paginate — never trust JWT groups claim |
| SharePoint permission inheritance resolution (walk hierarchy) | SharePoint is Connector #1 |
| Fail-closed behavior on cache miss + Graph API failure | Security requirement |
| Strip ACL fields from query response payload | Privacy requirement |
| Audit log structure with query hash, caller OID, group count, snapshot age | POPIA accountability requirement |
| `acl_snapshot_at` field on every chunk | Without this, we cannot tell users or auditors how fresh the ACL is |

### 16.2 Build for Phase 2 complete

| Component | Rationale |
|---|---|
| Confluence permission resolver (space + page restrictions) | Connector #2 |
| SharePoint webhook handler for on-demand permission re-crawl | Reduces tightening staleness window from 60min to <5min |
| Short-TTL tier (60s) for documents with Microsoft Purview High/Confidential labels | Sensitivity-aware caching |
| Admin API endpoint for emergency user cache invalidation | Required for offboarding workflows |
| Mapping table for Atlassian group IDs ↔ Entra group OIDs | Required for Confluence ACL filter to work |
| `acl:version` Redis key for global cache invalidation on full re-crawl | Operational requirement |

### 16.3 Skip (out of scope)

| Component | Reason to skip |
|---|---|
| Slack DM indexing | Too sensitive, per-DM ACL is per-participant list, risk/value ratio wrong |
| PostgreSQL RLS as primary vector store | Qdrant is Phase 2 primary; pgvector is a documented alternative for operators who need it |
| Microsoft Purview sensitivity label propagation | Requires Azure-managed infrastructure, not self-hosted |
| Field-level security (restricting which fields in a doc a user can see) | Elasticsearch-style FLS. Not needed for our use case — we return chunk content, not structured document fields |
| Per-query Graph API calls (no Redis cache) | Rate limits make this architecturally impossible at any scale |
| Prompt-level ACL enforcement ("only answer about content you're allowed to see") | Ineffective against prompt injection — security boundary must be in retrieval layer |

### 16.4 Open question: what happens when `allowed_groups` is empty?

When the connector cannot resolve effective permissions for a document (permission API error, timeout, unknown principal type), it must not store the document with an empty ACL array — that would make it accessible to no one, which may be correct but is opaque.

**Recommendation:** Use a sentinel value:
```typescript
interface CrawlFailureSentinel {
  allowed_groups: [];
  allowed_users: [];
  is_public_within_tenant: false;
  acl_resolution_failed: true;    // ← add this field
  acl_resolution_error: string;   // error message for debugging
}
```

Documents with `acl_resolution_failed: true` appear in no search results (correct security behavior) but can be found by administrators in a separate monitoring query, triggering a re-crawl attempt.

---

## Sources

- [Microsoft Learn — List user's transitive group memberships](https://learn.microsoft.com/en-us/graph/api/user-list-transitivememberof) — exact API, response format, permissions
- [Microsoft Learn — Azure AI Search document-level access overview](https://learn.microsoft.com/en-us/azure/search/search-document-level-access-overview) — four access control patterns, 2026-05-01-preview
- [Microsoft Learn — Azure AI Search query-time ACL and RBAC enforcement](https://learn.microsoft.com/en-us/azure/search/search-query-access-control-rbac-enforcement) — query-time enforcement implementation
- [Microsoft Learn — Microsoft Graph service-specific throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits) — 5 req/10s per-app-per-tenant for identity APIs
- [Elastic — Controlling access at document and field level](https://www.elastic.co/docs/deploy-manage/users-roles/cluster-or-deployment-auth/controlling-access-at-document-field-level) — Elasticsearch DLS implementation
- [Qdrant — Filtering](https://qdrant.tech/documentation/concepts/filtering/) — must/should/must_not, MatchAny filter syntax
- [devblogs.microsoft.com — SharePoint doc level access](https://devblogs.microsoft.com/ise/sharepoint-doc-level-access/) — SharePoint ACL propagation to AI Search
- [Digital Elliptical — Permission-Aware RAG](https://digitalelliptical.com/blog/permission-aware-rag-access-boundaries/) — ingestion + query time pipeline architecture
- [Nikhil Jain — ACL at Query Time series](https://nikhiljain180.github.io/AI-series/articles/05c-supplement-scenarios.html) — failure modes, tradeoffs
- [Virginia Mwega — pgvector RLS multi-tenant isolation](https://virginiamwegahashnodedev.hashnode.dev/pgvector-rls-multi-tenant-isolation) — security-definer trap, over-fetch pattern
- [Atlassian — Confluence permissions and restrictions](https://confluence.atlassian.com/docm/latest/permissions-and-restrictions-986874941.html) — space + page restriction model
- [Atlassian — Confluence Cloud REST API v2 space permissions](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space-permissions/) — API endpoint reference
- [Slack — conversations.members](https://docs.slack.dev/reference/methods/conversations.members/) — Slack channel membership API
- [Microsoft Learn — SharePoint permission inheritance](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/role-inheritance-elevation-of-privilege-and-password-changes-in-sharepoint) — inheritance rules
- [POPIA compliance audit requirements](https://audgov.com/explore/risk-popia-privacy-controls) — AU accountability controls
- [AzureCachePool group membership cache](https://deepwiki.com/jenkinsci/azure-ad-plugin/4.3-azurecachepool:-group-membership-cache) — transitive group membership caching rationale
- [Securing pgvector with RLS](https://www.index-management.org/pgvector-architecture-vector-fundamentals/security-boundaries-for-vector-data/securing-pgvector-tables-with-row-level-security/) — HNSW + RLS interaction, BYPASSRLS gotcha
- [bestaiweb.ai — metadata filtering in Qdrant for multi-tenant RAG](https://www.bestaiweb.ai/how-to-implement-metadata-filtering-in-qdrant-weaviate-milvus-and-pinecone-in-2026/) — Qdrant mandatory must predicate pattern
