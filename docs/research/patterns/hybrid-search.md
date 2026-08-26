# Hybrid BM25 + Vector Search: Implementation Patterns for Node.js

> Research for markdown-for-agents-mcp Phase 2 enterprise knowledge index.
> Covers BM25 mathematics, HNSW tuning, RRF fusion, Node.js library
> selection, PostgreSQL+pgvector, Qdrant, SQLite+FTS5, SPLADE/BM42 learned
> sparse vectors, chunking strategies, and a complete TypeScript reference
> implementation.

**Status:** Research complete — August 2026  
**Applies to:** Phase 2 knowledge index (SharePoint + Confluence connectors, per-user ACL enforcement)

---

## Table of Contents

1. [Why Hybrid Search](#1-why-hybrid-search)
2. [BM25: Full Mathematical Explanation](#2-bm25-full-mathematical-explanation)
3. [Vector Search: HNSW and Distance Metrics](#3-vector-search-hnsw-and-distance-metrics)
4. [Reciprocal Rank Fusion (RRF)](#4-reciprocal-rank-fusion-rrf)
5. [Linear Score Combination](#5-linear-score-combination)
6. [Node.js BM25 Libraries: Detailed Comparison](#6-nodejs-bm25-libraries-detailed-comparison)
7. [PostgreSQL: pgvector + BM25 Hybrid](#7-postgresql-pgvector--bm25-hybrid)
8. [Qdrant: Dense + Sparse Hybrid](#8-qdrant-dense--sparse-hybrid)
9. [SPLADE and BM42: Learned Sparse Vectors](#9-splade-and-bm42-learned-sparse-vectors)
10. [SQLite: FTS5 + sqlite-vec Lightweight Hybrid](#10-sqlite-fts5--sqlite-vec-lightweight-hybrid)
11. [Chunking Strategies](#11-chunking-strategies)
12. [Late Chunking (Jina v3)](#12-late-chunking-jina-v3)
13. [Complete TypeScript Reference Implementation](#13-complete-typescript-reference-implementation)
14. [Failure Modes and Gotchas](#14-failure-modes-and-gotchas)
15. [Decision Guide: What to Build for Phase 2](#15-decision-guide-what-to-build-for-phase-2)

---

## 1. Why Hybrid Search

### The Core Tension

Sparse (BM25) and dense (vector) retrieval fail in opposite, complementary
directions. Combining them is not an optimisation — it is a correctness fix for
real production workloads.

| Query type | BM25 (sparse) | Vector (dense) | Hybrid |
|---|---|---|---|
| Exact identifiers: `SQLSTATE[40P01]`, `PROD-SKU-7842X` | Excellent | Poor (compressed away) | Excellent |
| Named entities with rare proper nouns | Excellent | Moderate | Excellent |
| Paraphrased natural language: "how do I stop feeling overwhelmed" | Poor | Excellent | Excellent |
| Synonyms: "automobile" vs "car" | Poor | Excellent | Excellent |
| Negations: "termination without notice" vs "with notice" | Good | Poor (embeds similarly) | Good |
| Mixed: "OAuth error OA-403 in production" | Partial | Partial | Excellent |

### Benchmarks

Empirical numbers from multiple independent sources (2026):

| Method | Recall@10 | NDCG@10 (WANDS) |
|---|---|---|
| BM25 only | 65% | 0.6983 |
| Dense vector only | 78% | 0.6953 |
| Hybrid (RRF) | **91%** | **0.7497** |

Sources: [supermemory.ai/blog/hybrid-search-guide](https://supermemory.ai/blog/hybrid-search-guide/),
[digitalapplied.com](https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026)

The 13-percentage-point recall lift is a genuine, reproducible result, not
vendor marketing. Qdrant's own five-dataset benchmark shows hybrid beats the
stronger individual retriever on four of five datasets. The one exception
(DBPedia-entity) is exactly the kind of dataset where dense retrieval already
dominates and keyword signals are sparse — a useful reminder that hybrid is not
universally better.

### Latency Cost

Running both retrievers in parallel adds roughly 4–12ms at p50 depending on
corpus size and infrastructure. LLM inference dominates at 500ms–2 seconds.
The overhead is noise; the accuracy gain is everything.
Source: [qdrant.tech/articles/hybrid-search](https://qdrant.tech/articles/hybrid-search/)

### Storage Cost

Expect approximately 1.4× the disk footprint of vector-only search (you
maintain both an inverted index and a vector index on the same corpus).

---

## 2. BM25: Full Mathematical Explanation

### The Algorithm

BM25 (Okapi BM25) is a probabilistic retrieval model developed by Stephen E.
Robertson and Karen Spärck Jones at City University London in the 1980s–90s. It
is the dominant sparse retrieval algorithm underpinning Elasticsearch,
OpenSearch, Solr, Qdrant's sparse vectors, and Pinecone's hybrid mode.

The BM25 score for document `d` given query `q` with terms `t₁, t₂, ..., tₙ`:

```
score(d, q) = Σᵢ IDF(tᵢ) × [ TF(tᵢ, d) × (k₁ + 1) ]
                                / [ TF(tᵢ, d) + k₁ × (1 - b + b × |d|/avgdl) ]
```

Where:
- `TF(t, d)` = term frequency of `t` in document `d`
- `IDF(t)` = inverse document frequency of term `t` (see variants below)
- `|d|` = length of document `d` in tokens
- `avgdl` = average document length across corpus
- `k₁` = term-frequency saturation parameter
- `b` = document-length normalisation parameter

### IDF Variants

Three IDF formulations are in common use:

| Variant | Formula | Notes |
|---|---|---|
| Robertson (classic) | `log((N - df + 0.5) / (df + 0.5))` | Original; can go negative for very common terms |
| BM25+ | `log((N + 1) / df)` | Always non-negative; Lucene default |
| IDF with smoothing | `log(1 + (N - df + 0.5) / (df + 0.5))` | Bounded; wink-bm25 uses this as parameter `k` |

Where `N` = total documents, `df` = documents containing term.

### k1 Parameter: Term-Frequency Saturation

`k₁ ∈ [1.2, 2.0]` is the most consequential parameter.

```
k₁ = 1.2  → Lucene/Elasticsearch default, fast TF saturation
k₁ = 1.5  → balanced; good starting point for enterprise docs
k₁ = 2.0  → slow saturation; repetition still rewarded at high TF
k₁ = 0.0  → binary: term present or not, no TF weighting (never do this)
```

**Effect:** With `k₁ = 1.2`, the difference between a term appearing 1× vs 2×
is substantial; 20× vs 21× is negligible. With `k₁ = 2.0`, the score keeps
climbing longer before it plateaus. For long-form enterprise documentation
(SharePoint pages, Confluence articles), `k₁ = 1.5` is a reasonable starting
point over the Lucene default of 1.2.

### b Parameter: Document-Length Normalisation

`b = 0.75` is the standard default.

```
b = 0.0  → no normalisation; long docs always win
b = 0.75 → standard; shorter focused docs preferred over long incidental matches
b = 1.0  → full normalisation; document length has maximum effect
```

**Effect:** Without normalisation (`b = 0`), a 20,000-word Confluence page
that mentions "authentication" three times beats a 200-word article dedicated
to authentication. `b = 0.75` corrects this. For very short docs (code
comments, commit messages), lower `b` values (0.4–0.6) may perform better.

### Worked Example

Corpus of 3 documents, query = "database search":

```
Documents:
  d1: "PostgreSQL is a powerful database system with full text search" (9 tokens)
  d2: "Search engines use inverted indexes for text retrieval" (9 tokens)
  d3: "The database stores user records and metadata" (8 tokens)

avgdl = 8.67

For term "database": df=2, N=3, IDF = log((3-2+0.5)/(2+0.5)) = log(0.6) ≈ -0.51
For term "search":   df=2, N=3, IDF = log((3-2+0.5)/(2+0.5)) ≈ -0.51

TF("database", d1) = 1, TF("search", d1) = 1
TF("database", d3) = 1, TF("search", d3) = 0

k1=1.2, b=0.75:
score(d1) = IDF("database") × TF_norm + IDF("search") × TF_norm
          ≈ -0.51 × 0.52 + -0.51 × 0.52 ≈ -0.53
score(d3) ≈ -0.51 × 0.52 + 0 ≈ -0.27

Note: With Robertson IDF, common terms go negative. BM25+ IDF avoids this.
```

In practice, BM25 libraries use BM25+ or clamped Robertson IDF to keep scores
non-negative.

### BM25 Variants: BM25L and BM25+

| Variant | Key Difference | When to Use |
|---|---|---|
| BM25 (Lucene) | Standard TF normalisation | Default; works for most corpora |
| BM25L | Lowers penalty for long documents | Enterprise docs with genuinely long relevant pages |
| BM25+ | Guarantees non-zero term contribution | Avoids negative IDF; generally better |
| BM25-Adpt | Adaptive k₁ per term | Research; rarely implemented in production |

Source: bun-bm25s supports all five variants:
`Robertson`, `Lucene` (default), `ATIRE`, `BM25L`, `BM25+`.

---

## 3. Vector Search: HNSW and Distance Metrics

### HNSW: Hierarchical Navigable Small World

HNSW is the dominant ANN (Approximate Nearest Neighbour) index used by Qdrant,
Weaviate, Pinecone, and pgvector (since 0.5.0). It builds a multi-layer
navigable graph where each layer is a subset of the layer below, enabling
efficient greedy graph traversal during search.

**Conceptual structure:**

```
Layer 2 (sparse): [node_A] ──── [node_F]
Layer 1 (medium): [node_A] ── [node_C] ── [node_F]
Layer 0 (all):    [A]─[B]─[C]─[D]─[E]─[F]─[G]─[H]
                   ↑ full graph with short + long edges
```

Search starts at a random entry point in the highest layer, greedily moves
toward the query vector, descends to lower layers, and refines within a
neighbourhood.

### HNSW Construction Parameters

| Parameter | Default | Effect | Tuning Guide |
|---|---|---|---|
| `M` (max connections per node) | 16 | Controls graph density and memory | Raise to 32–64 for better recall; doubles memory per node |
| `ef_construction` | 100 | Candidates evaluated during index build | Raise for better recall; slows build time linearly |
| `ef_search` (Qdrant: `hnsw_ef`) | 128 | Candidates evaluated at query time | Session-settable; raise for recall, lower for latency |

**pgvector tuning example:**

```sql
-- Build a high-recall HNSW index
CREATE INDEX chunks_embedding_hnsw ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 32, ef_construction = 200);

-- Tune search recall per session
SET hnsw.ef_search = 100; -- default 40; raise if missing results
```

**Qdrant HNSW config:**

```json
{
  "hnsw_config": {
    "m": 16,
    "ef_construct": 100,
    "full_scan_threshold": 10000,
    "max_indexing_threads": 0,
    "on_disk": false,
    "payload_m": 16
  }
}
```

Source: [qdrant.tech/documentation/concepts/indexing](https://qdrant.tech/documentation/concepts/indexing/)

### HNSW vs IVFFlat

| Property | HNSW | IVFFlat |
|---|---|---|
| Recall at same latency | Higher | Lower |
| Build time | Slower (graph construction) | Faster |
| Memory | More (graph edges) | Less |
| Incremental inserts | Yes, no retraining | Degrades without retraining |
| pgvector availability | >= 0.5.0 | Always |
| **Recommendation** | **Default for growing corpora** | Only for read-heavy, rarely-updated datasets |

**Key gotcha:** IVFFlat built on an empty or near-empty table has terrible
recall because the list centroids are not representative. Always populate data
before building IVFFlat. HNSW does not have this problem.

### Distance Metrics: Cosine vs Dot Product vs L2

| Metric | Operator (pgvector) | When to Use |
|---|---|---|
| Cosine similarity | `<=>` (`vector_cosine_ops`) | **Default for sentence embeddings.** Ignores magnitude; angle only. |
| Dot product | `<#>` (`vector_ip_ops`) | Normalised embeddings where magnitude encodes confidence (Matryoshka) |
| L2 (Euclidean) | `<->` (`vector_l2_ops`) | Image embeddings, pixel features; rarely used for text |

**Rule:** If your embedding model produces L2-normalised vectors (most sentence
transformers do), cosine and dot product give identical rankings. Use cosine as
the explicit, readable default. Only switch to dot product if your model
documentation specifically recommends it (e.g. OpenAI `text-embedding-3-*`
supports MRL and benefits from dot product in cascaded retrieval scenarios).

### ef_search vs Recall Trade-off

From empirical benchmarks on 100K-document corpora:

| ef_search | Recall@10 | Query latency (p50) |
|---|---|---|
| 20 | ~92% | 3ms |
| 40 (default) | ~96% | 6ms |
| 100 | ~99% | 15ms |
| 200 | ~99.5% | 30ms |

**Recommendation for Phase 2:** Start with `ef_search = 64` and measure. Only
raise above 100 if you have labeled evaluation queries showing recall deficits.

---

## 4. Reciprocal Rank Fusion (RRF)

### The Formula

RRF was introduced by Gordon V. Cormack, Charles L. A. Clarke, and Stefan
Buettcher at the University of Waterloo (SIGIR 2009): "Reciprocal Rank Fusion
outperforms Condorcet and individual Rank Learning Methods."

```
score(d) = Σ_q  1 / (k + rank_q(d))
```

Where:
- `d` = document
- `q` = one retriever in the set of retrievers
- `rank_q(d)` = 1-indexed rank of document `d` in retriever `q`'s results
- `k` = smoothing constant (default: **60**)
- Documents absent from retriever `q`'s results contribute 0 from that retriever

### Why k = 60

The constant `k` dampens the contribution of top-ranked results. With `k = 60`:
- Rank 1 contributes `1/(60+1) = 0.0164`
- Rank 10 contributes `1/(60+10) = 0.0143`
- Rank 50 contributes `1/(60+50) = 0.0091`

This relatively flat weighting means documents that appear in both lists at
moderate ranks still combine to beat documents that appear only in one list at
rank 1. The `k = 60` value is the Elasticsearch production default and works
well across most corpora without dataset-specific tuning. It is the right
starting point.

**Raising k:** Flattens rank contributions further — more democratic, less
sensitive to which retriever has the #1 result. Use when both retrievers have
roughly equal quality.

**Lowering k (e.g. k = 2, Qdrant default):** Amplifies rank differences — the
#1 result in each list dominates. Qdrant defaults to `k = 2` for its
implementation. Elasticsearch defaults to `k = 60`. Always check which default
your system uses.

**k = 60 is almost always correct. Do not tune k without labeled evaluation
data.**

### Worked Example

Two retrievers, query "PostgreSQL performance tuning":

```
BM25 results:     [d3, d1, d4, d2]  (ranks 1-4)
Vector results:   [d1, d3, d5, d2]  (ranks 1-4)

RRF scores with k=60:
  d1: 1/(60+2) + 1/(60+1) = 0.0161 + 0.0164 = 0.0325
  d3: 1/(60+1) + 1/(60+2) = 0.0164 + 0.0161 = 0.0325
  d2: 1/(60+4) + 1/(60+4) = 0.0156 + 0.0156 = 0.0313
  d4: 1/(60+3) + 0         = 0.0159
  d5: 0         + 1/(60+3) = 0.0159

Final ranking: d1=d3 > d2 > d4=d5
```

Documents appearing in both lists are promoted — this is the core property.

### TypeScript Implementation

```typescript
interface RankedResult {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion across N ranked lists.
 * @param rankedLists - Array of ranked result arrays (each is [id, ...metadata])
 * @param k - Smoothing constant (default 60, Elasticsearch production default)
 * @param weights - Optional per-retriever weights (default all 1.0)
 */
function reciprocalRankFusion(
  rankedLists: string[][],
  k: number = 60,
  weights?: number[]
): RankedResult[] {
  const scores = new Map<string, number>();

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const list = rankedLists[listIdx];
    const weight = weights?.[listIdx] ?? 1.0;

    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank];
      const contribution = weight / (k + rank + 1); // 1-indexed rank
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    }
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// Usage:
const bm25Ranked   = ['doc3', 'doc1', 'doc4', 'doc2'];
const vectorRanked = ['doc1', 'doc3', 'doc5', 'doc2'];

const fused = reciprocalRankFusion([bm25Ranked, vectorRanked]);
// => [{id: 'doc1', score: 0.0325}, {id: 'doc3', score: 0.0325}, ...]
```

### Weighted RRF (Qdrant >= 1.17.0)

Qdrant v1.17 added per-retriever weights to the RRF formula:

```
score(d) = Σ_q  w_q / (k + rank_q(d))
```

Where `w_q` is the weight assigned to retriever `q`. If dense retrieval
dominates on your workload (natural-language queries), assign it `w = 2.0` and
BM25 `w = 1.0`. Only tune after you have labeled evaluation results.

```typescript
// JavaScript/TypeScript Qdrant client: weighted RRF
client.query("{collection_name}", {
  prefetch: [
    { query: sparseVector, using: 'bm25',  limit: 50 },
    { query: denseVector,  using: 'dense', limit: 50 },
  ],
  query: {
    rrf: {
      k: 60,
      // weights correspond to prefetch order
    }
  },
  limit: 10,
});
```

Source: [qdrant.tech/documentation/concepts/hybrid-queries](https://qdrant.tech/documentation/concepts/hybrid-queries/)

### RRF with More Than 2 Retrievers

RRF extends linearly to any number of ranked lists. For three retrievers:

```typescript
const fused = reciprocalRankFusion([
  bm25Ranked,    // weight: 1.0
  denseRanked,   // weight: 1.0
  recentRanked,  // weight: 0.5 — recency signal, lower weight
], 60, [1.0, 1.0, 0.5]);
```

This is useful in Phase 2 where you might add a recency signal (recently
modified SharePoint pages) or an access-frequency signal.

---

## 5. Linear Score Combination

### The Score-Incompatibility Problem

BM25 scores are unbounded positive integers. Cosine similarity is bounded in
[-1, 1]. A naive weighted sum gives BM25 dominant weight by accident:

```
// WRONG: BM25 dominates because its scale is ~100× larger
combinedScore = 0.5 * bm25Score + 0.5 * cosineSimilarity
//              = 0.5 * 47.3    + 0.5 * 0.82  = 23.65 + 0.41
//              ≈ entirely driven by BM25
```

### Min-Max Normalisation

Both scores must be normalised to [0, 1] before combining:

```typescript
function minMaxNormalize(scores: Map<string, number>): Map<string, number> {
  const values = Array.from(scores.values());
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  if (range === 0) return new Map(Array.from(scores).map(([id]) => [id, 1.0]));

  return new Map(
    Array.from(scores).map(([id, score]) => [id, (score - min) / range])
  );
}

function linearCombination(
  bm25Scores: Map<string, number>,
  vectorScores: Map<string, number>,
  alpha: number = 0.5  // alpha=1.0 → pure vector; alpha=0.0 → pure BM25
): RankedResult[] {
  const normBM25   = minMaxNormalize(bm25Scores);
  const normVector = minMaxNormalize(vectorScores);

  const allIds = new Set([...bm25Scores.keys(), ...vectorScores.keys()]);
  const combined = Array.from(allIds).map(id => ({
    id,
    score: alpha * (normVector.get(id) ?? 0) +
           (1 - alpha) * (normBM25.get(id) ?? 0),
  }));

  return combined.sort((a, b) => b.score - a.score);
}
```

### DBSF: Distribution-Based Score Fusion

Qdrant supports DBSF (Distribution-Based Score Fusion) as an alternative to
RRF. Instead of discarding scores, it normalises each list using its mean and
standard deviation, then adds the normalised scores. This preserves the size of
score gaps — a strong lead from one retriever can affect the final ranking.

```
normalised_score(d, q) = (score(d, q) - mean_q) / (3 × std_q)  +  0.5
```

Qdrant's implementation clamps to [0, 1] and adds both normalised scores.

**RRF vs DBSF:** RRF is the safer default. DBSF can outperform RRF when one
retriever produces more signal-rich scores for your specific corpus, but
measuring this requires labeled evaluation. Start with RRF.

### Weaviate's Alpha Parameter

Weaviate uses a single `alpha` parameter on the `hybrid` query field (not RRF):

```graphql
{
  Get {
    Document(
      hybrid: {
        query: "PostgreSQL performance"
        alpha: 0.75   # 0.0 = pure BM25, 1.0 = pure vector
      }
      limit: 10
    ) { content }
  }
}
```

**Note:** Weaviate switched its default fusion algorithm from `rankedFusion`
(RRF) to `relativeScoreFusion` in v1.24 (2024). If upgrading Weaviate, check
this default has not changed your results silently.
Source: [digitalapplied.com](https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026)

### Weight Tuning by Query Type

```typescript
// Adaptive weight selection based on query classification
function selectFusionWeights(query: string): { bm25: number; vector: number } {
  const identifierPattern = /\b[A-Z0-9]{3,}-[A-Z0-9\-]+\b|\b[0-9]{4,}\b|v[0-9]+\.[0-9]+/;
  const hasIdentifier = identifierPattern.test(query);

  if (hasIdentifier) {
    return { bm25: 0.8, vector: 0.2 };  // SKUs, error codes, version strings
  }

  const shortQuery = query.trim().split(/\s+/).length <= 3;
  if (shortQuery) {
    return { bm25: 0.6, vector: 0.4 };  // Short keyword queries
  }

  return { bm25: 0.4, vector: 0.6 };    // Natural language questions
}
```

---

## 6. Node.js BM25 Libraries: Detailed Comparison

### Library Overview

| Library | Weekly Downloads | Zero Deps | TypeScript | BM25 Variant | Persist | k₁/b Tunable |
|---|---|---|---|---|---|---|
| `bun-bm25s` | Growing | Yes | Full | 5 variants | Binary + JSON | Yes |
| `wink-bm25-text-search` | ~15k | No (winkNLP) | Yes (types) | BM25F | JSON export | Yes |
| `@jeffbarg/bm25` | Low | Yes | Full | Standard | No | Limited |
| `fast-bm25` | Very low | Yes | Full | Standard | No | Yes |
| `OkapiBM25` | Low | Yes | Full | Okapi BM25 | No | Yes |
| `bm25-lite` | Very low | Yes | Full | Okapi BM25 | No | Partial |
| MiniSearch | ~500k | Yes | Full | BM25-inspired | JSON | Limited |

### bun-bm25s: Recommended for Production

Source: [engineering.oakoliver.com/articles/bun-bm25s-beating-python-at-full-text-search](https://engineering.oakoliver.com/articles/bun-bm25s-beating-python-at-full-text-search)

**Architecture:** Eager sparse scoring using Compressed Sparse Column (CSC)
matrices backed by `Float64Array` and `Uint32Array`. Precomputes all
(document, term) BM25 scores at index time; retrieval becomes array lookups.

**Performance benchmarks (Apple M2 Max, Bun 1.3.10):**

| Corpus | Indexing rate | Retrieval (k=10) |
|---|---|---|
| 10k docs | 117ms (2.1× faster than Python bm25s) | 27,103 QPS |
| 50k docs | 571ms | 6,086 QPS |
| 100k docs | 1.20s | 3,181 QPS |

Peak indexing: **4.6 million tokens per second**.

```typescript
import { BM25, tokenize } from "bun-bm25s";

const corpus = [
  "SharePoint document on authentication policies",
  "Confluence page about database performance tuning",
  "Meeting notes: OAuth token expiry investigation",
];

// Index at ingestion time
const corpusTokens = tokenize(corpus);
const retriever = new BM25();  // defaults to Lucene variant
retriever.index(corpusTokens);

// Persist to disk (50MB for 100k docs)
await retriever.save("./indexes/bm25-index");

// Load later (sub-100ms for 100k docs)
const loaded = await BM25.load("./indexes/bm25-index");

// Query
const queryTokens = tokenize(["oauth authentication token"]);
const { documents, scores } = loaded.retrieve(queryTokens, { k: 20 });
// Returns top-20 document indices with BM25 scores
```

**Limitation:** Requires Bun runtime (not Node.js). If you must target Node.js,
use `wink-bm25-text-search` or implement BM25 in-process.

### wink-bm25-text-search: Best for Node.js

Source: [npmjs.com/package/wink-bm25-text-search](https://www.npmjs.com/package/wink-bm25-text-search)

**Key features:**
- BM25F variant: field-weighted (title × 2, body × 1, tags × 0.5)
- Configurable `k1`, `b`, and IDF smoothing `k` via `defineConfig`
- In-memory; serialise/deserialise via `exportJSON()`/`importJSON()`
- Integrates with winkNLP for negation detection, stemming, lemmatization

```typescript
import bm25 from 'wink-bm25-text-search';
import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';

const nlp = winkNLP(model);
const its = nlp.its;
const engine = bm25();

// Preprocessing pipeline (handles negation)
const prepTask = (text: string): string[] => {
  const tokens: string[] = [];
  nlp.readDoc(text)
    .tokens()
    .filter(t => t.out(its.type) === 'word' && !t.out(its.stopWordFlag))
    .each(t => tokens.push(
      t.out(its.negationFlag) ? '!' + t.out(its.stem) : t.out(its.stem)
    ));
  return tokens;
};

// Configure with BM25 parameters
engine.defineConfig({
  fldWeights: { title: 2, content: 1, tags: 0.5 },
  bm25Params: { k1: 1.5, b: 0.75, k: 1 },  // k=1 is IDF smoothing constant
});

engine.definePrepTasks([prepTask]);

// Index documents
const docs = [
  { title: 'Auth Policies', content: 'OAuth token configuration...', tags: 'auth security' },
  { title: 'DB Tuning',     content: 'PostgreSQL HNSW index tuning...', tags: 'database' },
];

docs.forEach((doc, i) => engine.addDoc(doc, i));
engine.consolidate();

// Search: returns [[docId, score], ...] sorted by score descending
const results: [number, number][] = engine.search('authentication token');
```

**Default parameters from `defineConfig`:**
```typescript
{
  fldWeights: { /* required */ },
  bm25Params: {
    k1: 1.2,  // TF saturation
    b:  0.75, // length normalisation
    k:  1     // IDF smoothing (different from RRF k!)
  }
}
```

**gotcha:** The `k` in `bm25Params` is the IDF smoothing constant (not the RRF
constant k=60). They are unrelated but share the same variable name.

### MiniSearch: When You Need More Than BM25

MiniSearch (~500k weekly downloads) is the most popular pure-JS full-text
search library. It uses a BM25-inspired algorithm with an in-memory inverted
index, prefix search, fuzzy matching, and auto-suggest. It is not pure BM25
and does not support field-weighted BM25F out of the box, but it has superior
DX for simple use cases.

```typescript
import MiniSearch from 'minisearch';

const miniSearch = new MiniSearch({
  fields: ['title', 'content'],
  storeFields: ['title', 'chunkId'],
  searchOptions: {
    boost: { title: 2 },       // title matches score higher
    fuzzy: 0.2,                // allow 20% fuzzy edit distance
    prefix: true,              // match "auth" against "authentication"
  }
});

// Index
miniSearch.addAll(documents);

// Query
const results = miniSearch.search('oauth authentication', {
  fuzzy: 0.2,
  prefix: true,
});
```

**Limitation for Phase 2:** MiniSearch lacks true IDF weighting and is not
suitable as the BM25 arm of a production hybrid retriever if you need
defensible relevance. Use it for lightweight in-browser search or autocomplete.

### Library Decision Matrix for Phase 2

| Scenario | Recommendation |
|---|---|
| Phase 2 on Bun runtime, large corpus (>50k chunks) | `bun-bm25s` — fastest, zero deps, binary persist |
| Phase 2 on Node.js, moderate corpus (<50k chunks) | `wink-bm25-text-search` — BM25F, field weights, stemming |
| Phase 2 with PostgreSQL | Use native `tsvector`/`ts_rank_cd` + `pg_search` if needed |
| Phase 2 with Qdrant | Use Qdrant's built-in BM25 sparse vector modifier |
| Lightweight MCP server demo / dev mode | `MiniSearch` or in-process SQLite FTS5 |

---

## 7. PostgreSQL: pgvector + BM25 Hybrid

### When to Choose PostgreSQL

PostgreSQL is the right backend if:
- Your metadata already lives in Postgres (high likelihood for enterprise)
- You need ACID transactions across search and data writes
- You need multi-tenant filtering with row-level security (RLS)
- You want to avoid operating a separate search cluster

### Schema Design

```sql
-- Phase 2 knowledge index schema
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm; -- for similarity search fallback

CREATE TABLE chunks (
  id              BIGSERIAL PRIMARY KEY,
  document_id     BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL,          -- for RLS / ACL enforcement
  user_ids        UUID[],                 -- transitiveMemberOf result cache
  source_type     TEXT NOT NULL,          -- 'sharepoint' | 'confluence'
  source_url      TEXT NOT NULL,
  chunk_index     INT NOT NULL,
  content         TEXT NOT NULL,
  embedding       VECTOR(1024),           -- match your model dimensions
  content_tsv     TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', content), 'B')
  ) STORED,
  title           TEXT,
  modified_at     TIMESTAMPTZ,
  indexed_at      TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT chunks_doc_index_unique UNIQUE (document_id, chunk_index)
);

-- Indexes
CREATE INDEX chunks_embedding_hnsw ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 32, ef_construction = 200);

CREATE INDEX chunks_fts_gin  ON chunks USING gin (content_tsv);
CREATE INDEX chunks_tenant   ON chunks (tenant_id);
CREATE INDEX chunks_user_ids ON chunks USING gin (user_ids);
CREATE INDEX chunks_modified ON chunks (modified_at DESC);
```

### The Hybrid Query with RRF

```sql
-- $1: query text (raw user input)
-- $2: query embedding (float[] from your embedding model)
-- $3: tenant_id filter (UUID, pass NULL to skip)
-- $4: user_id for ACL check (UUID)
-- Returns top 20 chunks for reranking

WITH lexical AS (
  SELECT id,
         ROW_NUMBER() OVER (
           ORDER BY ts_rank_cd(content_tsv,
                    websearch_to_tsquery('english', $1)) DESC
         ) AS rank
  FROM chunks
  WHERE content_tsv @@ websearch_to_tsquery('english', $1)
    AND ($3::uuid IS NULL OR tenant_id = $3)
    AND ($4::uuid IS NULL OR $4 = ANY(user_ids))
  ORDER BY ts_rank_cd(content_tsv, websearch_to_tsquery('english', $1)) DESC
  LIMIT 50
),
semantic AS (
  SELECT id,
         ROW_NUMBER() OVER (
           ORDER BY embedding <=> $2::vector
         ) AS rank
  FROM chunks
  WHERE ($3::uuid IS NULL OR tenant_id = $3)
    AND ($4::uuid IS NULL OR $4 = ANY(user_ids))
  ORDER BY embedding <=> $2::vector
  LIMIT 50
),
fused AS (
  SELECT id, SUM(1.0 / (60.0 + rank)) AS rrf_score
  FROM (
    SELECT id, rank FROM lexical
    UNION ALL
    SELECT id, rank FROM semantic
  ) combined
  GROUP BY id
)
SELECT c.id, c.document_id, c.title, c.content, c.source_url,
       f.rrf_score
FROM fused f
JOIN chunks c USING (id)
ORDER BY f.rrf_score DESC
LIMIT 20;
```

Source: [benmoataz.com/posts/hybrid-search-pgvector-bm25](https://www.benmoataz.com/posts/hybrid-search-pgvector-bm25),
[wolf-tech.io/blog/hybrid-search-with-pgvector-and-bm25](https://wolf-tech.io/blog/hybrid-search-with-pgvector-and-bm25-better-answers-without-elasticsearch)

### Why ts_rank_cd Is Good Enough for RRF

PostgreSQL's native `ts_rank_cd` is **not** BM25. It scores by term frequency
and cover density (proximity of matched terms), but does not use corpus-wide
IDF statistics. However, for the lexical arm of a hybrid+RRF system, this
limitation is smaller than it appears:

- The `@@` operator decides which documents match — identical regardless of
  ranking function
- RRF throws away raw scores entirely; it only reads rank position
- The ranking function only affects the order of the top ~50 lexical candidates,
  which are then re-ordered by fusion

**When the gap matters:**
1. Score-based (weighted) fusion rather than RRF
2. Lexical-dominant corpora with very long documents
3. You are migrating from Elasticsearch and users will compare top-10 results

**When to use pg_search (ParadeDB):**
ParadeDB's `pg_search` extension provides genuine BM25 scoring as a native
Postgres index type. Use it if the lexical arm is your measured bottleneck. Do
not add it on day one.

```sql
-- ParadeDB pg_search BM25 index
CREATE EXTENSION pg_search;

CREATE INDEX idx_chunks_bm25 ON chunks
USING bm25 (
  id,
  title::pdb.simple('stemmer=english'),
  content::pdb.simple('stemmer=english')
)
WITH (key_field=id);

-- Query with boosted title
SELECT id, title, pdb.score(id) AS bm25_score
FROM chunks
WHERE title   ||| 'postgresql authentication'::boost(2) OR
      content ||| 'postgresql authentication'
ORDER BY bm25_score DESC
LIMIT 50;
```

Source: [paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual)

### Node.js Integration

```typescript
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface HybridSearchParams {
  queryText: string;
  queryEmbedding: number[];
  tenantId?: string;
  userId?: string;
  limit?: number;
  efSearch?: number;
}

interface ChunkResult {
  id: bigint;
  documentId: bigint;
  title: string | null;
  content: string;
  sourceUrl: string;
  rrfScore: number;
}

async function hybridSearch(params: HybridSearchParams): Promise<ChunkResult[]> {
  const client = await pool.connect();
  try {
    // Tune ef_search for this session if needed
    if (params.efSearch && params.efSearch !== 40) {
      await client.query(`SET hnsw.ef_search = ${params.efSearch}`);
    }

    const result = await client.query<ChunkResult>(
      HYBRID_SEARCH_SQL,
      [
        params.queryText,
        `[${params.queryEmbedding.join(',')}]`,
        params.tenantId ?? null,
        params.userId ?? null,
      ]
    );

    return result.rows;
  } finally {
    client.release();
  }
}
```

**Critical operational note:** Always call the embedding API *before* acquiring
a database connection. Embedding calls take 50–200ms; holding a Postgres
connection that entire time adds connection pressure at scale. Compute the
vector first, then run the SQL.

### HNSW Filtered Search Gotcha

HNSW performs filtering *after* the graph walk by default. A restrictive
`tenant_id` filter may cause fewer than `k` rows to be returned because many
candidates are filtered out post-scan. Mitigation options:

1. Enable iterative HNSW scans (pgvector >= 0.7.0):
   ```sql
   SET hnsw.iterative_scan = relaxed_order; -- or strict_order
   ```
2. Create a partial index per tenant for very large multi-tenant corpora:
   ```sql
   CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops)
     WHERE tenant_id = 'acme-corp-uuid';
   ```
3. Raise `hnsw.ef_search` to improve the candidate pool size before filtering.

---

## 8. Qdrant: Dense + Sparse Hybrid

### When to Choose Qdrant

Qdrant is the right backend if:
- You want a purpose-built vector database with best-in-class ANN performance
- Your corpus will exceed 10M chunks (Postgres HNSW struggles at this scale)
- You want server-side RRF and DBSF without writing fusion logic
- You want quantization (scalar, product, binary) to reduce memory

### Collection Setup for Hybrid Search

```typescript
import { QdrantClient, models } from '@qdrant/js-client-rest';

const client = new QdrantClient({ url: 'http://localhost:6333' });

await client.createCollection('knowledge_index', {
  vectors_config: {
    // Dense embedding vector
    dense: {
      size: 1024,       // match your embedding model output
      distance: 'Cosine',
      hnsw_config: {
        m: 32,
        ef_construct: 200,
        on_disk: false,
      }
    }
  },
  sparse_vectors_config: {
    // BM25 sparse vector with IDF modifier
    bm25: {
      modifier: 'idf',  // CRITICAL: gives rare terms more weight
    }
  },
  // Optional: scalar quantization for 4× memory reduction
  quantization_config: {
    scalar: {
      type: 'int8',
      quantile: 0.99,
      always_ram: true,
    }
  }
});

// Create payload indexes for filtering
await client.createPayloadIndex('knowledge_index', {
  field_name: 'tenant_id',
  field_schema: 'keyword',
});
await client.createPayloadIndex('knowledge_index', {
  field_name: 'user_ids',
  field_schema: 'keyword',
});
```

**CRITICAL — IDF modifier:** Without `modifier: 'idf'`, a common word like
"the" counts as much as a rare identifier like "PROD-SKU-7842X". Always set
this when using BM25 sparse vectors.

Source: [qdrant.tech/articles/hybrid-search](https://qdrant.tech/articles/hybrid-search/)

### Inserting Points with Both Vectors

```typescript
interface KnowledgeChunk {
  id: string;
  denseVector: number[];
  sparseVector: { indices: number[]; values: number[] };
  payload: {
    tenant_id: string;
    user_ids: string[];
    source_type: 'sharepoint' | 'confluence';
    source_url: string;
    title: string;
    content: string;
    chunk_index: number;
    modified_at: string;
  };
}

async function upsertChunks(chunks: KnowledgeChunk[]): Promise<void> {
  await client.upsert('knowledge_index', {
    wait: true,
    points: chunks.map(chunk => ({
      id: chunk.id,
      vector: {
        dense: chunk.denseVector,
        bm25: chunk.sparseVector,  // { indices: number[], values: number[] }
      },
      payload: chunk.payload,
    })),
  });
}
```

### The Hybrid Query

```typescript
async function hybridSearchQdrant(params: {
  queryText: string;
  denseEmbedding: number[];
  bm25SparseVector: { indices: number[]; values: number[] };
  tenantId: string;
  userId: string;
  limit?: number;
}) {
  const { queryText, denseEmbedding, bm25SparseVector, tenantId, userId, limit = 10 } = params;

  return client.query('knowledge_index', {
    prefetch: [
      {
        query: bm25SparseVector,  // sparse vector query
        using: 'bm25',
        limit: 100,               // oversample before fusion
        filter: {
          must: [
            { key: 'tenant_id', match: { value: tenantId } },
            { key: 'user_ids',  match: { value: userId } },
          ]
        }
      },
      {
        query: denseEmbedding,    // dense vector query
        using: 'dense',
        limit: 100,
        filter: {
          must: [
            { key: 'tenant_id', match: { value: tenantId } },
            { key: 'user_ids',  match: { value: userId } },
          ]
        }
      }
    ],
    query: { rrf: { k: 60 } },  // server-side RRF
    limit,
    with_payload: true,
  });
}
```

Source: [qdrant.tech/documentation/concepts/hybrid-queries](https://qdrant.tech/documentation/concepts/hybrid-queries/)

### Generating BM25 Sparse Vectors in Node.js

Qdrant's BM25 with `modifier: 'idf'` expects you to supply sparse vectors
where the indices are vocabulary token IDs and values are raw term frequencies.
The IDF weighting is applied server-side.

```typescript
import { BM25, tokenize } from 'bun-bm25s';

// At ingestion: build vocabulary and compute TF sparse vectors
class SparseVectorEncoder {
  private vocab: Map<string, number> = new Map();
  private nextId = 0;

  getOrCreateId(term: string): number {
    if (!this.vocab.has(term)) {
      this.vocab.set(term, this.nextId++);
    }
    return this.vocab.get(term)!;
  }

  encode(text: string): { indices: number[]; values: number[] } {
    const tokens = tokenize([text])[0];
    const tf = new Map<string, number>();

    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    const indices: number[] = [];
    const values: number[] = [];

    for (const [term, freq] of tf) {
      indices.push(this.getOrCreateId(term));
      values.push(freq);
    }

    // Sort by index for Qdrant
    const sorted = indices.map((idx, i) => [idx, values[i]] as [number, number])
      .sort(([a], [b]) => a - b);

    return {
      indices: sorted.map(([idx]) => idx),
      values: sorted.map(([, val]) => val),
    };
  }
}
```

**Alternative:** Use Qdrant's built-in Inference API or FastEmbed to generate
sparse vectors server-side, avoiding this manual vocabulary management.

### Qdrant vs PostgreSQL Decision

| Factor | Qdrant | PostgreSQL + pgvector |
|---|---|---|
| Corpus size | Optimal up to billions | Good up to ~50M chunks |
| Setup complexity | Medium (separate service) | Low (extension) |
| ACL enforcement | Via payload filters | Via SQL WHERE / RLS |
| ACID transactions | No | Yes |
| Quantization | Yes (scalar, PQ, binary) | No |
| Server-side RRF | Yes (v1.10+) | No (SQL CTE) |
| Operational overhead | Docker/K8s container | Existing Postgres |
| Phase 2 recommendation | If corpus >5M chunks | **Default starting point** |

---

## 9. SPLADE and BM42: Learned Sparse Vectors

### What SPLADE Is

SPLADE (Sparse Lexical and Expansion model) is a neural model that maps text
to sparse vectors in the BERT vocabulary space (30,522 dimensions for
`bert-base-uncased`). Unlike BM25, SPLADE:

1. **Learns to expand queries**: "automobile" might expand to include
   "car", "vehicle", "transport" with non-zero weights
2. **Context-aware weighting**: the token "bat" in a sports document vs.
   a wildlife document gets different weights
3. **Outperforms BM25** on most BEIR benchmarks (standard IR benchmark suite)

**Structural limitation:** SPLADE requires GPU inference at query time (BERT
forward pass). This makes it approximately 10–100× more expensive than BM25's
inverted index lookup.

Source: [digitalapplied.com](https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026)

### BM42: Qdrant's Learned Sparse Approach

BM42 is Qdrant's contribution: a model that keeps BM25's term matching
structure but reweights each term by context using a small attention model.
Unlike full SPLADE, BM42 does not add expansion terms — it only reweights
existing terms. This makes it faster than SPLADE while closing some of the
quality gap with BM25.

### miniCOIL: Lightweight Context-Aware Sparse

miniCOIL (mentioned in Qdrant's docs) extends BM25 by adding context-aware
reweighting without full query expansion. The "bat" disambiguation example:

```
BM25:      "bat" → weight 2.1 (same in both documents)
miniCOIL:  "bat" (sports context) → weight 3.4
           "bat" (wildlife context) → weight 0.8
```

Source: [qdrant.tech/articles/hybrid-search](https://qdrant.tech/articles/hybrid-search/)

### Self-Hosted SPLADE Options

| Option | Memory | GPU Required | Query Latency | Notes |
|---|---|---|---|---|
| SPLADE++ (HuggingFace) | ~500MB model | Yes | 50–200ms | Best quality |
| Qdrant FastEmbed SPLADE | ~150MB | No (CPU) | 5–20ms | Quantised, production-ready |
| miniCOIL (Qdrant) | ~80MB | No | 2–5ms | Limited expansion |
| BM25 (classic) | 0MB model | No | <1ms | No expansion |

**Recommendation for Phase 2:** Start with classic BM25 (zero model overhead,
CPU-only). Add SPLADE only if BM25 is measured as the retrieval bottleneck on
your specific query distribution. SPLADE's benefit is largest on natural-
language corpora with synonym-rich queries; for enterprise document search with
identifier-heavy queries, BM25 often performs comparably.

### Using FastEmbed for Sparse Vectors in Node.js

Qdrant's FastEmbed library runs ONNX models locally. A TypeScript/Node.js
integration requires either the Python FastEmbed sidecar via HTTP, or the
`@xenova/transformers` library for ONNX inference:

```typescript
import { pipeline } from '@xenova/transformers';

// Load SPLADE model (downloads ~150MB on first run)
const sparseEncoder = await pipeline(
  'feature-extraction',
  'naver/splade-cocondenser-selfdistil'
);

async function encodeSparse(text: string): Promise<{ indices: number[]; values: number[] }> {
  const output = await sparseEncoder(text, {
    pooling: 'none',
    normalize: false,
  });

  // SPLADE output is a dense logit vector; apply ReLU + log1p
  const logits = Array.from(output.data as Float32Array);
  const sparse: [number, number][] = [];

  for (let i = 0; i < logits.length; i++) {
    const val = Math.log1p(Math.max(0, logits[i])); // ReLU + log1p
    if (val > 0.01) {  // threshold to keep vector sparse
      sparse.push([i, val]);
    }
  }

  sparse.sort(([a], [b]) => a - b);
  return {
    indices: sparse.map(([idx]) => idx),
    values: sparse.map(([, val]) => val),
  };
}
```

**Gotcha:** SPLADE vectors are dense BERT vocabulary space (30,522 dims). Most
non-zero values cluster around 50–200 active dimensions per document after the
threshold. The threshold `> 0.01` is tunable; lower values improve recall but
increase index size.

---

## 10. SQLite: FTS5 + sqlite-vec Lightweight Hybrid

### Use Case for Phase 2

SQLite + FTS5 + sqlite-vec is the right choice for:
- Local dev / CI environment (zero infrastructure, single file)
- MCP server "lite mode" running on a developer's machine without a Postgres server
- Small corpora (<100k chunks) where operational simplicity beats performance

### SQLite FTS5 Overview

FTS5 (Full Text Search 5) is SQLite's built-in full-text search module. It
ships as part of SQLite >= 3.9.0 (2015) and is enabled by default in most
distributions.

Source: [sqlite.org/fts5.html](https://www.sqlite.org/fts5.html)

**Key features:**
- Built-in `bm25()` auxiliary function (real BM25, not ts_rank approximation)
- Unicode61 tokenizer with stemming via Porter tokenizer
- Trigram tokenizer for substring and regex search
- NEAR queries, phrase queries, boolean operators
- FTS5 `rank` column auto-ordering by relevance

```sql
-- Create FTS5 table
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  title,
  content,
  content='chunks',          -- external content table (avoids duplication)
  content_rowid='id',
  tokenize='porter unicode61' -- stemming enabled
);

-- Query with BM25 ranking (built-in)
SELECT rowid, bm25(chunks_fts) AS score, snippet(chunks_fts, 1, '<b>', '</b>', '...', 64)
FROM chunks_fts
WHERE chunks_fts MATCH 'authentication OR oauth'
ORDER BY rank                  -- ORDER BY rank uses bm25() automatically
LIMIT 50;
```

**BM25 parameters in FTS5:**

The `bm25()` function accepts column weights as arguments:
```sql
-- Weight title matches 3×, content 1×
SELECT rowid, bm25(chunks_fts, 3.0, 1.0) AS score
FROM chunks_fts WHERE chunks_fts MATCH 'authentication'
ORDER BY bm25(chunks_fts, 3.0, 1.0);
```

FTS5's built-in BM25 uses fixed `k1 = 1.2` and `b = 0.75` — not configurable
in the SQL API. For customisable BM25 parameters in SQLite you need an external
implementation (wink-bm25 writing to a separate score column, or a custom FTS5
auxiliary function in C).

### sqlite-vec: Vector Extension

sqlite-vec (`asg017/sqlite-vec`) is a SQLite extension for storing and
searching float vectors. It is the lightweight successor to `sqlite-vss`.

```bash
# Install via npm
npm install sqlite-vec
```

```typescript
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const db = new Database('./knowledge.db');
sqliteVec.load(db);

// Check extension loaded
const { vec_version } = db.prepare('SELECT vec_version()').get() as { vec_version: string };
console.log(`sqlite-vec version: ${vec_version}`);

// Create vector table
db.exec(`
  CREATE VIRTUAL TABLE chunks_vec USING vec0(
    chunk_id INTEGER PRIMARY KEY,
    embedding FLOAT[1024]     -- dimension must match your model
  );
`);

// Insert
const insertVec = db.prepare(
  `INSERT INTO chunks_vec(chunk_id, embedding) VALUES (?, ?)`
);
insertVec.run(chunkId, new Float32Array(embedding));

// KNN search
const results = db.prepare(`
  SELECT chunk_id, distance
  FROM chunks_vec
  WHERE embedding MATCH ?
    AND k = 20              -- return top 20
  ORDER BY distance
`).all(new Float32Array(queryEmbedding));
```

### Hybrid Search: FTS5 + sqlite-vec Combined

```typescript
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

class SQLiteHybridSearch {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        tenant_id   TEXT NOT NULL,
        title       TEXT,
        content     TEXT NOT NULL,
        source_url  TEXT NOT NULL,
        modified_at TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        title,
        content,
        content='chunks',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[1024]
      );
    `);
  }

  search(params: {
    queryText: string;
    queryEmbedding: number[];
    tenantId: string;
    limit?: number;
    rrfK?: number;
  }): Array<{ id: number; rrfScore: number; title: string | null; content: string }> {
    const { queryText, queryEmbedding, tenantId, limit = 10, rrfK = 60 } = params;

    // BM25 retrieval
    const bm25Results = this.db.prepare(`
      SELECT f.rowid AS id, ROW_NUMBER() OVER (ORDER BY bm25(f)) AS rank
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.rowid
      WHERE f MATCH ?
        AND c.tenant_id = ?
      ORDER BY bm25(f)
      LIMIT 50
    `).all(queryText, tenantId) as Array<{ id: number; rank: number }>;

    // Vector retrieval
    const vecResults = this.db.prepare(`
      SELECT v.chunk_id AS id,
             ROW_NUMBER() OVER (ORDER BY v.distance) AS rank
      FROM chunks_vec v
      JOIN chunks c ON c.id = v.chunk_id
      WHERE v.embedding MATCH ?
        AND v.k = 50
        AND c.tenant_id = ?
      ORDER BY v.distance
    `).all(new Float32Array(queryEmbedding), tenantId) as Array<{ id: number; rank: number }>;

    // RRF fusion in TypeScript (SQLite lacks window functions in subqueries easily)
    const scores = new Map<number, number>();

    for (const { id, rank } of bm25Results) {
      scores.set(id, (scores.get(id) ?? 0) + 1.0 / (rrfK + rank));
    }
    for (const { id, rank } of vecResults) {
      scores.set(id, (scores.get(id) ?? 0) + 1.0 / (rrfK + rank));
    }

    const sortedIds = Array.from(scores.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([id]) => id);

    if (sortedIds.length === 0) return [];

    // Fetch chunks
    const placeholders = sortedIds.map(() => '?').join(',');
    const chunks = this.db.prepare(`
      SELECT id, title, content
      FROM chunks
      WHERE id IN (${placeholders})
    `).all(...sortedIds) as Array<{ id: number; title: string | null; content: string }>;

    const chunkMap = new Map(chunks.map(c => [c.id, c]));

    return sortedIds.map(id => ({
      id,
      rrfScore: scores.get(id)!,
      title: chunkMap.get(id)?.title ?? null,
      content: chunkMap.get(id)?.content ?? '',
    }));
  }
}
```

### SQLite Limitations for Phase 2

| Limitation | Impact |
|---|---|
| No concurrent writers | Single-process only; fine for MCP sidecar |
| sqlite-vec uses flat scan | No HNSW; full scan O(n) at query time |
| FTS5 BM25 k₁/b not configurable | Fixed at 1.2/0.75; fine for most uses |
| WAL mode required for concurrent reads | Minor config; always enable |
| No row-level security | Tenant filtering is application-level |
| sqlite-vec index size grows linearly | ~8KB per 1024-dim vector; 100k chunks ≈ 800MB |

**Verdict for Phase 2:** Use SQLite as the dev/lite mode backend only. At any
meaningful enterprise scale (>10k chunks) or multi-user concurrency, switch to
PostgreSQL or Qdrant.

---

## 11. Chunking Strategies

### Why Chunking Matters

The chunking decision affects retrieval recall directly: a chunk that splits a
relevant passage across two boundaries will score lower than one that keeps it
intact. Over-large chunks dilute the embedding signal; over-small chunks lose
context.

### Strategy Comparison

| Strategy | Chunk Size | Boundary | Recall (BEIR) | Notes |
|---|---|---|---|---|
| Fixed token | 256–512 tokens | Hard cut at N tokens | Baseline | Fast; loses sentence/paragraph structure |
| Sentence | 1–3 sentences | Sentence boundary | +2–4% vs fixed | Better for Q&A; loses paragraph context |
| Paragraph | 1 paragraph | `\n\n` boundary | +3–6% vs fixed | Good default for Confluence/SharePoint |
| Semantic | Variable | Cosine similarity breakpoint | +4–8% vs fixed | Computationally expensive at scale |
| Late chunking | Variable | Boundary detected after encoding | +5–10% vs fixed | Requires long-context model (Jina v3) |

Source: [digitalapplied.com](https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026),
[jina.ai/news/late-chunking](https://jina.ai/news/late-chunking-in-long-context-embedding-models/)

### Fixed-Size Chunking (512 Tokens)

```typescript
function chunkByTokens(
  text: string,
  maxTokens: number = 512,
  overlapTokens: number = 64
): string[] {
  // Approximate tokenisation: 1 token ≈ 4 chars for English
  const words = text.split(/\s+/);
  const tokensPerWord = 1.3; // rough estimate
  const wordsPerChunk = Math.floor(maxTokens / tokensPerWord);
  const overlapWords = Math.floor(overlapTokens / tokensPerWord);

  const chunks: string[] = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + wordsPerChunk, words.length);
    chunks.push(words.slice(start, end).join(' '));
    start = end - overlapWords;  // slide with overlap
    if (start >= words.length - overlapWords) break;
  }

  return chunks;
}
```

**When to use:** Processing pipelines where speed is critical; corpora with
uniform document structure.

**Overlap strategy:** 64-token (≈50-word) overlap between adjacent chunks
reduces the "lost context at boundaries" problem for 15–25% of recall-relevant
passages.

### Paragraph Chunking (Recommended Default for Phase 2)

```typescript
function chunkByParagraph(
  text: string,
  maxTokensPerChunk: number = 512,
  minTokensPerChunk: number = 50
): string[] {
  // Split on double newlines (Confluence/SharePoint paragraph boundaries)
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  const chunks: string[] = [];
  let currentChunk = '';
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = Math.ceil(para.length / 4); // rough token estimate

    if (currentTokens + paraTokens > maxTokensPerChunk && currentChunk) {
      if (currentTokens >= minTokensPerChunk) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = para;
      currentTokens = paraTokens;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
      currentTokens += paraTokens;
    }
  }

  if (currentChunk.trim() && currentTokens >= minTokensPerChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}
```

**Why paragraph is the right default for Phase 2:** SharePoint and Confluence
documents are structured by paragraphs. Paragraph boundaries are semantically
meaningful — they represent a coherent unit of thought. Fixed-size chunking
cuts across these natural boundaries.

### Semantic Chunking

Semantic chunking uses embedding similarity to detect topic shifts:

```typescript
async function chunkBySemantic(
  sentences: string[],
  embedFn: (texts: string[]) => Promise<number[][]>,
  breakpointThreshold: number = 0.3  // cosine distance; tune per corpus
): Promise<string[]> {
  if (sentences.length <= 1) return sentences;

  const embeddings = await embedFn(sentences);
  const chunks: string[] = [];
  let currentChunk = [sentences[0]];

  for (let i = 1; i < sentences.length; i++) {
    const prev = embeddings[i - 1];
    const curr = embeddings[i];
    const cosineDist = 1 - cosineSimilarity(prev, curr);

    if (cosineDist > breakpointThreshold) {
      // Topic shift detected
      chunks.push(currentChunk.join(' '));
      currentChunk = [sentences[i]];
    } else {
      currentChunk.push(sentences[i]);
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(' '));
  }

  return chunks;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

**Limitation:** Requires N embedding calls (N = sentences) per document at
ingestion time. For 1,000 documents with 50 sentences each, that is 50,000
embedding API calls. Use semantic chunking only if you have evaluated that it
improves retrieval over paragraph chunking on your specific corpus.

### Choosing Chunk Size

| Use Case | Recommended Size | Overlap |
|---|---|---|
| Q&A (short answers expected) | 128–256 tokens | 32 tokens |
| Summarisation / long answers | 512–1024 tokens | 64–128 tokens |
| Code search | Function/method-level | None |
| Confluence / SharePoint pages | Paragraph (≈200–600 tokens) | Adjacent paragraph context |
| Meeting transcripts | Paragraph/turn | Speaker turns as boundary |

---

## 12. Late Chunking (Jina v3)

### The Lost Context Problem

Standard chunking splits a document before embedding. Anaphoric references
("it", "the city", "this method") lose their referent when the chunk does not
contain the original noun.

Example from Jina's research (source: [jina.ai/news/late-chunking](https://jina.ai/news/late-chunking-in-long-context-embedding-models/)):

```
Document: "Berlin is the capital of Germany. Its population exceeds 3.85M."
Chunk 2: "Its population exceeds 3.85M."

Naive chunking similarity:
  query "Berlin population" vs chunk 2 = 0.708 (low — "Berlin" not present)

Late chunking similarity:
  query "Berlin population" vs chunk 2 = 0.825 (+17% — "Berlin" context encoded)
```

### How Late Chunking Works

```
Naive approach:
  [Chunk1] → Encoder → embed1
  [Chunk2] → Encoder → embed2   (no context from Chunk1)

Late chunking:
  [Full document] → Transformer → [token_embed_1, token_embed_2, ..., token_embed_N]
                                                      ↓
                         Mean-pool each chunk's token embeddings
                         embed_chunk1 = mean(token_1..token_k)
                         embed_chunk2 = mean(token_{k+1}..token_m)  ← contains context from token_1..token_k
```

Late chunking runs the full transformer forward pass on the entire document
(up to the model's context window), then pools the token-level embeddings per
chunk. Each chunk embedding is conditioned on the full preceding context.

### Requirements

- Requires a long-context embedding model (Jina jina-embeddings-v3 supports
  8,192 tokens)
- Documents must fit within the model's context window (8K tokens ≈ 6K words)
- For documents > 8K tokens: apply late chunking per sliding window of 8K

### Implementation Sketch

```typescript
import { pipeline, mean_pooling } from '@xenova/transformers';

// jina-embeddings-v3 or another long-context model
const encoder = await pipeline('feature-extraction', 'jinaai/jina-embeddings-v3');

async function lateChunk(
  text: string,
  chunkBoundaries: number[]  // character offsets where chunks begin
): Promise<number[][]> {
  // 1. Tokenize full document
  const tokenized = await encoder.tokenizer(text, {
    return_offsets_mapping: true,
    max_length: 8192,
    truncation: true,
  });

  // 2. Full transformer forward pass
  const output = await encoder.model(tokenized);
  const tokenEmbeddings = output.last_hidden_state; // [1, seq_len, hidden_dim]

  // 3. Map character boundaries to token boundaries
  const offsets = tokenized.offset_mapping[0]; // [[start, end], ...]
  const chunkTokenBoundaries = chunkBoundaries.map(charOffset =>
    offsets.findIndex(([, end]: [number, number]) => end >= charOffset)
  );

  // 4. Mean-pool per chunk
  const chunkEmbeddings: number[][] = [];
  let prevBoundary = 0;

  for (const boundary of chunkTokenBoundaries) {
    const chunkTokens = tokenEmbeddings[0].slice(prevBoundary, boundary);
    const meanEmbed = chunkTokens.reduce(
      (acc: number[], tok: number[]) => acc.map((v, i) => v + tok[i] / chunkTokens.length),
      new Array(chunkTokens[0].length).fill(0)
    );
    chunkEmbeddings.push(meanEmbed);
    prevBoundary = boundary;
  }

  return chunkEmbeddings;
}
```

### Late Chunking: When to Use It

| Scenario | Use Late Chunking | Reason |
|---|---|---|
| Documents with heavy anaphora (reports, articles) | Yes | Context preservation improves recall |
| Short documents (<256 tokens) | No | No benefit; single embedding suffices |
| Code files | No | Code rarely has anaphoric structure |
| Very long documents (>8K tokens) | Partial | Only within each 8K window |
| Large-scale ingestion (>1M docs) | Only if measured benefit | 2–3× more compute vs naive chunking |

**Phase 2 recommendation:** Implement paragraph chunking as the default.
Offer late chunking as an opt-in indexing mode (per connector or per document
type). The performance benefit is real but the compute cost requires
justification.

---

## 13. Complete TypeScript Reference Implementation

This is the full hybrid search implementation suitable for Phase 2, targeting
PostgreSQL as the primary backend with a fallback to SQLite for local dev.

### Core Interfaces

```typescript
// src/search/types.ts

export interface SearchDocument {
  id: string;
  documentId: string;
  chunkIndex: number;
  title: string | null;
  content: string;
  sourceUrl: string;
  sourceType: 'sharepoint' | 'confluence';
  tenantId: string;
  modifiedAt: Date | null;
}

export interface SearchResult extends SearchDocument {
  rrfScore: number;
  lexicalScore?: number;   // debug: ts_rank_cd score
  vectorScore?: number;    // debug: cosine similarity
}

export interface HybridSearchOptions {
  queryText: string;
  queryEmbedding: number[];
  tenantId: string;
  userId: string;             // for ACL check via transitiveMemberOf
  limit?: number;             // default: 10
  lexicalCandidates?: number; // default: 50 — per retriever prefetch
  semanticCandidates?: number;// default: 50
  rrfK?: number;              // default: 60
  efSearch?: number;          // default: 64 — HNSW ef_search
}

export interface EmbedFn {
  (text: string): Promise<number[]>;
  (texts: string[]): Promise<number[][]>;
}
```

### Embedding Service

```typescript
// src/search/embed.ts
import Anthropic from '@anthropic-ai/sdk';

export async function embedText(text: string): Promise<number[]> {
  // Use your chosen embedding provider.
  // OpenAI text-embedding-3-small (1536 dims) or
  // Cohere embed-english-v3 (1024 dims) or
  // self-hosted sentence-transformers via local HTTP
  const client = new OpenAI();
  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  // Batch up to 2048 inputs per request (OpenAI limit)
  const BATCH_SIZE = 100;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const client = new OpenAI();
    const response = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: batch,
    });
    results.push(...response.data.map(d => d.embedding));
  }

  return results;
}
```

### PostgreSQL Hybrid Search Service

```typescript
// src/search/postgres-hybrid.ts
import { Pool, PoolClient } from 'pg';
import type { HybridSearchOptions, SearchResult } from './types.js';

const HYBRID_SEARCH_SQL = `
WITH lexical AS (
  SELECT id,
         ROW_NUMBER() OVER (
           ORDER BY ts_rank_cd(content_tsv, websearch_to_tsquery('english', $1)) DESC
         ) AS rnk
  FROM chunks
  WHERE content_tsv @@ websearch_to_tsquery('english', $1)
    AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
    AND ($4::uuid IS NULL OR $4::uuid = ANY(user_ids))
  ORDER BY ts_rank_cd(content_tsv, websearch_to_tsquery('english', $1)) DESC
  LIMIT $5
),
semantic AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $2::vector) AS rnk
  FROM chunks
  WHERE ($3::uuid IS NULL OR tenant_id = $3::uuid)
    AND ($4::uuid IS NULL OR $4::uuid = ANY(user_ids))
  ORDER BY embedding <=> $2::vector
  LIMIT $6
),
fused AS (
  SELECT id, SUM(1.0 / ($7::float + rnk)) AS rrf_score
  FROM (SELECT id, rnk FROM lexical UNION ALL SELECT id, rnk FROM semantic) c
  GROUP BY id
)
SELECT
  ch.id::text,
  ch.document_id::text       AS "documentId",
  ch.chunk_index             AS "chunkIndex",
  ch.title,
  ch.content,
  ch.source_url              AS "sourceUrl",
  ch.source_type             AS "sourceType",
  ch.tenant_id::text         AS "tenantId",
  ch.modified_at             AS "modifiedAt",
  f.rrf_score                AS "rrfScore"
FROM fused f
JOIN chunks ch USING (id)
ORDER BY f.rrf_score DESC
LIMIT $8
`;

export class PostgresHybridSearch {
  constructor(private pool: Pool) {}

  async search(opts: HybridSearchOptions): Promise<SearchResult[]> {
    const {
      queryText,
      queryEmbedding,
      tenantId,
      userId,
      limit            = 10,
      lexicalCandidates = 50,
      semanticCandidates = 50,
      rrfK             = 60,
      efSearch         = 64,
    } = opts;

    const client = await this.pool.connect();
    try {
      if (efSearch !== 40) {
        await client.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);
      }

      const vectorLiteral = `[${queryEmbedding.join(',')}]`;

      const result = await client.query<SearchResult>(HYBRID_SEARCH_SQL, [
        queryText,
        vectorLiteral,
        tenantId ?? null,
        userId ?? null,
        lexicalCandidates,
        semanticCandidates,
        rrfK,
        limit,
      ]);

      return result.rows;
    } finally {
      client.release();
    }
  }
}
```

### Index Maintenance: Keeping Both Sides Fresh

The embedding column is the silent staleness risk. A generated `content_tsv`
column auto-updates on every write; an `embedding` column does not.

```typescript
// src/search/ingestion.ts

export async function ingestChunk(params: {
  pool: Pool;
  documentId: string;
  chunkIndex: number;
  title: string | null;
  content: string;
  sourceUrl: string;
  sourceType: 'sharepoint' | 'confluence';
  tenantId: string;
  userIds: string[];
}) {
  // 1. Compute embedding BEFORE acquiring DB connection
  const embedding = await embedText(
    [params.title, params.content].filter(Boolean).join('\n')
  );

  // 2. Upsert with fresh embedding
  const client = await params.pool.connect();
  try {
    await client.query(
      `INSERT INTO chunks
         (document_id, chunk_index, title, content, source_url, source_type,
          tenant_id, user_ids, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (document_id, chunk_index)
       DO UPDATE SET
         title      = EXCLUDED.title,
         content    = EXCLUDED.content,
         source_url = EXCLUDED.source_url,
         tenant_id  = EXCLUDED.tenant_id,
         user_ids   = EXCLUDED.user_ids,
         embedding  = EXCLUDED.embedding,
         indexed_at = NOW()`,
      [
        params.documentId,
        params.chunkIndex,
        params.title,
        params.content,
        params.sourceUrl,
        params.sourceType,
        params.tenantId,
        params.userIds,
        `[${embedding.join(',')}]`,
      ]
    );
  } finally {
    client.release();
  }
}

// Detect and reindex stale embeddings (run as background job)
export async function reindexStaleChunks(pool: Pool): Promise<number> {
  const stale = await pool.query<{ id: bigint; content: string; title: string | null }>(
    `SELECT id, title, content FROM chunks
     WHERE embedding IS NULL
        OR indexed_at < modified_at  -- content changed since embedding
     LIMIT 100`
  );

  for (const row of stale.rows) {
    const text = [row.title, row.content].filter(Boolean).join('\n');
    const embedding = await embedText(text);
    await pool.query(
      `UPDATE chunks SET embedding = $1, indexed_at = NOW() WHERE id = $2`,
      [`[${embedding.join(',')}]`, row.id]
    );
  }

  return stale.rows.length;
}
```

### MCP Tool Integration

```typescript
// src/tools/search-knowledge.ts
import { z } from 'zod';

export const searchKnowledgeSchema = z.object({
  query: z.string().describe('Natural language search query'),
  tenant_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export async function searchKnowledge(
  input: z.infer<typeof searchKnowledgeSchema>,
  ctx: { search: PostgresHybridSearch; userId: string }
): Promise<string> {
  const embedding = await embedText(input.query);

  const results = await ctx.search.search({
    queryText: input.query,
    queryEmbedding: embedding,
    tenantId: input.tenant_id ?? '',
    userId: ctx.userId,
    limit: input.limit,
  });

  if (results.length === 0) {
    return 'No results found for the given query.';
  }

  return results.map((r, i) => `
## Result ${i + 1}: ${r.title ?? 'Untitled'} (score: ${r.rrfScore.toFixed(4)})
Source: ${r.sourceUrl}
Modified: ${r.modifiedAt?.toISOString() ?? 'unknown'}

${r.content}
`.trim()).join('\n\n---\n\n');
}
```

---

## 14. Failure Modes and Gotchas

### BM25 Failure Modes

| Failure | Cause | Mitigation |
|---|---|---|
| Synonym misses ("car" vs "automobile") | BM25 is lexical only | Hybrid: vector arm covers synonyms |
| Common word dominance | IDF not applied (ts_rank) or misconfigured | Use pg_search/ParadeDB for true BM25 IDF |
| OOV identifiers not in index | Rare term df=0; IDF undefined | Robertson IDF clamps to avoid divide-by-zero |
| Score sign issues | Robertson IDF can be negative for very common terms | Use BM25+ or clamped IDF |
| Stale inverted index | FTS5 content table not synced | Use generated column or triggers |

### Vector Search Failure Modes

| Failure | Cause | Mitigation |
|---|---|---|
| Exact identifier not retrieved | Embedding model compresses away exact strings | Hybrid: BM25 arm covers identifiers |
| Wrong-confidence hallucination | High cosine similarity to wrong document | Trust RRF order; add cross-encoder reranker |
| Stale embeddings | Content updated, embedding not recomputed | Track `indexed_at < modified_at`; background reindex job |
| HNSW returns < k results with filters | Post-scan filtering removes candidates | Enable iterative scan or raise `ef_search` |
| Embedding dimension mismatch | Model changed, old vectors still in index | Migration: add `embedding_model` column, filter on it |
| Negative dot products | Non-normalised embeddings with IP metric | Use cosine unless model docs say otherwise |

### RRF Failure Modes

| Failure | Cause | Mitigation |
|---|---|---|
| Relevant doc not in either top-N | Both retrievers miss it at depth N | Raise per-retriever candidate limit (50 → 100) |
| Wrong k value (k=2 vs k=60) | Qdrant defaults k=2; Elasticsearch k=60 | Explicitly set k; never rely on implicit defaults |
| Score-based fusion with unnormalised scores | BM25 dominates due to scale | Use RRF instead of weighted sum; or normalise first |
| Weaviate default changed to relativeScoreFusion | v1.24 silent default change | Pin fusion algorithm explicitly in config |

### Chunking Failure Modes

| Failure | Cause | Mitigation |
|---|---|---|
| Answer spans two chunks | Hard-cut chunking at token limit | Add 64-token overlap between adjacent chunks |
| "Its", "the city" queries fail | Anaphora without referent in chunk | Late chunking or add document title/metadata to each chunk |
| Very short chunks (< 50 tokens) | Paragraph boundary produces micro-chunks | Set minimum chunk size; merge with adjacent chunk |
| Very long chunks (> 1K tokens) | Single paragraph is very long | Set maximum chunk size; split at sentence boundary if needed |

### ACL / Multi-Tenant Gotchas

| Failure | Cause | Mitigation |
|---|---|---|
| Documents returned for wrong tenant | Missing tenant filter in both retriever arms | Apply filter inside each CTE, not after fusion |
| `user_ids` array stale | Entra ID group membership changed | Re-call `transitiveMemberOf` on each login; cache with TTL |
| HNSW filtered search degrades | Filter runs post-scan, rejecting most candidates | Iterative HNSW scan or per-tenant partial indexes |
| Row-level security bypassed by embeddings | Direct vector query bypasses RLS | Apply RLS at the SQL view level, not just application |

### Embedding Staleness: The Silent Killer

This is the most common production failure in hybrid search systems. The
inverted index (FTS/BM25) auto-updates on content change; the embedding column
does not. This creates a condition where the lexical arm and semantic arm
diverge:

```
Day 1: Content = "OAuth 2.0 token refresh"  → embedding = [0.1, 0.8, ...]
Day 3: Content = "SAML 2.0 assertion flows"  → embedding = [0.1, 0.8, ...] ← STALE

Query "SAML assertion": BM25 finds doc (FTS updated), vector misses it
                         → partial retrieval; degraded relevance
```

**Fix:** Never have a write path that updates content without updating the
embedding. The safest implementation: NULL the embedding on content update and
use a background worker to recompute. A `NULL` embedding causes the vector arm
to skip the document entirely (explicit miss), which is better than a stale
embedding (wrong confident hit).

---

## 15. Decision Guide: What to Build for Phase 2

### Phase 2 Architecture Recommendation

```
                  ┌─────────────────────────────────────────────────┐
                  │           Phase 2 Knowledge Index                │
                  │                                                   │
  MCP Tool        │   ┌────────────┐    ┌───────────────────────┐   │
  search_knowledge│   │  Embedding │    │   Hybrid Search       │   │
  ────────────────┼──▶│  Service   │───▶│   (Postgres + pgvec)  │   │
                  │   │  (OpenAI / │    │                       │   │
                  │   │  local)    │    │ ┌─────────┐ ┌───────┐ │   │
                  │   └────────────┘    │ │  BM25   │ │ HNSW  │ │   │
                  │                     │ │ (FTS5 / │ │(vec.) │ │   │
                  │   ┌────────────┐    │ │pg_search│ │       │ │   │
                  │   │  Ingestion │    │ └────┬────┘ └───┬───┘ │   │
  Connectors      │   │  Pipeline  │    │      └──────┬───┘     │   │
  SharePoint ─────┼──▶│            │    │          RRF Fusion   │   │
  Confluence ─────┼──▶│ chunk →    │    │          (k=60)       │   │
                  │   │ embed →    │    └───────────────────────┘   │
                  │   │ upsert     │                                  │
                  │   └────────────┘    Entra ID ACL via             │
                  │                     transitiveMemberOf → user_ids│
                  └─────────────────────────────────────────────────┘
```

### What to Build (Ordered by Priority)

**P0 — Build this:**

1. **PostgreSQL + pgvector hybrid with native `tsvector`** — Start here. Ships
   with any Postgres. Generated `content_tsv` column handles lexical, pgvector
   HNSW handles semantic, RRF SQL CTE handles fusion. No extra dependencies.

2. **Paragraph chunking with 64-token overlap** — Better than fixed-token for
   SharePoint/Confluence. Implement as the default ingestion strategy.

3. **RRF with k=60** — The correct default. Do not tune until you have labeled
   eval queries showing it is wrong.

4. **Embedding staleness protection** — NULL the embedding column on content
   update; background worker recomputes. Non-negotiable correctness requirement.

5. **ACL filter in both retriever arms** — The tenant/user filter must appear
   in both the lexical CTE and semantic CTE. Not after fusion.

**P1 — Build if metrics show need:**

6. **pg_search (ParadeDB) for true BM25** — Add if retrieval quality
   evaluation shows the lexical arm is the bottleneck. Measure first.

7. **wink-bm25-text-search in-process index** — For the MCP server dev/lite
   mode where Postgres is not available. Fast cold start, JSON serialization.

8. **SQLite + FTS5 + sqlite-vec** — For fully offline, single-machine, zero-
   infrastructure scenarios. Use only for personal/developer mode.

**P2 — Evaluate but probably skip:**

9. **Qdrant** — Justified only if corpus exceeds ~5M chunks. Adds operational
   overhead. PostgreSQL scales well with proper HNSW tuning below that.

10. **SPLADE/FastEmbed sparse vectors** — GPU inference overhead not justified
    unless you measure BM25 is systematically missing vocabulary-rich queries
    in your specific enterprise corpus.

11. **Semantic chunking** — Expensive (N embedding calls per document).
    Measure vs paragraph chunking on a representative sample first.

12. **Late chunking** — Real benefit, real compute cost. Offer as an opt-in
    per connector/document-type setting.

13. **Cross-encoder reranking** — High leverage for final quality. Voyage
    `rerank-2.5` or Cohere `Rerank v3`. Evaluated a further +7.94% accuracy
    over Cohere by Voyage (vendor-stated). Add as a second stage after RRF
    fusion, operating on the top-20 fused candidates before passing to the LLM.

### Parameter Defaults Summary

| Parameter | Value | Source |
|---|---|---|
| RRF k | **60** | Elasticsearch/Cormack et al. 2009 |
| BM25 k₁ | **1.5** | Tuned up from Lucene 1.2 for enterprise docs |
| BM25 b | **0.75** | Standard default |
| HNSW M | **32** | pgvector recommendation for high recall |
| HNSW ef_construction | **200** | Higher quality build; one-time cost |
| HNSW ef_search | **64** | Balance of recall and latency |
| Per-retriever candidates | **50** | Pre-fusion depth; raise if recall insufficient |
| Chunk size (paragraph) | **200–600 tokens** | Natural paragraph boundaries |
| Chunk overlap | **64 tokens** | Boundary protection |
| Embedding dimension | **1024** | Cohere embed-english-v3; or 1536 for OpenAI |

---

*Sources consulted:*
- [qdrant.tech/documentation/concepts/hybrid-queries](https://qdrant.tech/documentation/concepts/hybrid-queries/) — Qdrant hybrid query API, RRF formula, DBSF, weighted RRF (v1.17)
- [elastic.co/guide/en/elasticsearch/reference/current/rrf.html](https://www.elastic.co/guide/en/elasticsearch/reference/current/rrf.html) — Elasticsearch RRF implementation, k=60 default, worked example
- [qdrant.tech/articles/hybrid-search](https://qdrant.tech/articles/hybrid-search/) — Dense vs sparse failure modes, miniCOIL, dataset benchmarks
- [paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual) — pg_search BM25, pgvector schema, RRF SQL
- [benmoataz.com/posts/hybrid-search-pgvector-bm25](https://www.benmoataz.com/posts/hybrid-search-pgvector-bm25) — Full SQL hybrid implementation, ts_rank_cd vs BM25, filter gotchas
- [wolf-tech.io/blog/hybrid-search-with-pgvector-and-bm25](https://wolf-tech.io/blog/hybrid-search-with-pgvector-and-bm25-better-answers-without-elasticsearch) — HNSW tuning, connection pressure patterns, FULL OUTER JOIN RRF
- [supermemory.ai/blog/hybrid-search-guide](https://supermemory.ai/blog/hybrid-search-guide/) — Recall@10 benchmarks (65/78/91%), production latency data
- [digitalapplied.com](https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026) — BM25 parameter reference, SPLADE dimensions, WANDS benchmarks, vendor comparison matrix
- [engineering.oakoliver.com/articles/bun-bm25s-beating-python-at-full-text-search](https://engineering.oakoliver.com/articles/bun-bm25s-beating-python-at-full-text-search) — bun-bm25s CSC matrix architecture, benchmark data (4.6M tokens/sec)
- [npmjs.com/package/wink-bm25-text-search](https://www.npmjs.com/package/wink-bm25-text-search) — wink-bm25 BM25F config, k1/b/k parameters, NLP pipeline
- [jina.ai/news/late-chunking](https://jina.ai/news/late-chunking-in-long-context-embedding-models/) — Late chunking algorithm, similarity benchmarks on Berlin example
- [sqlite.org/fts5.html](https://www.sqlite.org/fts5.html) — FTS5 bm25() function, tokenizers, query syntax
