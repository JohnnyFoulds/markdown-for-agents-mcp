# GitHub Connector Research

**For:** markdown-for-agents-mcp enterprise knowledge index  
**Date:** 2026-08-26  
**Scope:** Code repositories, wikis, issues, discussions, pull requests — full connector design  
**Sources:** GitHub REST API docs (v2026-03-10), GraphQL API docs, GitHub Code Search docs, GitHub Apps docs

---

## Table of Contents

1. [Authentication Architecture](#1-authentication-architecture)
2. [Code Search API](#2-code-search-api)
3. [Repository Contents and File Tree](#3-repository-contents-and-file-tree)
4. [Wikis](#4-wikis)
5. [Issues and Comments](#5-issues-and-comments)
6. [Pull Requests](#6-pull-requests)
7. [Discussions (GraphQL)](#7-discussions-graphql)
8. [GraphQL API: Patterns and Rate Limits](#8-graphql-api-patterns-and-rate-limits)
9. [Rate Limits: Complete Reference](#9-rate-limits-complete-reference)
10. [Incremental Sync Strategy](#10-incremental-sync-strategy)
11. [GitHub Enterprise Server (GHES) Differences](#11-github-enterprise-server-ghes-differences)
12. [Complete TypeScript Connector Implementation](#12-complete-typescript-connector-implementation)
13. [What to Build vs. What to Skip](#13-what-to-build-vs-what-to-skip)
14. [Limitations, Gotchas, and Edge Cases](#14-limitations-gotchas-and-edge-cases)

---

## 1. Authentication Architecture

### Three auth models compared

| Factor | GitHub App | OAuth App | Fine-grained PAT |
|--------|-----------|-----------|-------------------|
| Identity | The app itself (installation token) or user via user token | User | User |
| Scope granularity | Per-permission, per-repo, per-org | Coarse scopes (repo, read:org) | Per-permission, per-repo subset |
| Enterprise install | Org admin installs app across repos — no individual user needed | Each user must authorize | Each user creates their own PAT |
| Rate limit (REST) | 5,000–15,000 req/hr per installation | Per-user (5,000/hr) | Per-user (5,000/hr) |
| Rate limit (GraphQL) | 5,000–10,000 points/hr | Per-user | Per-user |
| Secret rotation | JWT signed with private key; installation tokens expire in 1 hour | Manual rotation | Manual rotation |
| GHES support | Yes (install app on GHES instance) | Yes | Yes |
| **Recommended for connectors** | **Yes — only correct model at org scale** | No | Dev/testing only |

Source: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps

### GitHub App: Installation Token Flow

The GitHub App model has two token types:
- **JWT** — signed with the app's private key (RS256), valid 10 minutes, used only to call `/app/*` endpoints
- **Installation access token** — obtained by POSTing the JWT to `/app/installations/{installation_id}/access_tokens`, valid 1 hour, used for all other API calls

**Note (April 2026):** GitHub began rolling out a new stateless token format `ghs_APPID_JWT`. Installation tokens are no longer exactly 40 characters. Any code that validates token length will break.

```typescript
// Generate JWT for GitHub App authentication
import { createPrivateKey } from 'crypto';
import { SignJWT } from 'jose';

async function generateJWT(appId: string, privateKeyPem: string): Promise<string> {
  const privateKey = createPrivateKey(privateKeyPem);
  const now = Math.floor(Date.now() / 1000);
  
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60)          // 60s clock skew buffer
    .setExpirationTime(now + 600)   // 10 minutes max
    .setIssuer(appId)
    .sign(privateKey);
}

// Exchange JWT for installation access token
async function getInstallationToken(
  jwt: string,
  installationId: number,
  baseUrl = 'https://api.github.com'
): Promise<{ token: string; expiresAt: string }> {
  const resp = await fetch(
    `${baseUrl}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
    }
  );
  if (!resp.ok) throw new Error(`Failed to get installation token: ${resp.status}`);
  const data = await resp.json() as { token: string; expires_at: string };
  return { token: data.token, expiresAt: data.expires_at };
}
```

Source: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app

### Recommended Permissions for the Connector App

Request only what is needed. The GitHub API now returns `X-Accepted-GitHub-Permissions` in error responses to tell you what was missing.

| Permission | Level | Required for |
|-----------|-------|-------------|
| Contents | Read | File tree, file contents, README, wikis |
| Issues | Read | Issues and issue comments |
| Pull requests | Read | PRs, reviews, review comments |
| Metadata | Read | Repository metadata (always required) |
| Discussions | Read | Discussions (GraphQL) |

Source: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps

### Fine-grained PAT (for dev/testing)

Fine-grained PATs support the same per-repository, per-permission model as GitHub Apps. They cannot be issued programmatically and expire. For production connectors, use GitHub Apps instead.

```typescript
const headers = {
  'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
};
```

---

## 2. Code Search API

GitHub has **two separate code search systems** with different APIs, query syntax, and limitations. This is one of the most important distinctions in the entire GitHub API surface.

### 2.1 Legacy Code Search (REST `/search/code`)

The original search endpoint. Available in all tiers including GHES.

**Endpoint:** `GET /search/code?q={query}&per_page={n}&page={n}`  
**Rate limit:** 10 requests/minute (authenticated), requires authentication  
**Max results:** 1,000 per query (10 pages of 100)  
**Source:** https://docs.github.com/en/rest/search/search

#### Legacy Code Search Qualifiers

| Qualifier | Example | Notes |
|-----------|---------|-------|
| `in:file` | `octocat in:file` | Search file contents (default) |
| `in:path` | `config in:path` | Search file path/name |
| `in:file,path` | `test in:file,path` | Both |
| `user:USERNAME` | `user:octocat extension:rb` | All repos of a user |
| `org:ORGNAME` | `org:github extension:js` | All repos in an org |
| `repo:OWNER/REPO` | `repo:rails/rails` | Specific repo |
| `path:DIRECTORY` | `path:src/models language:python` | Files in directory |
| `language:LANG` | `language:typescript` | By programming language |
| `extension:EXT` | `extension:yaml` | By file extension |
| `filename:NAME` | `filename:Dockerfile` | Exact filename |
| `size:n` | `size:>10000` | File size in bytes |
| `fork:true` | `fork:true repo:rails/rails` | Include forks |

#### Legacy Code Search Limitations

- Max query length: 256 characters (not counting operators/qualifiers)
- Max operators per query: 5 AND, OR, or NOT operators
- Only the **default branch** is indexed
- Only files smaller than **384 KB** are searchable
- Only repositories with **fewer than 500,000 files**
- Archived repositories are not indexed
- Forks only indexed if they have more stars than parent and at least one pushed commit
- Search scope: up to 4,000 repositories
- **Cannot** search without at least one keyword (e.g., `language:javascript` alone is invalid)
- Wildcard characters (`. , : ; /` etc.) are ignored in queries

```typescript
interface CodeSearchResult {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{
    name: string;
    path: string;
    sha: string;
    url: string;
    git_url: string;
    html_url: string;
    repository: {
      id: number;
      name: string;
      full_name: string;
      private: boolean;
      owner: { login: string; id: number };
      html_url: string;
      description: string | null;
      fork: boolean;
    };
    score: number;
    text_matches?: Array<{
      object_url: string;
      object_type: string;
      property: string;
      fragment: string;
      matches: Array<{ text: string; indices: [number, number] }>;
    }>;
  }>;
}

async function searchCode(
  query: string,
  token: string,
  page = 1,
  perPage = 100
): Promise<CodeSearchResult> {
  const params = new URLSearchParams({
    q: query,
    per_page: String(perPage),
    page: String(page),
  });
  
  const resp = await fetch(
    `https://api.github.com/search/code?${params}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.text-match+json', // Include text match fragments
        'X-GitHub-Api-Version': '2026-03-10',
      },
    }
  );
  
  if (resp.status === 403) {
    const retryAfter = resp.headers.get('Retry-After');
    throw new Error(`Rate limited. Retry after ${retryAfter}s`);
  }
  
  if (!resp.ok) throw new Error(`Search failed: ${resp.status}`);
  return resp.json() as Promise<CodeSearchResult>;
}
```

### 2.2 New GitHub Code Search (Web Interface + experimental API)

The new code search launched in 2023 and is now GA. It is **faster, supports regex, boolean operators, and symbol search**, but has different limitations.

**Important:** As of 2026, the new code search is primarily a web/Copilot feature. The REST API (`/search/code`) still uses legacy code search. The new code search is accessible via the GitHub web UI and has an **experimental API endpoint** that may change.

Source: https://docs.github.com/en/search-github/github-code-search/about-github-code-search

#### New Code Search Qualifiers

| Qualifier | Example | Notes |
|-----------|---------|-------|
| `repo:` | `repo:owner/name` | Exact match required |
| `org:` | `org:github` | Organization |
| `user:` | `user:octocat` | User's repos |
| `enterprise:` | `enterprise:octocorp` | Enterprise-owned org repos only |
| `language:` | `language:go` | Programming language |
| `path:` | `path:src/*.js` | Glob expressions supported |
| `symbol:` | `symbol:WithContext` | Function/class definitions only |
| `content:` | `content:README.md` | File content only (not path) |
| `is:archived` | `is:archived` | Archived repos |
| `is:fork` | `is:fork` | Forked repos |
| `license:` | `license:MIT` | By license |

#### New Code Search Limitations

- Max results: **100 results** (5 pages) — much lower than legacy
- Sorting not supported
- Max query length: **1,000 characters**
- Empty files and files over **350 KB** excluded
- Lines over **1,024 characters** are truncated
- Binary files excluded
- Only UTF-8 encoded files
- Only default branch
- `symbol:` only finds definitions, not references
- Exhaustive search not guaranteed

#### Implementation Recommendation

For the connector, use **legacy code search** (`/search/code`) for broader coverage (up to 1,000 results) and GHES compatibility. If you want regex/symbol support for GitHub.com customers, offer new code search as an opt-in mode but document the 100-result cap.

---

## 3. Repository Contents and File Tree

### 3.1 Get Repository Content (Single File or Directory)

**Endpoint:** `GET /repos/{owner}/{repo}/contents/{path}`  
**Required permission:** Contents (read)  
**Source:** https://docs.github.com/en/rest/repos/contents

#### Media Types

| Accept header | Returns |
|--------------|---------|
| `application/vnd.github+json` (default) | Base64-encoded content |
| `application/vnd.github.raw+json` | Raw file bytes |
| `application/vnd.github.html+json` | Rendered HTML (markdown, etc.) |
| `application/vnd.github.object+json` | Consistent object format for any content type |

#### File Size Limits

| File size | Behavior |
|-----------|----------|
| <= 1 MB | All features work normally |
| 1–100 MB | Only `raw` or `object` media types work; `content` field is empty string with `encoding: "none"` |
| > 100 MB | **Not supported** — returns error |

#### Directory Limit

A single `GET /contents/{path}` call for a directory returns at most **1,000 files**. For directories with more files, you must use the Git Trees API.

```typescript
interface ContentFile {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  encoding?: 'base64' | 'none';
  size: number;
  name: string;
  path: string;
  content?: string;          // base64 encoded, present for files <= 1MB
  sha: string;
  url: string;
  git_url: string | null;
  html_url: string | null;
  download_url: string | null;
  _links: { self: string; git: string | null; html: string | null };
  // For symlinks:
  target?: string;
  // For submodules:
  submodule_git_url?: string;
}

async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token: string
): Promise<string> {
  const params = new URLSearchParams({ ref });
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?${params}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
    }
  );
  if (!resp.ok) throw new Error(`Failed to get file: ${resp.status}`);
  return resp.text();
}
```

### 3.2 Git Trees API (Full Recursive File Listing)

The correct way to enumerate all files in a repository, bypassing the 1,000-file directory limit.

**Endpoint:** `GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1`  
**Required permission:** Contents (read)  
**Source:** https://docs.github.com/en/rest/git/trees

#### Response Schema

```typescript
interface GitTree {
  sha: string;
  url: string;
  truncated: boolean;  // TRUE if tree was truncated (repo too large)
  tree: Array<{
    path: string;      // Full path from repo root
    mode: '100644'     // Regular file
        | '100755'     // Executable
        | '040000'     // Directory (tree)
        | '160000'     // Submodule (commit)
        | '120000';    // Symlink
    type: 'blob' | 'tree' | 'commit';
    sha: string;
    size?: number;     // Only present for blobs
    url: string;
  }>;
}
```

**Critical gotcha:** If `truncated: true`, the tree was cut short because the repository is too large (GitHub's limit is not officially documented but is around 100,000 tree entries). You must fall back to recursive directory traversal via `/contents/`.

```typescript
async function getFullFileTree(
  owner: string,
  repo: string,
  ref: string,
  token: string
): Promise<GitTree> {
  // First get the commit SHA for the ref
  const refResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${ref}`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } }
  );
  const refData = await refResp.json() as { object: { sha: string } };
  
  // Get the commit to find tree SHA
  const commitResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/commits/${refData.object.sha}`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } }
  );
  const commit = await commitResp.json() as { tree: { sha: string } };
  
  // Get full recursive tree
  const treeResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } }
  );
  const tree = await treeResp.json() as GitTree;
  
  if (tree.truncated) {
    console.warn(`Tree truncated for ${owner}/${repo}. Falling back to directory traversal.`);
    // TODO: implement recursive /contents/ traversal
  }
  
  return tree;
}

// Filter to only indexable text files
function filterIndexableFiles(tree: GitTree, extensions: string[]): typeof tree.tree {
  return tree.tree.filter(entry => {
    if (entry.type !== 'blob') return false;
    if (!entry.size || entry.size > 1_048_576) return false; // Skip files > 1MB
    const ext = entry.path.split('.').pop()?.toLowerCase();
    return ext ? extensions.includes(ext) : false;
  });
}
```

### 3.3 Blob Download

For files identified by the tree traversal, download individual blobs:

**Endpoint:** `GET /repos/{owner}/{repo}/git/blobs/{file_sha}`  
Content is returned base64-encoded unless you use `Accept: application/vnd.github.raw+json`.

**Important:** Download URLs from `/contents/` expire and are single-use. For batch downloads, always call `/git/blobs/{sha}` directly with a fresh token.

---

## 4. Wikis

Wikis are the least well-supported area of the GitHub API. This is an important gotcha to document upfront.

### 4.1 The Core Problem: No Official Wiki API

There is **no REST API for reading wiki page content**. The GitHub REST API has no `/repos/{owner}/{repo}/wiki/pages` endpoint. There is no GraphQL representation of wiki pages either.

Source: https://stackoverflow.com/questions/27654854/is-it-possible-to-get-github-wiki-content-by-github-api (still current as of 2026)

### 4.2 How Wikis Actually Work

GitHub wikis are stored as a separate Git repository cloned at `{repo_url}.wiki.git`. The naming convention is:
- Repository: `https://github.com/owner/repo`
- Wiki Git repo: `https://github.com/owner/repo.wiki.git`
- Wiki clone URL: `git clone https://github.com/owner/repo.wiki.git`

Pages are stored as Markdown files (`.md`) or other formats at the root of this git repository. The page title maps to the filename, with spaces replaced by hyphens.

### 4.3 Accessing Wiki Content via Git Clone

The reliable approach for an enterprise knowledge index:

```bash
# Clone wiki (works with installation token)
git clone https://x-access-token:${INSTALLATION_TOKEN}@github.com/owner/repo.wiki.git /tmp/wiki
```

```typescript
import { simpleGit } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';

interface WikiPage {
  title: string;
  path: string;
  content: string;
  sha: string;
}

async function fetchWikiPages(
  owner: string,
  repo: string,
  token: string,
  tmpDir: string
): Promise<WikiPage[]> {
  const wikiUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.wiki.git`;
  const wikiDir = path.join(tmpDir, `${owner}-${repo}-wiki`);
  
  try {
    const git = simpleGit();
    await git.clone(wikiUrl, wikiDir, ['--depth', '1']);
    
    const files = fs.readdirSync(wikiDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'));
    
    const pages: WikiPage[] = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(wikiDir, file), 'utf-8');
      // Get git log for SHA
      const log = await simpleGit(wikiDir).log({ file, maxCount: 1 });
      pages.push({
        title: file.replace(/-/g, ' ').replace(/\.md$/, ''),
        path: file,
        content,
        sha: log.latest?.hash ?? '',
      });
    }
    return pages;
  } finally {
    fs.rmSync(wikiDir, { recursive: true, force: true });
  }
}
```

### 4.4 Alternative: Using the Contents API on the Wiki Branch

Some GitHub repositories expose wiki content via the contents API if the wiki is enabled and has commits. Check if `/repos/{owner}/{repo}` has `has_wiki: true`, then attempt:

```
GET https://api.github.com/repos/{owner}/{repo}/contents/?ref=wiki
```

This is not documented and may not work reliably. The Git clone approach is the only reliable method.

### 4.5 Limitations

- Wikis can be disabled by repository owners (`has_wiki: false`)
- Private wikis require the same authentication as the parent repo
- GHES wikis follow the same `.wiki.git` pattern
- Wiki git repos may be empty even if `has_wiki: true`
- No incremental sync via API — must re-clone or use git fetch for updates

---

## 5. Issues and Comments

### 5.1 List Repository Issues

**Endpoint:** `GET /repos/{owner}/{repo}/issues`  
**Required permission:** Issues (read)  
**Note:** GitHub's API considers every pull request an issue. Issues with a `pull_request` key in the response are PRs.

Source: https://docs.github.com/en/rest/issues/issues

#### Query Parameters

| Parameter | Values | Default | Description |
|-----------|--------|---------|-------------|
| `state` | `open`, `closed`, `all` | `open` | Filter by state |
| `labels` | `bug,enhancement` | — | Comma-separated label names |
| `sort` | `created`, `updated`, `comments` | `created` | Sort order |
| `direction` | `asc`, `desc` | `desc` | Sort direction |
| `since` | ISO 8601 timestamp | — | Only issues updated after this time |
| `assignee` | username or `*` | — | Filter by assignee |
| `milestone` | milestone number or `*` | — | Filter by milestone |
| `per_page` | 1–100 | 30 | Results per page |
| `page` | integer | 1 | Page number |

**Key insight for incremental sync:** Use `since` with the last sync timestamp and `sort=updated&direction=asc` to get only changed issues.

#### Issue Response Schema

```typescript
interface Issue {
  id: number;
  node_id: string;
  url: string;
  repository_url: string;
  html_url: string;
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string | null;
  body_html?: string;   // requires Accept: application/vnd.github.html+json
  body_text?: string;   // requires Accept: application/vnd.github.text+json
  user: User;
  labels: Label[];
  assignees: User[];
  milestone: Milestone | null;
  locked: boolean;
  active_lock_reason: string | null;
  comments: number;
  pull_request?: {      // Present if this issue is also a PR
    url: string;
    html_url: string;
    diff_url: string;
    patch_url: string;
  };
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  author_association: 'OWNER' | 'MEMBER' | 'COLLABORATOR' | 'CONTRIBUTOR' | 'FIRST_TIMER' | 'FIRST_TIME_CONTRIBUTOR' | 'MANNEQUIN' | 'NONE';
  reactions?: {
    url: string;
    total_count: number;
    '+1': number; '-1': number; laugh: number; hooray: number;
    confused: number; heart: number; rocket: number; eyes: number;
  };
  state_reason?: 'completed' | 'not_planned' | 'reopened' | null;
}
```

#### Media Types for Issue Body

| Accept header | Body field | Notes |
|--------------|------------|-------|
| `application/vnd.github.raw+json` | `body` | Raw markdown (default) |
| `application/vnd.github.text+json` | `body_text` | Plain text |
| `application/vnd.github.html+json` | `body_html` | Rendered HTML |
| `application/vnd.github.full+json` | `body`, `body_text`, `body_html` | All three |

**Recommendation:** Request `application/vnd.github.full+json` once; cache `body` (markdown) for indexing.

### 5.2 Issue Comments

**Endpoint:** `GET /repos/{owner}/{repo}/issues/{issue_number}/comments`  
**Alternative (all issues at once):** `GET /repos/{owner}/{repo}/issues/comments?since={timestamp}`

```typescript
interface IssueComment {
  id: number;
  node_id: string;
  url: string;
  html_url: string;
  body: string;
  body_html?: string;
  user: User;
  created_at: string;
  updated_at: string;
  author_association: string;
  reactions?: Reactions;
}

// Efficient: get all comments updated since a timestamp (for incremental sync)
async function getUpdatedComments(
  owner: string,
  repo: string,
  since: string,
  token: string
): Promise<IssueComment[]> {
  const comments: IssueComment[] = [];
  let page = 1;
  
  while (true) {
    const params = new URLSearchParams({
      since,
      sort: 'updated',
      direction: 'asc',
      per_page: '100',
      page: String(page),
    });
    
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/comments?${params}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.full+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
      }
    );
    
    const data = await resp.json() as IssueComment[];
    if (data.length === 0) break;
    comments.push(...data);
    
    // Check for more pages via Link header
    const link = resp.headers.get('Link');
    if (!link?.includes('rel="next"')) break;
    page++;
  }
  
  return comments;
}
```

### 5.3 Issue Timeline (For Comprehensive Indexing)

For high-fidelity indexing that captures state changes, label changes, cross-references:

**Endpoint:** `GET /repos/{owner}/{repo}/issues/{issue_number}/timeline`  
**Accept:** `application/vnd.github+json`

Returns ordered events: `commented`, `committed`, `cross-referenced`, `labeled`, `unlabeled`, `milestoned`, `assigned`, `closed`, `reopened`, `renamed`, etc.

---

## 6. Pull Requests

### 6.1 List and Get PRs

**Endpoint:** `GET /repos/{owner}/{repo}/pulls`  
**Required permission:** Pull requests (read)  
Source: https://docs.github.com/en/rest/pulls/pulls

#### Parameters

| Parameter | Values | Default |
|-----------|--------|---------|
| `state` | `open`, `closed`, `all` | `open` |
| `head` | `user:branch` | — |
| `base` | branch name | — |
| `sort` | `created`, `updated`, `popularity`, `long-running` | `created` |
| `direction` | `asc`, `desc` | `desc` |
| `per_page` | 1–100 | 30 |

**Important:** PRs also appear in the issues API. To filter issues to only PRs when using `/issues`, check for presence of the `pull_request` key.

#### PR Response Fields (Additional vs Issues)

```typescript
interface PullRequest {
  // All issue fields, plus:
  head: {
    label: string;   // "owner:branch"
    ref: string;     // branch name
    sha: string;
    repo: Repository | null;
    user: User;
  };
  base: {
    label: string;
    ref: string;
    sha: string;
    repo: Repository;
    user: User;
  };
  diff_url: string;
  patch_url: string;
  mergeable: boolean | null;   // null while computed
  mergeable_state: 'clean' | 'dirty' | 'blocked' | 'behind' | 'unstable' | 'draft' | 'unknown';
  merged: boolean;
  merged_at: string | null;
  merged_by: User | null;
  draft: boolean;
  changed_files: number;
  additions: number;
  deletions: number;
  commits: number;
  review_comments: number;
}
```

### 6.2 PR Files Changed

**Endpoint:** `GET /repos/{owner}/{repo}/pulls/{pull_number}/files`  
Returns up to 3,000 files changed. Each file has `filename`, `status` (added/removed/modified/renamed), `additions`, `deletions`, `patch` (unified diff, max 4,096 chars).

### 6.3 PR Reviews and Comments

Two types of PR comments:
1. **Review comments** (`/pulls/{number}/comments`) — inline comments on specific lines
2. **Issue comments** (`/issues/{number}/comments`) — top-level comments (same endpoint as issue comments)
3. **Reviews** (`/pulls/{number}/reviews`) — formal review submissions with `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` states

For indexing PR discussions, collect both review comments and issue comments.

---

## 7. Discussions (GraphQL)

Discussions are **GraphQL-only**. There is no REST API for GitHub Discussions as of 2026.

Source: https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions

### 7.1 GraphQL Endpoint

```
POST https://api.github.com/graphql
Authorization: Bearer {token}
Content-Type: application/json
```

### 7.2 Core Discussion Schema

```graphql
type Discussion implements Comment & Node & Reactable & RepositoryNode & Subscribable & Updatable {
  id: ID!
  number: Int!
  title: String!
  body: String!           # Raw markdown
  bodyHTML: HTML!         # Rendered HTML
  bodyText: String!       # Plain text
  author: Actor
  authorAssociation: CommentAuthorAssociation!
  category: DiscussionCategory!
  isAnswered: Boolean!
  answer: DiscussionComment     # The accepted answer, if any
  answerChosenAt: DateTime
  answerChosenBy: Actor
  comments(first: Int, after: String, last: Int, before: String): DiscussionCommentConnection!
  createdAt: DateTime!
  updatedAt: DateTime!
  url: URI!
  locked: Boolean!
  repository: Repository!
}

type DiscussionComment implements Comment & Node & Reactable {
  id: ID!
  body: String!
  bodyHTML: HTML!
  bodyText: String!
  author: Actor
  createdAt: DateTime!
  updatedAt: DateTime!
  isAnswer: Boolean!
  replies(first: Int, after: String): DiscussionCommentConnection!
  deletedAt: DateTime   # null unless deleted
  isMinimized: Boolean!
  minimizedReason: String
}
```

### 7.3 Query: List Discussions with Comments

```graphql
query ListDiscussions(
  $owner: String!
  $repo: String!
  $first: Int!
  $after: String
  $categoryId: ID
) {
  repository(owner: $owner, name: $repo) {
    discussions(
      first: $first
      after: $after
      categoryId: $categoryId
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        number
        title
        body
        bodyText
        category {
          id
          name
          description
          isAnswerable
        }
        author {
          login
          ... on User { name email }
        }
        isAnswered
        answer {
          id
          body
          author { login }
          createdAt
        }
        createdAt
        updatedAt
        url
        comments(first: 20) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            body
            bodyText
            author { login }
            isAnswer
            createdAt
            updatedAt
            replies(first: 5) {
              totalCount
              nodes {
                id
                body
                author { login }
                createdAt
              }
            }
          }
        }
      }
    }
  }
}
```

### 7.4 Discussion Categories

```graphql
query GetDiscussionCategories($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    discussionCategories(first: 25) {
      nodes {
        id
        name
        description
        emoji
        emojiHTML
        isAnswerable
        createdAt
        updatedAt
      }
    }
  }
}
```

Up to 25 categories per repository.

### 7.5 TypeScript GraphQL Client for Discussions

```typescript
interface GraphQLResponse<T> {
  data: T;
  errors?: Array<{ message: string; locations?: unknown[] }>;
}

async function graphqlQuery<T>(
  query: string,
  variables: Record<string, unknown>,
  token: string,
  baseUrl = 'https://api.github.com/graphql'
): Promise<T> {
  const resp = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  
  if (!resp.ok) throw new Error(`GraphQL request failed: ${resp.status}`);
  
  const result = await resp.json() as GraphQLResponse<T>;
  if (result.errors?.length) {
    throw new Error(`GraphQL errors: ${result.errors.map(e => e.message).join(', ')}`);
  }
  return result.data;
}

// Paginate all discussions
async function* fetchAllDiscussions(
  owner: string,
  repo: string,
  token: string
) {
  let cursor: string | null = null;
  
  do {
    const data = await graphqlQuery<{
      repository: {
        discussions: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          nodes: unknown[];
        };
      };
    }>(LIST_DISCUSSIONS_QUERY, {
      owner, repo,
      first: 25,
      after: cursor,
    }, token);
    
    const { nodes, pageInfo } = data.repository.discussions;
    yield* nodes;
    
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);
}
```

---

## 8. GraphQL API: Patterns and Rate Limits

### 8.1 Endpoint and Versioning

```
POST https://api.github.com/graphql
```

No versioning in URL — the GraphQL schema evolves with deprecation notices. Check: https://docs.github.com/en/graphql/overview/changelog

For GHES:
```
POST https://{hostname}/api/graphql
```

### 8.2 Point Cost Calculation

GraphQL rate limits use **points**, not request counts. Each query costs at minimum 1 point.

**Formula:** Sum all connection `first`/`last` argument values across all nested connections, then divide by 100 and round up.

```
# Example: 100 repos × 50 issues × 60 labels = 5,101 requests → 52 points
query {
  viewer {
    repositories(first: 100) {
      nodes {
        issues(first: 50) {
          nodes {
            labels(first: 60) { nodes { name } }
          }
        }
      }
    }
  }
}
```

Check remaining cost in response:

```graphql
query {
  rateLimit {
    limit       # total points per hour
    remaining   # points left this window
    used        # points used this window
    resetAt     # ISO timestamp of next reset
    cost        # cost of this query
  }
}
```

### 8.3 Rate Limit Headers (GraphQL)

| Header | Meaning |
|--------|---------|
| `x-ratelimit-limit` | Max points per hour |
| `x-ratelimit-remaining` | Points remaining |
| `x-ratelimit-used` | Points used this window |
| `x-ratelimit-reset` | Epoch seconds of reset |
| `x-ratelimit-resource` | Always `graphql` for GraphQL requests |

### 8.4 Secondary Rate Limits (GraphQL)

- Max **2,000 points per minute** per endpoint
- Max **100 concurrent requests** (shared with REST)
- Max **60 seconds CPU time per minute** of real time for GraphQL

If you hit secondary rate limits, GitHub returns HTTP 403 with `Retry-After` header.

### 8.5 Efficient Bulk Patterns

Use node IDs (`node_id` in REST responses = `id` in GraphQL) to batch-fetch objects:

```graphql
query FetchNodes($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Issue {
      id
      number
      title
      body
      updatedAt
    }
    ... on PullRequest {
      id
      number
      title
      body
      updatedAt
    }
    ... on Discussion {
      id
      number
      title
      body
      updatedAt
    }
  }
}
```

This is powerful for incremental sync: fetch the IDs that changed via webhooks or the events API, then batch-resolve them in GraphQL.

---

## 9. Rate Limits: Complete Reference

Source: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api  
Source: https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api

### 9.1 REST API Primary Rate Limits

| Auth method | Rate limit |
|-------------|-----------|
| Unauthenticated | 60 requests/hour per IP |
| PAT / OAuth token / User access token | 5,000 requests/hour per user |
| GitHub App installation token (non-GHEC org) | 5,000 requests/hour; +50 req/hr per repository > 20; +50 req/hr per user > 20; max 12,500 |
| GitHub App installation token (GHEC org) | 15,000 requests/hour per installation |
| OAuth App (client_id + secret, public data) | 5,000 requests/hour per app |
| OAuth App (GHEC org) | 15,000 requests/hour per app |
| GITHUB_TOKEN in Actions | 1,000 requests/hour per repository |

### 9.2 Search API Rate Limits (Special)

| Endpoint | Authenticated limit | Unauthenticated limit |
|----------|--------------------|-----------------------|
| All search endpoints except code | 30 requests/minute | 10 requests/minute |
| `/search/code` | **10 requests/minute** | Not available (requires auth) |

The code search endpoint is 3x more restrictive than other search endpoints. Plan accordingly for crawls.

### 9.3 GraphQL Primary Rate Limits

| Auth method | Rate limit |
|-------------|-----------|
| User / PAT | 5,000 points/hour |
| User via GHEC org app | 10,000 points/hour |
| GitHub App installation (non-GHEC org) | 5,000 points/hour; scaling formula same as REST; max 12,500 |
| GitHub App installation (GHEC org) | 10,000 points/hour |
| GITHUB_TOKEN in Actions | 1,000 points/hour per repository |

### 9.4 Rate Limit Strategy for the Connector

```typescript
interface RateLimitTracker {
  remaining: number;
  resetAt: Date;
  limit: number;
}

class GitHubRateLimitManager {
  private restCore: RateLimitTracker = { remaining: 5000, resetAt: new Date(), limit: 5000 };
  private restSearch: RateLimitTracker = { remaining: 30, resetAt: new Date(), limit: 30 };
  private graphql: RateLimitTracker = { remaining: 5000, resetAt: new Date(), limit: 5000 };
  
  updateFromHeaders(headers: Headers, type: 'core' | 'search' | 'graphql'): void {
    const tracker = type === 'core' ? this.restCore : type === 'search' ? this.restSearch : this.graphql;
    tracker.remaining = parseInt(headers.get('x-ratelimit-remaining') ?? '0');
    tracker.limit = parseInt(headers.get('x-ratelimit-limit') ?? '0');
    tracker.resetAt = new Date(parseInt(headers.get('x-ratelimit-reset') ?? '0') * 1000);
  }
  
  async waitIfNeeded(type: 'core' | 'search' | 'graphql', minRemaining = 100): Promise<void> {
    const tracker = type === 'core' ? this.restCore : type === 'search' ? this.restSearch : this.graphql;
    if (tracker.remaining < minRemaining) {
      const waitMs = tracker.resetAt.getTime() - Date.now() + 1000; // +1s buffer
      if (waitMs > 0) {
        console.log(`Rate limit low (${tracker.remaining} remaining). Waiting ${Math.ceil(waitMs/1000)}s...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
  }
  
  // Check if we should use REST search or wait
  get canUseCodeSearch(): boolean {
    return this.restSearch.remaining > 2;
  }
}
```

---

## 10. Incremental Sync Strategy

### 10.1 Issues and PRs: `since` Parameter

Both issues and issue comments support `since` (ISO 8601 timestamp). Use `sort=updated&direction=asc` for reliable ordered results:

```typescript
async function syncIssuesSince(
  owner: string, 
  repo: string, 
  since: string, 
  token: string
) {
  const params = new URLSearchParams({
    state: 'all',
    sort: 'updated',
    direction: 'asc',
    since,           // ISO 8601: "2026-07-01T00:00:00Z"
    per_page: '100',
  });
  
  // Paginate through all updated issues
  // ...
}
```

### 10.2 Repository Contents: SHA-Based Comparison

Use the tree SHA to detect changes without fetching content:

```typescript
async function hasRepoChanged(
  owner: string,
  repo: string,
  ref: string,
  cachedTreeSha: string,
  token: string
): Promise<boolean> {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${ref}`,
    { headers: { /* ... */ } }
  );
  const refData = await resp.json() as { object: { sha: string } };
  
  const commitResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/commits/${refData.object.sha}`,
    { headers: { /* ... */ } }
  );
  const commit = await commitResp.json() as { tree: { sha: string } };
  
  return commit.tree.sha !== cachedTreeSha;
}
```

### 10.3 Events API (Polling)

For near-real-time sync without webhooks:

**Endpoint:** `GET /repos/{owner}/{repo}/events`  
Supports ETag-based conditional GET (returns 304 if nothing changed, does not consume rate limit).

```typescript
async function pollRepoEvents(
  owner: string,
  repo: string,
  token: string,
  etag?: string
): Promise<{ events: unknown[]; newEtag: string } | null> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
  };
  if (etag) headers['If-None-Match'] = etag;
  
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/events`,
    { headers }
  );
  
  if (resp.status === 304) return null; // No changes, rate limit not consumed
  
  const pollInterval = parseInt(resp.headers.get('X-Poll-Interval') ?? '60');
  // Respect the poll interval — GitHub increases it under load
  
  const newEtag = resp.headers.get('ETag') ?? '';
  const events = await resp.json() as unknown[];
  return { events, newEtag };
}
```

Event types relevant to indexing:
- `PushEvent` — commits to branches
- `IssuesEvent` — issue opened/closed/labeled
- `IssueCommentEvent` — issue comment created/edited
- `PullRequestEvent` — PR opened/closed/merged
- `PullRequestReviewEvent` — review submitted
- `PullRequestReviewCommentEvent` — inline review comment
- `CreateEvent` — branch/tag created
- `DeleteEvent` — branch/tag deleted

### 10.4 Webhooks (Push-Based, Preferred for Enterprise)

For enterprise deployments, webhooks are superior to polling:

```typescript
// Webhook events to subscribe to
const WEBHOOK_EVENTS = [
  'push',
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'discussion',
  'discussion_comment',
  'repository',  // repo created/deleted/renamed
  'meta',        // webhook itself deleted
];
```

Webhook payload includes `installation.id` for GitHub App installs.

---

## 11. GitHub Enterprise Server (GHES) Differences

GHES is the self-hosted version of GitHub. As of 2026, the latest stable version is GHES 3.21 (based on the docs URL observed).

### 11.1 API Base URL

All API paths are identical; only the base URL changes:

| GitHub.com | GHES |
|-----------|------|
| `https://api.github.com/` | `https://{hostname}/api/v3/` |
| `https://api.github.com/graphql` | `https://{hostname}/api/graphql` |

### 11.2 Feature Availability Gaps

| Feature | GitHub.com | GHES |
|---------|-----------|------|
| New Code Search | GA | Not available on older GHES versions |
| Discussions | Yes | Added in GHES 3.x (check version) |
| Fine-grained PATs | GA | Added in GHES 3.10+ |
| Enterprise-level GitHub App installs | GHEC only | Different on GHES |
| Copilot features | GHEC | Separate GHES Copilot subscription |
| GitHub Actions rate limits | GITHUB_TOKEN 1000/hr | Same |

### 11.3 Rate Limits on GHES

GHES rate limits are configurable by the site admin. Default limits mirror GitHub.com but can be raised or lowered. Always read rate limit headers rather than assuming a specific number.

### 11.4 Authentication for GHES

GitHub Apps work on GHES, but the app must be registered on the GHES instance (not GitHub.com). Configuration requires:

```typescript
interface GitHubConnectorConfig {
  baseUrl: string;        // "https://api.github.com" or "https://ghes.company.com/api/v3"
  graphqlUrl: string;     // "https://api.github.com/graphql" or "https://ghes.company.com/api/graphql"
  appId: string;
  privateKeyPem: string;
  installationId: number;
  isGHES: boolean;
}
```

### 11.5 Enterprise Managed Users (EMU)

GHEC with EMU means all users are provisioned via IdP (Entra ID, Okta). For connectors:
- User `login` values are prefixed with the enterprise slug (e.g., `jfoulds_octocorp`)
- No public profiles — EMU users cannot be found on GitHub.com's public search
- Relevant for mapping GitHub identities to internal directory identities

---

## 12. Complete TypeScript Connector Implementation

### 12.1 Core Types

```typescript
export interface GitHubConnectorConfig {
  baseUrl: string;
  graphqlUrl: string;
  appId: string;
  privateKeyPem: string;
  installationId: number;
  org?: string;
  repos?: string[];           // If empty, index all accessible repos
  defaultBranch?: string;     // Override default branch detection
  indexWikis?: boolean;
  indexDiscussions?: boolean;
  indexIssues?: boolean;
  indexPRs?: boolean;
  fileExtensions?: string[];  // e.g., ['md', 'ts', 'py', 'go']
  maxFileSizeBytes?: number;  // Default: 1MB
}

export interface IndexedDocument {
  id: string;
  type: 'file' | 'issue' | 'pull_request' | 'discussion' | 'wiki_page';
  url: string;
  title: string;
  content: string;           // Markdown or plain text
  metadata: {
    repo: string;
    owner: string;
    language?: string;
    path?: string;
    number?: number;
    state?: string;
    labels?: string[];
    author?: string;
    createdAt: string;
    updatedAt: string;
    sha?: string;
  };
}
```

### 12.2 Token Manager with Auto-Refresh

```typescript
import { createPrivateKey } from 'crypto';
import { SignJWT } from 'jose';

export class GitHubTokenManager {
  private token?: string;
  private expiresAt?: Date;
  
  constructor(
    private appId: string,
    private privateKeyPem: string,
    private installationId: number,
    private baseUrl: string
  ) {}
  
  async getToken(): Promise<string> {
    if (this.token && this.expiresAt && new Date() < new Date(this.expiresAt.getTime() - 60_000)) {
      return this.token;
    }
    
    const jwt = await this.generateJWT();
    const result = await this.exchangeForInstallationToken(jwt);
    this.token = result.token;
    this.expiresAt = new Date(result.expiresAt);
    return this.token;
  }
  
  private async generateJWT(): Promise<string> {
    const privateKey = createPrivateKey(this.privateKeyPem);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 600)
      .setIssuer(this.appId)
      .sign(privateKey);
  }
  
  private async exchangeForInstallationToken(
    jwt: string
  ): Promise<{ token: string; expiresAt: string }> {
    const resp = await fetch(
      `${this.baseUrl}/app/installations/${this.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
      }
    );
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Failed to get installation token: ${resp.status} ${body}`);
    }
    const data = await resp.json() as { token: string; expires_at: string };
    return { token: data.token, expiresAt: data.expires_at };
  }
}
```

### 12.3 Repository Discovery

```typescript
export async function listInstallationRepositories(
  tokenManager: GitHubTokenManager,
  baseUrl: string
): Promise<Array<{ owner: string; name: string; defaultBranch: string; hasWiki: boolean; hasDiscussions: boolean; private: boolean }>> {
  const repos = [];
  let page = 1;
  
  while (true) {
    const token = await tokenManager.getToken();
    const resp = await fetch(
      `${baseUrl}/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
      }
    );
    
    const data = await resp.json() as {
      total_count: number;
      repositories: Array<{
        name: string;
        owner: { login: string };
        default_branch: string;
        has_wiki: boolean;
        has_discussions: boolean;
        private: boolean;
        archived: boolean;
      }>;
    };
    
    for (const repo of data.repositories) {
      if (repo.archived) continue; // Skip archived repos
      repos.push({
        owner: repo.owner.login,
        name: repo.name,
        defaultBranch: repo.default_branch,
        hasWiki: repo.has_wiki,
        hasDiscussions: repo.has_discussions,
        private: repo.private,
      });
    }
    
    if (repos.length >= data.total_count) break;
    page++;
  }
  
  return repos;
}
```

### 12.4 File Indexer

```typescript
const DEFAULT_TEXT_EXTENSIONS = [
  'md', 'mdx', 'txt', 'rst',           // Docs
  'ts', 'tsx', 'js', 'jsx', 'mjs',     // JavaScript/TypeScript  
  'py', 'pyi',                          // Python
  'go',                                  // Go
  'rs',                                  // Rust
  'java', 'kt', 'scala',               // JVM
  'rb',                                  // Ruby
  'php',                                 // PHP
  'cs',                                  // C#
  'cpp', 'c', 'h', 'hpp',              // C/C++
  'sh', 'bash',                         // Shell
  'yaml', 'yml', 'toml', 'json',       // Config
  'sql',                                 // SQL
  'graphql', 'gql',                     // GraphQL schemas
];

export async function* indexRepositoryFiles(
  owner: string,
  repo: string,
  branch: string,
  tokenManager: GitHubTokenManager,
  baseUrl: string,
  extensions = DEFAULT_TEXT_EXTENSIONS,
  maxBytes = 1_048_576
): AsyncGenerator<IndexedDocument> {
  const token = await tokenManager.getToken();
  
  // 1. Get the tree
  const refResp = await fetch(
    `${baseUrl}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } }
  );
  const refData = await refResp.json() as { object: { sha: string } };
  
  const commitResp = await fetch(
    `${baseUrl}/repos/${owner}/${repo}/git/commits/${refData.object.sha}`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } }
  );
  const commit = await commitResp.json() as { tree: { sha: string }; author: { date: string } };
  
  const treeResp = await fetch(
    `${baseUrl}/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } }
  );
  const tree = await treeResp.json() as {
    tree: Array<{ path: string; type: string; sha: string; size?: number; url: string }>;
    truncated: boolean;
  };
  
  // 2. Filter to indexable files
  const files = tree.tree.filter(entry => {
    if (entry.type !== 'blob') return false;
    if (!entry.size || entry.size > maxBytes) return false;
    const ext = entry.path.split('.').pop()?.toLowerCase();
    return ext ? extensions.includes(ext) : false;
  });
  
  // 3. Download and yield each file (with rate limit awareness)
  for (const file of files) {
    const freshToken = await tokenManager.getToken();
    
    try {
      const contentResp = await fetch(
        `${baseUrl}/repos/${owner}/${repo}/contents/${file.path}?ref=${branch}`,
        {
          headers: {
            'Authorization': `Bearer ${freshToken}`,
            'Accept': 'application/vnd.github.raw+json',
            'X-GitHub-Api-Version': '2026-03-10',
          },
        }
      );
      
      if (!contentResp.ok) {
        console.warn(`Failed to fetch ${file.path}: ${contentResp.status}`);
        continue;
      }
      
      const content = await contentResp.text();
      const filename = file.path.split('/').pop() ?? file.path;
      
      yield {
        id: `${owner}/${repo}/blob/${file.sha}`,
        type: 'file',
        url: `https://github.com/${owner}/${repo}/blob/${branch}/${file.path}`,
        title: filename,
        content,
        metadata: {
          repo,
          owner,
          path: file.path,
          author: '',
          createdAt: '',
          updatedAt: commit.author.date,
          sha: file.sha,
        },
      };
    } catch (err) {
      console.error(`Error indexing ${owner}/${repo}/${file.path}:`, err);
    }
  }
}
```

### 12.5 Issues Indexer

```typescript
export async function* indexRepositoryIssues(
  owner: string,
  repo: string,
  tokenManager: GitHubTokenManager,
  baseUrl: string,
  since?: string
): AsyncGenerator<IndexedDocument> {
  const params = new URLSearchParams({
    state: 'all',
    sort: 'updated',
    direction: 'asc',
    per_page: '100',
    ...(since ? { since } : {}),
  });
  
  let page = 1;
  
  while (true) {
    params.set('page', String(page));
    const token = await tokenManager.getToken();
    
    const resp = await fetch(
      `${baseUrl}/repos/${owner}/${repo}/issues?${params}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.full+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
      }
    );
    
    const issues = await resp.json() as Issue[];
    if (issues.length === 0) break;
    
    for (const issue of issues) {
      const isPR = 'pull_request' in issue;
      const type = isPR ? 'pull_request' : 'issue';
      
      // Build full content including comments
      let fullContent = `# ${issue.title}\n\n${issue.body ?? ''}\n`;
      
      // Fetch comments if there are any
      if (issue.comments > 0) {
        const commentsToken = await tokenManager.getToken();
        const commentsResp = await fetch(
          `${baseUrl}/repos/${owner}/${repo}/issues/${issue.number}/comments?per_page=100`,
          {
            headers: {
              'Authorization': `Bearer ${commentsToken}`,
              'Accept': 'application/vnd.github.raw+json',
              'X-GitHub-Api-Version': '2026-03-10',
            },
          }
        );
        const comments = await commentsResp.json() as IssueComment[];
        for (const comment of comments) {
          fullContent += `\n---\n**${comment.user?.login ?? 'unknown'}** (${comment.created_at}):\n\n${comment.body}\n`;
        }
      }
      
      yield {
        id: `${owner}/${repo}/${type}/${issue.number}`,
        type: isPR ? 'pull_request' : 'issue',
        url: issue.html_url,
        title: issue.title,
        content: fullContent,
        metadata: {
          repo,
          owner,
          number: issue.number,
          state: issue.state,
          labels: issue.labels.map(l => l.name),
          author: issue.user?.login ?? '',
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
        },
      };
    }
    
    const link = resp.headers.get('Link');
    if (!link?.includes('rel="next"')) break;
    page++;
  }
}
```

### 12.6 Discussions Indexer

```typescript
const DISCUSSIONS_QUERY = `
  query($owner: String!, $repo: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      discussions(first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id number title body bodyText
          category { name }
          author { login }
          isAnswered
          answer { body author { login } }
          createdAt updatedAt url
          comments(first: 50) {
            totalCount
            nodes {
              id body author { login } createdAt isAnswer
              replies(first: 10) {
                nodes { id body author { login } createdAt }
              }
            }
          }
        }
      }
    }
  }
`;

export async function* indexRepositoryDiscussions(
  owner: string,
  repo: string,
  tokenManager: GitHubTokenManager,
  graphqlUrl: string
): AsyncGenerator<IndexedDocument> {
  let cursor: string | null = null;
  
  do {
    const token = await tokenManager.getToken();
    const resp = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: DISCUSSIONS_QUERY,
        variables: { owner, repo, first: 25, after: cursor },
      }),
    });
    
    const result = await resp.json() as {
      data: {
        repository: {
          discussions: {
            pageInfo: { hasNextPage: boolean; endCursor: string };
            nodes: Array<{
              id: string; number: number; title: string; body: string; bodyText: string;
              category: { name: string };
              author: { login: string } | null;
              isAnswered: boolean;
              answer: { body: string; author: { login: string } | null } | null;
              createdAt: string; updatedAt: string; url: string;
              comments: {
                totalCount: number;
                nodes: Array<{
                  id: string; body: string;
                  author: { login: string } | null;
                  createdAt: string; isAnswer: boolean;
                  replies: { nodes: Array<{ id: string; body: string; author: { login: string } | null; createdAt: string }> };
                }>;
              };
            }>;
          };
        };
      };
    };
    
    const { nodes, pageInfo } = result.data.repository.discussions;
    
    for (const discussion of nodes) {
      let content = `# ${discussion.title}\n\n**Category:** ${discussion.category.name}\n\n${discussion.body}\n`;
      
      for (const comment of discussion.comments.nodes) {
        content += `\n---\n**${comment.author?.login ?? 'unknown'}** (${comment.createdAt})${comment.isAnswer ? ' ✓ Answer' : ''}:\n\n${comment.body}\n`;
        for (const reply of comment.replies.nodes) {
          content += `\n  > **${reply.author?.login ?? 'unknown'}** (${reply.createdAt}):\n  > ${reply.body}\n`;
        }
      }
      
      yield {
        id: `${owner}/${repo}/discussions/${discussion.number}`,
        type: 'discussion',
        url: discussion.url,
        title: discussion.title,
        content,
        metadata: {
          repo,
          owner,
          number: discussion.number,
          state: discussion.isAnswered ? 'answered' : 'open',
          author: discussion.author?.login ?? '',
          createdAt: discussion.createdAt,
          updatedAt: discussion.updatedAt,
        },
      };
    }
    
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);
}
```

### 12.7 Main Connector Orchestrator

```typescript
export class GitHubConnector {
  private tokenManager: GitHubTokenManager;
  
  constructor(private config: GitHubConnectorConfig) {
    this.tokenManager = new GitHubTokenManager(
      config.appId,
      config.privateKeyPem,
      config.installationId,
      config.baseUrl
    );
  }
  
  async *indexAll(since?: string): AsyncGenerator<IndexedDocument> {
    const repos = await listInstallationRepositories(
      this.tokenManager,
      this.config.baseUrl
    );
    
    // Filter to configured repos if specified
    const targetRepos = this.config.repos
      ? repos.filter(r => this.config.repos!.includes(`${r.owner}/${r.name}`))
      : repos;
    
    for (const repo of targetRepos) {
      console.log(`Indexing ${repo.owner}/${repo.name}...`);
      
      // Files
      yield* indexRepositoryFiles(
        repo.owner,
        repo.name,
        this.config.defaultBranch ?? repo.defaultBranch,
        this.tokenManager,
        this.config.baseUrl,
        this.config.fileExtensions,
        this.config.maxFileSizeBytes
      );
      
      // Issues + PRs
      if (this.config.indexIssues !== false) {
        yield* indexRepositoryIssues(
          repo.owner, repo.name, this.tokenManager, this.config.baseUrl, since
        );
      }
      
      // Discussions
      if (this.config.indexDiscussions !== false && repo.hasDiscussions) {
        yield* indexRepositoryDiscussions(
          repo.owner, repo.name, this.tokenManager, this.config.graphqlUrl
        );
      }
      
      // Wiki
      if (this.config.indexWikis !== false && repo.hasWiki) {
        // Wiki indexing via git clone — implement with simple-git
        console.log(`Wiki indexing for ${repo.owner}/${repo.name} requires git clone`);
      }
    }
  }
}
```

---

## 13. What to Build vs. What to Skip

### Build First (P0 — High Value)

| Feature | Why |
|---------|-----|
| GitHub App auth with auto-rotating installation tokens | Prerequisite for everything; org-scale |
| Repository file tree + content download | Core code indexing — this is the primary use case |
| Issues with comments | Rich structured knowledge (decisions, context, bugs) |
| Code search (`/search/code`) | On-demand query capability; complements crawl |
| Discussions via GraphQL | Q&A content often has highest signal density |
| Incremental sync via `since` + SHA comparison | Essential for keeping index fresh without full re-crawl |

### Build in Phase 2 (P1 — Useful)

| Feature | Why |
|---------|-----|
| Wiki indexing via git clone | Wikis often contain project documentation — valuable but complex |
| Pull request reviews + comments | Decision history, code review rationale |
| Webhook-based real-time updates | Faster freshness than polling; needs public endpoint |
| New Code Search (regex/symbol mode) | Better queries; 100-result cap limits use for crawling |
| Multi-installation support | If connector needs to span multiple orgs |

### Skip or Deprioritize (P2)

| Feature | Why to skip |
|---------|------------|
| Commit-level indexing | High volume, low information density; duplicates file content |
| Actions/workflow file indexing | Covered by file tree indexer (.github/workflows/*.yml) |
| Releases/changelogs | File tree covers CHANGELOG.md; low additional value |
| Gists | Not enterprise content |
| GitHub Projects (kanban) | Low text density; metadata-heavy |
| Security scanning results | Specialized; different audience |

---

## 14. Limitations, Gotchas, and Edge Cases

### Code Search Gotchas

1. **Only default branch indexed.** You cannot search non-default branches via the code search API. For branches, use direct tree traversal.

2. **Forks are not indexed by default.** Forks with fewer stars than parent are excluded. Use `fork:true` but it only applies to forks with more stars than the parent.

3. **`incomplete_results: true` is a real risk.** At the code search endpoint's 10 req/min limit, even a modest indexing job can hit timeouts and get partial results. Always check this field.

4. **Legacy search vs. new code search query syntax are different.** The `content:` qualifier works only in new code search. The `in:file` qualifier works only in legacy. These are not interchangeable.

5. **Very large organizations**: Code search only searches up to 4,000 repositories per query. For orgs with thousands of repos, you need to scope queries per-repo using `repo:owner/name`.

### File Tree / Contents Gotchas

6. **`truncated: true` in tree response.** Very large repositories (monorepos, etc.) will truncate the tree. You must detect this and fall back to recursive `/contents/` traversal, which is much more expensive (1 API call per directory level).

7. **Download URLs expire.** The `download_url` field in `/contents/` responses is a time-limited URL. Never cache these; always re-request the file via the API.

8. **Submodules appear in the tree with `type: "commit"`.** You cannot download submodule content via the contents API. You will get a `submodule_git_url` but must handle separately.

9. **Files > 100 MB are completely unsupported** by the contents API. They exist in the tree but cannot be fetched. Filter by `size` in tree entries.

10. **Symlinks.** A symlink entry where the target is a file in the same repo returns the target's content. External symlinks return the symlink object. Both appear as `type: "file"` in the contents API.

### Rate Limit Gotchas

11. **Search code rate limit is 10 req/min, not 30.** This applies per-app, not per-user. Plan for ~600 code search requests per hour per installation.

12. **Secondary rate limits trigger HTTP 403** with a `Retry-After` header. Unlike primary rate limits (429), these are harder to predict. They trigger on concurrent requests and burst patterns.

13. **GitHub App installation token scaling** only kicks in above 20 repos/users. A new installation on a small org has only 5,000 req/hr REST, not 15,000. Don't rely on the high limit for early testing.

14. **GraphQL secondary limit is 2,000 points/minute per endpoint** (900/min for REST). Deep nested queries can hit this quickly. Keep nested `first:` values below 25 for typical queries.

### Authentication Gotchas

15. **Installation token is 1 hour TTL.** Refresh at 55-minute mark to avoid mid-request expiry. The new stateless token format (`ghs_APPID_JWT`) means you should not validate token length.

16. **App must be installed on the org before you can get repos.** `GET /installation/repositories` returns only repos the installation has access to, not all repos in the org.

17. **Per-repository access tokens** are possible: when calling `/app/installations/{id}/access_tokens`, pass `repository_ids` to scope the token to specific repos. Useful for least-privilege patterns.

### Wiki Gotchas

18. **No API for wikis.** The only supported method is git clone via `{repo_url}.wiki.git`. This means your connector needs git installed.

19. **Wiki can be enabled (`has_wiki: true`) but empty.** The wiki git repo has no commits in this case. `git clone` will succeed but the directory will be empty.

20. **Wiki pages use `-` instead of spaces in filenames.** `My Page Title.md` is stored as `My-Page-Title.md`. Reverse this for display titles.

### Discussions Gotchas

21. **Discussions are GraphQL-only.** Any migration to REST should be straightforward if GitHub adds it, but as of 2026 it's GraphQL exclusively.

22. **Comment replies are nested one level only.** Replies to replies are not supported in GitHub Discussions. The `replies` field on `DiscussionComment` is the complete reply thread.

23. **Deleted comments show `deletedAt` but `body` becomes `""` and `author` becomes null.** Your indexer must handle empty bodies gracefully.

24. **`has_discussions` field on repositories.** Must check this before querying discussions, or you'll get a GraphQL error on repos with discussions disabled.

### GHES Gotchas

25. **GHES version matters.** Discussions were added in GHES 3.x. Fine-grained PATs require GHES 3.10+. Always check the GHES version before assuming feature availability.

26. **GHES rate limits are admin-configurable** and may differ from GitHub.com. Read `x-ratelimit-*` headers at runtime; never hardcode limits.

27. **GHES has a separate app registration.** A GitHub App registered on GitHub.com cannot be installed on GHES. You need a separate app registration on each GHES instance.

---

## Sources

- GitHub REST API documentation: https://docs.github.com/en/rest
- REST API version 2026-03-10: https://github.blog/changelog/2026-03-12-rest-api-version-2026-03-10-is-now-available/
- Search API: https://docs.github.com/en/rest/search/search
- Repository contents API: https://docs.github.com/en/rest/repos/contents
- Git trees API: https://docs.github.com/en/rest/git/trees
- Issues API: https://docs.github.com/en/rest/issues/issues
- Pull requests API: https://docs.github.com/en/rest/pulls/pulls
- Rate limits (REST): https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- Rate limits (GraphQL): https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api
- GraphQL Discussions guide: https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions
- GitHub Apps overview: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps
- Installation access tokens: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- Code search (legacy): https://docs.github.com/en/search-github/searching-on-github/searching-code
- GitHub Code Search (new): https://docs.github.com/en/search-github/github-code-search/about-github-code-search
- Code search syntax: https://docs.github.com/en/search-github/github-code-search/understanding-github-code-search-syntax
- App permissions: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- Wiki documentation: https://docs.github.com/en/communities/documenting-your-project-with-wikis
- Events API: https://docs.github.com/en/rest/activity/events
- GHES REST API: https://docs.github.com/en/enterprise-server@3.21/rest
