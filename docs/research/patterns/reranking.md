# Reranking for Search Quality: Cross-Encoders, Cohere Rerank, ColBERT, and Production Implementation

**Research date:** 2026-08-26  
**Scope:** markdown-for-agents-mcp Phase 2 knowledge index + current web-search pipeline

---

## Table of Contents

1. [The Problem: Why First-Stage Retrieval Fails](#1-the-problem-why-first-stage-retrieval-fails)
2. [Architecture: Bi-Encoder vs Cross-Encoder](#2-architecture-bi-encoder-vs-cross-encoder)
3. [The Cascaded RAG Pipeline](#3-the-cascaded-rag-pipeline)
4. [Cross-Encoder Models: ms-marco Family](#4-cross-encoder-models-ms-marco-family)
5. [Open-Weight Reranker Leaderboard 2026](#5-open-weight-reranker-leaderboard-2026)
6. [Cohere Rerank API](#6-cohere-rerank-api)
7. [ColBERT and Late Interaction](#7-colbert-and-late-interaction)
8. [FlashRank: Lightweight Local Reranking](#8-flashrank-lightweight-local-reranking)
9. [ONNX Deployment in Node.js](#9-onnx-deployment-in-nodejs)
10. [Latency Benchmarks and Budgets](#10-latency-benchmarks-and-budgets)
11. [BEIR Benchmark: What the Numbers Mean](#11-beir-benchmark-what-the-numbers-mean)
12. [Current RERANK_BACKEND: What We Have and Gaps](#12-current-rerank_backend-what-we-have-and-gaps)
13. [Phase 2 Recommendation: Vodacom-Scale Strategy](#13-phase-2-recommendation-vodacom-scale-strategy)
14. [Complete TypeScript Implementation Patterns](#14-complete-typescript-implementation-patterns)
15. [When Not to Rerank](#15-when-not-to-rerank)
16. [Failure Modes and Gotchas](#16-failure-modes-and-gotchas)

---

## 1. The Problem: Why First-Stage Retrieval Fails

### What bi-encoders do well

Bi-encoder (dense retrieval) models encode a query and each document independently into single vectors, then rank by cosine similarity. This is fast because document embeddings are precomputed and stored in a vector index — query time is just one forward pass plus approximate nearest-neighbour search.

Typical ANN search over 1M–100M embeddings returns 20–100 neighbours in 5–30 ms on a warmed index (FAISS, Pinecone, Weaviate). For semantically smooth queries against a consistent corpus, this is often good enough.

### Where bi-encoders break

Single-vector compression loses token-level nuance. Symptoms that indicate a reranking problem:

1. **Multi-aspect queries** — "What is the pricing and latency of Pinecone serverless?" requires two distinct signals in one embedding. A single vector cannot represent both equally.
2. **Rare keywords** — A model trained for semantic similarity may bury exact-match signal. BM25 overlap helps but the semantic vector still misses fine distinctions.
3. **Long documents** — A 2,000-token chunk averaged into one point collapses early-paragraph facts and late-paragraph facts together.
4. **Domain drift** — ms-marco-trained models see degraded performance on enterprise knowledge bases (SharePoint docs, Confluence pages, HR policies) that look nothing like MSMARCO search queries.

**Diagnostic signal:** Retrieval recall@10 below 0.75 on your eval set. Users report "the answer is there but the agent says it doesn't know." The correct document is rank 5–15 in retrieval but rank 1 after reranking.

Sources: [markaicode.com/colbert-plaid-late-interaction-retrieval-rag/](https://markaicode.com/colbert-plaid-late-interaction-retrieval-rag/), [n4n.ai/blog/how-much-latency-does-reranking-add-to-rag-pipelines/](https://n4n.ai/blog/how-much-latency-does-reranking-add-to-rag-pipelines/)

---

## 2. Architecture: Bi-Encoder vs Cross-Encoder

### Bi-encoder (first-stage retriever)

```
query  → [Encoder] → q_vec (768-dim)
doc_1  → [Encoder] → d_vec (768-dim)  ← precomputed, indexed
doc_2  → [Encoder] → d_vec (768-dim)
...
score = cosine(q_vec, d_vec)          ← cheap dot product
```

- **Inference at query time:** one forward pass for the query only.
- **Index precomputed:** document embeddings are stored; no re-inference per query.
- **Latency:** 5–30 ms for ANN search over millions of docs.
- **Quality ceiling:** single-vector representation loses interaction signal.

### Cross-encoder (reranker)

```
[CLS] query [SEP] document [SEP]  → [Transformer] → relevance score
```

The query and document are concatenated and passed together through a transformer. Full self-attention runs across all tokens in both. This allows the model to see exact phrase overlap, negation, co-reference, and multi-hop reasoning — things a bi-encoder cannot capture because it never sees the query and document together.

- **Inference at query time:** one forward pass *per query-document pair*. For 100 candidates, 100 forward passes.
- **No precomputed index:** documents cannot be embedded in advance.
- **Latency:** 10–800 ms depending on model size, batch size, and hardware.
- **Quality ceiling:** substantially higher than bi-encoder on all standard benchmarks.

### The comparison table

| Property | Bi-encoder | Cross-encoder | ColBERT (late interaction) |
|---|---|---|---|
| Document indexing | Precomputed | None | Per-token vectors |
| Query-time compute | 1 forward pass | N forward passes | MaxSim over token matrices |
| Latency (100 docs) | 5–30 ms | 50–800 ms | 50–120 ms CPU |
| Quality (BEIR avg nDCG@10) | ~65–72 | ~73–77 | ~70–75 |
| Index size (1M docs) | 3–4 GB | N/A | 4–6 GB |
| GPU required | No | No (small models) | No (PLAID CPU) |
| Multilingual support | Yes (multilingual models) | Yes (multilingual models) | Limited |

Sources: [sbert.net](https://www.sbert.net/docs/pretrained-models/ce-msmarco.html), [presenc.ai/research/best-open-weight-reranker-models-2026](https://presenc.ai/research/best-open-weight-reranker-models-2026)

---

## 3. The Cascaded RAG Pipeline

The standard production pattern is a two-stage (or three-stage) cascade:

```
User query
    │
    ▼
Stage 1: First-stage retrieval (bi-encoder + BM25 hybrid)
    • Retrieve top-100 candidates
    • Latency: ~15–30 ms
    │
    ▼
Stage 2: Cross-encoder reranker
    • Re-score top-100, keep top-10
    • Latency: ~50–200 ms
    │
    ▼
Stage 3: LLM generation
    • Feed top-10 chunks as context
    • Latency: ~1,000–5,000 ms
    │
    ▼
Answer
```

Total reranking overhead is usually 2–5× the vector search time. This is acceptable for chat-style assistants where LLM generation already dominates the response time.

The pipeline is documented at [neelmishra.github.io/blog/mlops/rag/reranking.html](https://neelmishra.github.io/blog/mlops/rag/reranking.html):

> "Query → 100 candidates → 10 reranked results → LLM context. This architecture is used by virtually every production search engine."

### The three-stage cascade (cost-optimised)

When you need both quality and cost control:

```
Stage 1: Dense + BM25 hybrid → top-200 candidates   (~25 ms)
Stage 2: Lightweight bi-encoder rerank → top-20      (~15 ms CPU)
Stage 3: Heavy cross-encoder → top-5                 (~20 ms on GPU)
Total rerank time: ~35 ms vs 200+ ms for skipping stage 2
```

Source: [n4n.ai/blog/how-much-latency-does-reranking-add-to-rag-pipelines/](https://n4n.ai/blog/how-much-latency-does-reranking-add-to-rag-pipelines/)

---

## 4. Cross-Encoder Models: ms-marco Family

All ms-marco cross-encoders are trained on the MS MARCO Passage Ranking dataset — ~500k real Bing search queries matched to relevant passages. They are the de facto standard for English information retrieval reranking.

Source: [huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2)

### Model performance table

| Model | NDCG@10 (TREC DL 19) | MRR@10 (MS Marco Dev) | Docs/sec (V100) | Size |
|---|---|---|---|---|
| `cross-encoder/ms-marco-TinyBERT-L2-v2` | 69.84 | 32.56 | 9,000 | ~4 MB |
| `cross-encoder/ms-marco-MiniLM-L2-v2` | 71.01 | 34.85 | 4,100 | ~15 MB |
| `cross-encoder/ms-marco-MiniLM-L4-v2` | 73.04 | 37.70 | 2,500 | ~18 MB |
| **`cross-encoder/ms-marco-MiniLM-L6-v2`** | **74.30** | **39.01** | **1,800** | **22 MB** |
| `cross-encoder/ms-marco-MiniLM-L12-v2` | 74.31 | 39.02 | 960 | 33 MB |

All models are Apache 2.0 licensed. The V100 throughput numbers are for the reranking step only (not including retrieval). On CPU: expect 10–20× slowdown.

**The inflection point is MiniLM-L6-v2.** It achieves essentially the same NDCG@10 as L12-v2 but at nearly 2× the throughput. Unless you are performance-tuning against a domain-specific corpus where the extra 2 layers help, L6-v2 is the standard recommendation.

### When to use TinyBERT-L2-v2

The 4 MB TinyBERT model runs at 9,000 docs/sec on a V100. For latency-critical use cases (voice, autocomplete) where you are reranking 10–20 candidates rather than 100, this model is sufficient and adds <5 ms per request on CPU.

### Domain drift warning

All ms-marco models are trained on web search queries. On enterprise corpora (SharePoint docs, Confluence pages, HR handbooks) they exhibit measurable domain drift. BEIR average nDCG@10 for MiniLM-L6-v2 is approximately 60–62, compared to 74 on TREC DL 19. If your Phase 2 knowledge index will be primarily enterprise documents, consider:

1. Fine-tuning on a small set of domain-specific query-passage pairs (100–500 annotated pairs is enough to close most of the gap).
2. Switching to BGE-Reranker-v2-M3 which was trained on a broader multilingual corpus including enterprise-like content.

---

## 5. Open-Weight Reranker Leaderboard 2026

Source: [presenc.ai/research/best-open-weight-reranker-models-2026](https://presenc.ai/research/best-open-weight-reranker-models-2026)

### Quality rankings (BEIR average nDCG@10, May 2026)

| Model | Parameters | BEIR Avg nDCG@10 | License |
|---|---|---|---|
| Qwen3-Reranker-8B | ~8B | ~77.0 | Tongyi Qianwen (commercial OK) |
| Qwen3-Reranker-4B | ~4B | ~75.2 | Tongyi Qianwen |
| BGE-Reranker-v2-Gemma | ~9B | ~73.7 | MIT |
| BGE-Reranker-v2-Minicpm-Layerwise | ~2.7B | ~73.2 | MIT |
| Qwen3-Reranker-0.6B | ~0.6B | ~71.4 | Tongyi Qianwen |
| **BGE-Reranker-v2-M3** | **~0.6B** | **~71.5** | **MIT** |
| Jina ColBERT v2 | ~0.5B | ~70.1 | CC-BY-NC + commercial |
| Jina Reranker v2 | ~0.3B | ~69.4 | CC-BY-NC + commercial |
| mxbai-rerank-large-v1 | ~0.4B | ~67.3 | Apache 2.0 |
| ms-marco-MiniLM-L-12-v2 | ~33M | ~60.1 | Apache 2.0 |
| RankZephyr | ~7B | ~69.4 | MIT |

### Latency profile (single L40S GPU, batch size 32, 512-token avg)

| Model | Latency per pair | Throughput (pairs/sec) |
|---|---|---|
| ms-marco-MiniLM-L-12-v2 | ~4 ms | ~250 |
| Jina Reranker v2 | ~6 ms | ~165 |
| mxbai-rerank-large-v1 | ~8 ms | ~125 |
| BGE-Reranker-v2-M3 (0.6B) | ~12 ms | ~83 |
| Jina ColBERT v2 | ~10 ms (late interaction) | ~100 |
| BGE-Reranker-v2-Gemma (9B) | ~42 ms | ~24 |
| Qwen3-Reranker-8B | ~38 ms | ~26 |

**For 100 candidates on a GPU:** BGE-Reranker-v2-M3 adds approximately 1,200 ms. MiniLM adds approximately 400 ms. For CPU-only deployments, multiply by 8–15×.

### Production deployment share (surveyed, Q1 2026)

| Choice | Share of production RAG systems |
|---|---|
| No reranker (single-stage) | ~36% |
| BGE-Reranker-v2 family | ~28% |
| Cohere Rerank 3 (API) | ~16% |
| Qwen3-Reranker family | ~12% |
| Jina Reranker / ColBERT | ~8% |
| ms-marco-MiniLM (legacy) | ~7% |
| Voyage AI rerank-2 | ~6% |

### Our current model: Xenova/bge-reranker-base

The default in `config.ts` is `Xenova/bge-reranker-base` — a transformers.js-compatible ONNX export of the 0.278B parameter BGE Reranker Base. This sits below BGE-Reranker-v2-M3 on BEIR but is a reasonable choice for the web-search use case because:

1. It runs in the existing `@huggingface/transformers` worker thread without additional dependencies.
2. 0.278B parameters means warmup is fast and RAM footprint is modest.
3. For web-search reranking (public content, English-heavy), the quality gap vs v2-M3 is small.

For Phase 2 (multilingual enterprise knowledge), upgrading to `Xenova/bge-reranker-v2-m3` is the right move.

---

## 6. Cohere Rerank API

Source: [docs.cohere.com/docs/rerank](https://docs.cohere.com/docs/rerank)

### Available models (August 2026)

| Model ID | Description | Context | Modality |
|---|---|---|---|
| `rerank-v4.0-pro` | Multilingual, state-of-the-art quality, complex use-cases | 4096 tokens/doc | Text |
| `rerank-v4.0-fast` | Light version of v4-pro, low latency, high throughput | 4096 tokens/doc | Text |
| `rerank-v3.5` | Multilingual, same languages as embed-multilingual-v3.0 | 4096 tokens/doc | Text |
| `rerank-english-v3.0` | English only, semi-structured JSON support | 4096 tokens/doc | Text |
| `rerank-multilingual-v3.0` | Non-English documents | 4096 tokens/doc | Text |

### API request schema

```
POST https://api.cohere.com/v2/rerank
Authorization: Bearer {COHERE_API_KEY}
Content-Type: application/json
```

**Request body:**

```typescript
interface CohereRerankRequest {
  model: string;              // required: e.g. "rerank-v3.5"
  query: string;              // required: the search query
  documents: string[];        // required: list of texts to rank (max 1,000)
  top_n?: number;             // optional: return only top N results
  max_tokens_per_doc?: number; // optional: truncation limit, default 4096
  // Note: max_chunks_per_doc was removed in v2 API — use max_tokens_per_doc
}
```

**Response body:**

```typescript
interface CohereRerankResponse {
  id: string;
  results: Array<{
    index: number;           // 0-based index into original documents array
    relevance_score: number; // 0.0–1.0, higher is more relevant
  }>;
  meta: {
    api_version: { version: string; is_experimental?: boolean };
    billed_units: { search_units: number };
  };
}
```

**Example request:**

```bash
curl https://api.cohere.com/v2/rerank \
  -H "Authorization: Bearer $COHERE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "rerank-v3.5",
    "query": "What is Vodacom'\''s data bundle pricing?",
    "documents": [
      "Vodacom offers monthly data bundles starting from R15 for 50MB...",
      "MTN prepaid data pricing for South Africa...",
      "Vodacom Smart data bundles allow rollover of unused data..."
    ],
    "top_n": 2
  }'
```

**Example response:**

```json
{
  "results": [
    { "index": 2, "relevance_score": 0.9991 },
    { "index": 0, "relevance_score": 0.8734 }
  ],
  "id": "07734bd2-2473-4f07-94e1-0d9f0e6843cf",
  "meta": {
    "api_version": { "version": "2" },
    "billed_units": { "search_units": 1 }
  }
}
```

Source: [docs.4allapi.com/en/rerank/cohere-rerank/](https://docs.4allapi.com/en/rerank/cohere-rerank/)

### Pricing (2026)

| Model | Price |
|---|---|
| Rerank v3 / v3.5 | ~$2 per 1M tokens |
| Rerank v4.0 Pro/Fast | See [cohere.com/pricing](https://cohere.com/pricing) |
| Free tier | 100 API calls/min, 1,000/month |

At $2/1M tokens, reranking 100 documents of 512 tokens each = 51,200 tokens = ~$0.10 per 1,000 queries. At Vodacom scale (say 100k queries/day), that is ~$10/day or ~$300/month. That is viable for a Phase 2 pilot but warrants a self-hosted fallback for steady-state production.

Source: [pecollective.com/tools/cohere-pricing/](https://pecollective.com/tools/cohere-pricing/)

### Document limits and gotchas

- **Max documents per request:** 1,000. For best performance the docs say "do not exceed 1,000."
- **Context per document:** 4,096 tokens (v3.5+). Long documents are automatically chunked internally.
- **The `max_chunks_per_doc` parameter was removed** in v2 API. Use `max_tokens_per_doc` instead.
- **Structured data:** Can be passed as YAML-formatted strings for semi-structured documents (product catalogs, JSON records).
- **Billing unit:** charged per "search unit" which corresponds to one rerank request regardless of document count, up to documented limits.
- **Multilingual:** v3.5 and v4.x support the same language set as embed-multilingual-v3.0. Test on your actual language pairs before committing.

### TypeScript implementation

```typescript
interface CohereRerankResult {
  index: number;
  relevance_score: number;
}

async function cohereRerank(
  query: string,
  documents: string[],
  topN: number = 10,
  model: string = 'rerank-v3.5'
): Promise<CohereRerankResult[]> {
  const response = await fetch('https://api.cohere.com/v2/rerank', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      query,
      documents,
      top_n: topN,
      max_tokens_per_doc: 2048, // cap to reduce cost
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Cohere Rerank ${response.status}: ${err}`);
  }

  const data = await response.json() as { results: CohereRerankResult[] };
  return data.results;
}

// Usage in RAG pipeline
async function rerankWithCohere<T extends { text: string }>(
  query: string,
  candidates: T[],
  topN: number = 10
): Promise<T[]> {
  const texts = candidates.map(c => c.text);
  const results = await cohereRerank(query, texts, topN);
  return results.map(r => candidates[r.index]!);
}
```

### When to use Cohere vs self-hosted

Use Cohere when:
- You need zero GPU infrastructure for early Phase 2 pilots.
- Multilingual support is critical and you cannot afford fine-tuning time.
- Query volume is moderate (<100k/day) and per-query cost is acceptable.

Use self-hosted when:
- Data residency requirements prohibit sending document content to a third-party API. At Vodacom, POPIA makes this a real consideration — any document text sent to Cohere leaves your perimeter.
- Volume exceeds ~1M queries/day (self-hosted economics break even at approximately 1M queries/day per the presenc.ai survey).
- You need consistent latency without API cold-start variance.

---

## 7. ColBERT and Late Interaction

### The core idea

ColBERT (Contextualized Late Interaction over BERT) is neither a pure bi-encoder nor a cross-encoder. It keeps the speed of bi-encoders while capturing more of the interaction quality.

**Bi-encoder:** one vector per document.  
**Cross-encoder:** run transformer jointly over query + doc at query time.  
**ColBERT:** precompute per-token vectors for each document. At query time, compute token-level MaxSim.

```
Score(Q, D) = Σ_{qi ∈ Q} max_{dj ∈ D} (qi · dj)
```

Each query token finds its single best-matching document token. Sum those maximums across all query tokens. This preserves token-level signal without the O(n²) cost of full self-attention over query+document.

Sources: [developer.ibm.com/articles/how-colbert-works/](https://developer.ibm.com/articles/how-colbert-works/), [markaicode.com/colbert-plaid-late-interaction-retrieval-rag/](https://markaicode.com/colbert-plaid-late-interaction-retrieval-rag/)

### PLAID: Making ColBERT production-ready

ColBERT's weakness before PLAID was index size. Storing 128-dimensional float32 vectors per token per passage: 1M passages × 64 avg tokens/passage × 128 dims × 4 bytes ≈ 32 GB. Unusable.

PLAID (Performance-optimized Late Interaction Driver) compresses this with:

1. **Centroid clustering** — token vectors are quantized to the nearest of ~64k centroids. Only centroid IDs + small residuals are stored.
2. **Candidate generation** — at query time, each query token finds its top-k centroids. Only passages containing those centroids enter the full MaxSim scoring.
3. **Two-stage filtering** — a fast approximate filter on quantized residuals runs before the exact MaxSim pass.

Result: a 1M-passage PLAID index lands around 4–6 GB. Sub-100ms p99 latency on CPU is achievable for corpora under 5M passages.

Source: [arxiv.org/abs/2205.09707](https://arxiv.org/abs/2205.09707) — "reduces late interaction search latency by 2.5–7× on GPU and 9–45× on CPU against vanilla ColBERTv2"

### ColBERT vs dense retrieval vs cross-encoder

| | ColBERT + PLAID | Dense Bi-Encoder | Cross-Encoder |
|---|---|---|---|
| Recall@10 (BEIR avg) | ~0.84 | ~0.73 | ~0.89 (with bi-encoder candidates) |
| Index size (1M passages) | 4–6 GB | 3–4 GB | N/A (no index) |
| Latency (CPU, 1M passages) | 50–120 ms | 5–20 ms | 200–800 ms per batch |
| GPU required | No | No | No (small models) |
| Best for | Keyword + semantic mix | Purely semantic queries | Re-ranking top-50 candidates |

### Running ColBERT locally with RAGatouille (Python)

```python
from ragatouille import RAGPretrainedModel

# colbert-ir/colbertv2.0 — 110M params, MIT license
rag = RAGPretrainedModel.from_pretrained("colbert-ir/colbertv2.0")

# Index your corpus (first time only)
rag.index(
    collection=documents,      # list[str]
    index_name="my-rag-index",
    max_document_length=512,   # tokens per passage
    split_documents=True,      # auto-chunks at sentence boundaries
)

# Query
results = rag.search(query="What does Vodacom charge for data?", k=10)
# Returns: [{"score": 23.4, "content": "...", ...}, ...]

# Load existing index in production
rag = RAGPretrainedModel.from_index(".ragatouille/colbert/indexes/my-rag-index")
```

### Should we build ColBERT into Phase 2?

**Verdict: Not yet.** ColBERT is excellent for single-stage retrieval where you want bi-encoder speed with near-cross-encoder quality. But it requires Python (RAGatouille/PyLate), a separate vector store understanding multi-vector storage (Qdrant 1.10+, Weaviate v1.27+), and the PLAID indexing infrastructure.

For Phase 2, the two-stage pipeline (dense retrieval → cross-encoder rerank) is simpler, well-tested, and already 80% of the way to ColBERT quality. Add ColBERT in Phase 3 if benchmarks on the actual Vodacom corpus show retrieval recall as the bottleneck.

Source: [fareedkhan-dev.github.io/rag-cookbook-2026/recipes/04-retrieval/colbert-late-interaction/](https://fareedkhan-dev.github.io/rag-cookbook-2026/recipes/04-retrieval/colbert-late-interaction/)

---

## 8. FlashRank: Lightweight Local Reranking

Source: [pypi.org/project/FlashRank/](https://pypi.org/project/FlashRank/)

FlashRank is a Python library for ultra-lightweight cross-encoder reranking. Its key claim: **no Torch or Transformers required**. It uses ONNX Runtime directly, which means a much smaller install footprint and faster cold starts on serverless.

### Supported models

| Model Name | Description | Size | Notes |
|---|---|---|---|
| `ms-marco-TinyBERT-L-2-v2` | Default (smallest model) | ~4 MB | Fastest |
| `ms-marco-MiniLM-L-12-v2` | Best cross-encoder quality | ~34 MB | Recommended |
| `rank-T5-flan` | Best zero-shot on out-of-domain | ~110 MB | No fine-tuning needed |
| `ms-marco-MultiBERT-L-12` | Multilingual, 100+ languages | ~150 MB | |
| `rank_zephyr_7b_v1_full` | LLM-based listwise reranker | ~4 GB | 4-bit GGUF |

### Key features

- No PyTorch dependency — pure ONNX Runtime inference on CPU.
- Models download on first use, cached locally.
- `max_length` tuning: if your average passage is 100 tokens, set `max_length=128`. Setting it to 512 for short passages adds unnecessary compute.

### Python usage

```python
from flashrank import Ranker, RerankRequest

# Default model (~4MB), blazing fast
ranker = Ranker(max_length=128)

# Or best quality model (~34MB)
ranker = Ranker(model_name="ms-marco-MiniLM-L-12-v2", cache_dir="/opt")

query = "How do I reset my Vodacom password?"
passages = [
    {"id": 1, "text": "To reset your password visit vodacom.co.za/reset...", "meta": {}},
    {"id": 2, "text": "Contact Vodacom support on 082 111...", "meta": {}},
    {"id": 3, "text": "Vodacom data bundles start from R15...", "meta": {}},
]

request = RerankRequest(query=query, passages=passages)
results = ranker.rerank(request)
# results sorted by score descending, each has 'id', 'text', 'meta', 'score'
```

### FlashRank for Node.js

FlashRank is Python-only. For Node.js, the equivalent is:

1. `@xenova/transformers` / `@huggingface/transformers` — what we already use in `rerankWorker.ts`.
2. `onnxruntime-node` directly with a downloaded ONNX model file.
3. `flashrank-js` — a community port: [github.com/zeeshan56656/flashrank-js](https://github.com/zeeshan56656/flashrank-js) — ONNX cross-encoder reranking for JavaScript/TypeScript, zero API costs.

FlashRank is primarily useful if you want to add a Python microservice as a reranking sidecar, or if you are prototyping in a notebook environment.

---

## 9. ONNX Deployment in Node.js

This section is directly relevant to our existing `rerankWorker.ts`.

### How it works

The `@huggingface/transformers` library (transformers.js) uses ONNX Runtime under the hood. It:

1. Downloads the model from HuggingFace Hub (or loads from local cache).
2. Runs ONNX Runtime inference — cross-platform, no PyTorch dependency.
3. Works in Node.js worker threads, keeping the main thread non-blocking.

Our current implementation in `rerankWorker.ts`:

```typescript
const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');

const tokenizer = await AutoTokenizer.from_pretrained(modelName, { allowRemoteModels: false });
const model = await AutoModelForSequenceClassification.from_pretrained(modelName, {
  dtype: dtype as 'q8',   // int8 quantized
  device: device as 'cpu',
  allowRemoteModels: false, // POPIA: no runtime HuggingFace pulls
});
```

The `allowRemoteModels: false` constraint means models must be baked into the Docker image. This is correct for POPIA compliance — no runtime data egress to HuggingFace.

### Cross-encoder gotcha: sigmoid activation

Cross-encoders output raw logits, not probabilities. The `logits` value from the model is unbounded. To get a 0–1 score:

```typescript
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

const scores = logits.map(sigmoid);
```

Our current `rerankWorker.ts` returns raw logits. This is functionally fine for ranking (ordering is preserved under monotonic functions) but the raw scores can be confusing (e.g., a score of 8.6 for a highly relevant doc). Consider adding sigmoid in a future cleanup for cleaner observability.

### Switching to bge-reranker-v2-m3 in transformers.js

The BGE-Reranker-v2-M3 (BAAI/bge-reranker-v2-m3) model is available in ONNX-compatible format on HuggingFace. To use it:

1. **Update `RERANK_MODEL`** to `Xenova/bge-reranker-v2-m3` (the Xenova ONNX-converted version).
2. **Update Docker image** to bake the model weights.
3. **Update `RERANK_DTYPE`** to `q8` (quantized int8) — the default is already `q8`.

```bash
# In Dockerfile, after npm install:
RUN node -e "
  const { AutoTokenizer, AutoModelForSequenceClassification } = require('@huggingface/transformers');
  Promise.all([
    AutoTokenizer.from_pretrained('Xenova/bge-reranker-v2-m3'),
    AutoModelForSequenceClassification.from_pretrained('Xenova/bge-reranker-v2-m3', { dtype: 'q8' })
  ]).then(() => console.log('Models baked')).catch(console.error)
"
```

### onnxruntime-node directly

For finer control (custom ONNX models, specific execution providers):

```typescript
import * as ort from 'onnxruntime-node';

// Load pre-exported ONNX model
const session = await ort.InferenceSession.create('./model.onnx', {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
});

// Run inference
const inputIds = new ort.Tensor('int64', inputIdData, [batchSize, seqLen]);
const attentionMask = new ort.Tensor('int64', maskData, [batchSize, seqLen]);
const outputs = await session.run({ input_ids: inputIds, attention_mask: attentionMask });
const logits = outputs['logits'].data as Float32Array;
```

Source: [onnxruntime.ai/docs/get-started/with-javascript/node.html](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)

### TEI (Text Embeddings Inference) integration

Our `RERANK_BACKEND=tei` mode calls a Hugging Face TEI server. TEI is a Rust-based inference server that supports cross-encoder models with a simple HTTP API:

```
POST {RERANK_TEI_URL}/rerank
Content-Type: application/json

{
  "query": "string",
  "texts": ["doc1", "doc2", ...],
  "truncate": true
}
```

Response:
```json
[
  { "index": 2, "score": 0.9991 },
  { "index": 0, "score": 0.8734 }
]
```

TEI is the right choice when:
- You want GPU-accelerated reranking on a separate service (decoupled scaling).
- Multiple MCP replicas share one GPU inference pod.
- You want to avoid loading a model into each Node.js worker.

TEI supports the full BGE-Reranker-v2-M3, Jina Reranker v2, and other large models that would be too heavy for in-process worker thread inference.

---

## 10. Latency Benchmarks and Budgets

### Where milliseconds go

Source: [n4n.ai/blog/how-much-latency-does-reranking-add-to-rag-pipelines/](https://n4n.ai/blog/how-much-latency-does-reranking-add-to-rag-pipelines/)

| Stage | Typical latency |
|---|---|
| ANN vector search (1M–100M docs, warmed) | 5–30 ms |
| BM25 + dense hybrid merge | +5–15 ms |
| Cross-encoder rerank (50 docs, CPU, MiniLM-L6) | 30–120 ms |
| Cross-encoder rerank (50 docs, GPU T4, MiniLM-L6) | 10–40 ms |
| Cross-encoder rerank (100 docs, CPU, BGE-v2-M3) | ~1,200 ms |
| API call to Cohere Rerank (intra-region) | +1–10 ms network |
| API cold start (first call of session, serverless) | +200–500 ms |
| LLM generation (gpt-4o-mini, 5 chunks) | ~1,000–3,000 ms |

### p50/p95 guidance

- **Reranking adds 2–5× the vector search time** for cross-encoders, when candidate count stays under 100.
- **Push k=500 to improve recall** and cross-encoder cost scales linearly: 500 docs may add 300–800ms on CPU.
- **CPU deployment is viable** for up to 20–50 candidates with small models (MiniLM-L6: 22M params, ~100ms for 50 docs on a modern CPU core).
- **GPU is necessary** for large models (BGE-v2-M3 7B, Qwen3-8B) or high throughput.

### Our current deployment

The `transformersReranker.ts` runs `Xenova/bge-reranker-base` (0.278B params, q8 quantized) in a Node.js worker thread. Realistic latency for the typical web-fetch use case (reranking 10–20 page chunks):

- **First call (warmup):** 2,000–10,000 ms (model load from disk).
- **Subsequent calls (20 chunks, 256 tokens avg):** 50–150 ms on a modern CPU.
- **Subsequent calls (100 chunks, 512 tokens avg):** 400–800 ms on CPU.

The `RERANK_DEVICE: z.string().default('cpu')` default is appropriate — the server images do not have a GPU. The warmup guard (`isReady()`) prevents requests from blocking during model load.

### Mitigation patterns

**1. Two-stage cascade (cheapest path):**
```
dense → top-200 → cheap reranker → top-20 → heavy reranker → top-5
Total: ~35ms instead of 200ms+ for running heavy on 200
```

**2. Score caching:**
```typescript
const cacheKey = `rerank:${hashQuery(query)}:${doc.id}`;
const cached = await redis.get(cacheKey);
if (cached) return parseFloat(cached);
const score = await reranker.score(query, doc.text);
await redis.setex(cacheKey, 3600, score.toString());
return score;
```
For a support bot, 30% of queries are duplicates. Score caching cuts reranking traffic by a third without model changes.

**3. Overlap generation with reranking:**
Start streaming LLM output using the top-1 vector result while the reranker scores the full set. This hides reranking behind perceived responsiveness.

---

## 11. BEIR Benchmark: What the Numbers Mean

BEIR (Benchmarking Information Retrieval) is a heterogeneous benchmark of 18 datasets covering news, biomedical, legal, academic, finance, and web domains. The primary metric is nDCG@10 (Normalized Discounted Cumulative Gain at rank 10).

Source: [app.ailog.fr/en/blog/news/beir-benchmark-update](https://app.ailog.fr/en/blog/news/beir-benchmark-update)

### What BEIR measures that MS MARCO does not

BEIR tests **zero-shot generalization** — models are evaluated on domains they were not trained on. This is the right test for our use case: we train on public search data but deploy on enterprise knowledge bases.

MS MARCO performance (e.g., MRR@10 39.0 for MiniLM-L6-v2) measures performance on web search queries. BEIR nDCG@10 ~60 for the same model shows meaningful degradation on out-of-domain data.

### Practical BEIR numbers for rerankers

| Reranker | BEIR Avg nDCG@10 | Notes |
|---|---|---|
| Qwen3-Reranker-8B | ~77.0 | State of the art open-weight |
| BGE-Reranker-v2-Gemma | ~73.7 | MIT, but 9B params |
| BGE-Reranker-v2-M3 (0.6B) | ~71.5 | Best quality/size ratio, MIT |
| Cohere Rerank 3 | ~72–73 (est.) | Proprietary, managed API |
| mxbai-rerank-large | ~67.3 | Apache 2.0 |
| ms-marco-MiniLM-L12-v2 | ~60.1 | Legacy baseline |
| BM25 alone | ~43–47 | No reranking |
| Dense bi-encoder alone | ~60–65 | e.g., MSMARCO-distilbert |

**The lift from reranking:** adding a cross-encoder reranker on top of a dense retriever typically improves nDCG@10 by 10–25 points in absolute terms. This maps to substantially better answer quality in downstream RAG.

### Does BEIR matter for our workload?

BEIR is a useful signal but it tests on public datasets. For the Phase 2 knowledge index (SharePoint + Confluence from Vodacom), performance on BEIR is only a proxy. The correct evaluation:

1. Sample 200–500 real employee queries from existing search logs.
2. Annotate relevance against retrieved chunks (can be done with an LLM judge).
3. Compute nDCG@10 on your own eval set with each reranker candidate.
4. Pick the model that maximises your own nDCG@10, not BEIR.

---

## 12. Current RERANK_BACKEND: What We Have and Gaps

### What we have

From `src/config.ts`:

```typescript
RERANK_BACKEND: z.string().default('none').refine(v => ['none', 'local', 'tei'].includes(v), {
  message: 'RERANK_BACKEND must be none, local, or tei',
}),
RERANK_MODEL: z.string().default('Xenova/bge-reranker-base'),
RERANK_DTYPE: z.string().default('q8'),
RERANK_DEVICE: z.string().default('cpu'),
RERANK_TEI_URL: z.string().optional(),
```

Three backends:

| Value | Implementation | Status |
|---|---|---|
| `none` | `NoopReranker` — returns chunks unordered | Stable |
| `local` | `TransformersReranker` — ONNX in worker thread via `@huggingface/transformers` | Stable |
| `tei` | `TeiReranker` — HTTP to TEI server at `RERANK_TEI_URL` | Stable |

The TEI API uses:
```json
POST /rerank
{ "query": "...", "texts": ["..."], "truncate": true }
```
Response: `[{ "index": number, "score": number }]`

### What is missing

| Gap | Impact | Priority |
|---|---|---|
| No `cohere` backend | Cannot use Cohere Rerank API for Phase 2 multilingual queries | Medium |
| Default model is `bge-reranker-base` not `bge-reranker-v2-m3` | ~10 BEIR nDCG@10 points left on table | Medium |
| Logits not sigmoid-normalised | Scores in observability/logs are confusing (e.g., 8.6 vs 0.99) | Low |
| No `top_n` param exposed in MCP tool | Agent cannot request fewer reranked results to save latency | Medium |
| No score caching | Repeated queries re-run full inference | Low |
| `RERANK_BACKEND` does not support Voyage AI | No path to test Voyage rerank-2.5 | Low |
| No multilingual model as default | Phase 2 has Afrikaans, Zulu, and other SA languages in docs | Medium |

### Recommended additions for Phase 2

```typescript
// Add to config.ts
RERANK_BACKEND: z.string().default('none').refine(v =>
  ['none', 'local', 'tei', 'cohere'].includes(v), {
    message: 'RERANK_BACKEND must be none, local, tei, or cohere',
  }),
RERANK_COHERE_API_KEY: z.string().optional(),
RERANK_COHERE_MODEL: z.string().default('rerank-v3.5'),
RERANK_TOP_N: z.string().default('10').transform(Number),
```

And add `CohereReranker` implementing the existing `Reranker` interface:

```typescript
// src/rank/cohereReranker.ts
import type { Chunk, ScoredChunk, Reranker } from './types.js';
import { getConfig } from '../config.js';

export class CohereReranker implements Reranker {
  readonly name = 'cohere';
  readonly maxSequenceTokens = 4096;
  private healthy = false;

  async warmup(): Promise<void> {
    // Ping Cohere health or do a test rerank
    this.healthy = !!getConfig().RERANK_COHERE_API_KEY;
  }

  isReady(): boolean { return this.healthy; }

  async rank(query: string, chunks: Chunk[], opts?: { signal?: AbortSignal }): Promise<ScoredChunk[]> {
    const config = getConfig();
    if (!config.RERANK_COHERE_API_KEY) throw new Error('RERANK_COHERE_API_KEY not set');

    const response = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.RERANK_COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.RERANK_COHERE_MODEL ?? 'rerank-v3.5',
        query,
        documents: chunks.map(c => c.text),
        top_n: config.RERANK_TOP_N ?? 10,
        max_tokens_per_doc: 2048,
      }),
      signal: opts?.signal,
    });

    if (!response.ok) {
      throw new Error(`Cohere Rerank HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as { results: Array<{ index: number; relevance_score: number }> };
    return data.results.map(r => ({ ...chunks[r.index]!, score: r.relevance_score }));
  }

  async close(): Promise<void> { this.healthy = false; }
}
```

---

## 13. Phase 2 Recommendation: Vodacom-Scale Strategy

### Scale parameters

Vodacom has ~20,000 employees. Assume Phase 2 knowledge index serves:
- 5,000 daily active users
- 10 searches per user per day
- 50,000 queries/day at peak
- Each query retrieves 50–100 candidates for reranking

### Recommended architecture

```
Phase 2 Search Pipeline
─────────────────────
Agent query
    │
    ▼
Hybrid retrieval (BM25 + dense embedding)
  - BGE-M3 or Azure OpenAI embeddings
  - Retrieve top-50 candidates
  - Entra ID ACL filter applied before reranking
  - Latency: ~20–40 ms
    │
    ▼
Reranker (TEI sidecar, BGE-Reranker-v2-M3)
  - POST to internal TEI pod
  - Rerank 50 → 10
  - Latency: ~50–150 ms (GPU pod)
  - If TEI unavailable: fall back to local ONNX
    │
    ▼
LLM generation (top-10 chunks as context)
```

### Model recommendation

**Primary:** `BAAI/bge-reranker-v2-m3`
- MIT license — no legal restrictions at Vodacom.
- 0.6B params — deployable on a T4 or A10G GPU pod, or CPU for lower volume.
- 71.5 BEIR avg nDCG@10 — competitive with Cohere Rerank 3 at zero per-query cost.
- Multilingual — covers Afrikaans and other SA languages in addition to English.

**Fallback:** `Xenova/bge-reranker-base` (current default)
- Already baked into our Docker image.
- Runs without GPU.
- Use for dev, low-traffic, or when TEI pod is unavailable.

**Do not use for Phase 2 production:**
- Cohere Rerank API as primary — POPIA data residency concern (document text leaves perimeter).
- ms-marco-MiniLM models as primary — domain drift too high for enterprise knowledge base.
- Jina Reranker v2 weights directly — CC-BY-NC-4.0 prohibits commercial deployment without API contract.

### ACL integration note

POPIA and the Entra ID ACL requirement means: **never pass un-ACL-filtered documents to the reranker**. The reranker receives documents that the requesting user is permitted to see. The ACL filter runs between retrieval and reranking, not after.

```
vector search (top-100) → ACL filter (keep permitted) → rerank (top-10) → LLM
```

If ACL filtering reduces the candidate set to fewer than 10, rerank the remaining set and return all of them (no padding with zero-permission docs).

### When reranking adds meaningful lift at Vodacom scale

Reranking adds the most lift when:
- Queries mix keyword and semantic intent: "reset password policy PDF" combines exact-match ("reset password") with semantic ("policy", "PDF").
- The corpus is heterogeneous: HR docs, IT documentation, sales playbooks, and Confluence wikis do not share vocabulary or style.
- Users ask in multiple languages: a query in Afrikaans against an English document benefits from a multilingual cross-encoder.

Reranking adds minimal lift when:
- The corpus is small (<10,000 chunks) and the embedding model is well-tuned to it.
- Queries are purely semantic with no rare keywords.
- Sub-100ms p95 is a hard requirement (voice interface, real-time autocomplete).

---

## 14. Complete TypeScript Implementation Patterns

### Pattern 1: The full RAG pipeline with reranking

```typescript
// src/search/rerankPipeline.ts
import type { Reranker, Chunk, ScoredChunk } from '../rank/types.js';

interface SearchResult {
  text: string;
  sourceUrl: string;
  headingPath: string;
  index: number;
  tokenEstimate: number;
}

interface RankedSearchResult extends SearchResult {
  score: number;
}

/**
 * Full retrieve → ACL filter → rerank → slice pipeline.
 *
 * @param query - the user's search query
 * @param candidates - raw results from vector search (up to 100)
 * @param reranker - the configured reranker instance
 * @param topN - number of results to return after reranking
 * @param signal - AbortSignal for cancellation
 */
export async function rerankPipeline(
  query: string,
  candidates: SearchResult[],
  reranker: Reranker,
  topN: number = 10,
  signal?: AbortSignal
): Promise<RankedSearchResult[]> {
  if (!reranker.isReady() || candidates.length === 0) {
    // Noop path: return original order, score 0
    return candidates.slice(0, topN).map((c, i) => ({ ...c, score: -i }));
  }

  const chunks: Chunk[] = candidates.map(c => ({
    text: c.text,
    headingPath: c.headingPath,
    sourceUrl: c.sourceUrl,
    index: c.index,
    tokenEstimate: c.tokenEstimate,
  }));

  const scored: ScoredChunk[] = await reranker.rank(query, chunks, { signal });
  return scored.slice(0, topN).map(s => ({ ...s }));
}
```

### Pattern 2: Sigmoid normalisation for cross-encoder scores

```typescript
// src/rank/scores.ts

/**
 * Normalise raw cross-encoder logits to [0, 1].
 * Cross-encoders output unbounded logits; sigmoid maps them to probabilities.
 * Ordering is preserved under sigmoid (monotonic), so sorting is unaffected.
 */
export function sigmoidNormalise(logits: number[]): number[] {
  return logits.map(x => 1 / (1 + Math.exp(-x)));
}

/**
 * Check if scores look like logits (not yet normalised).
 * If max score > 5, assume raw logits.
 */
export function maybeNormalise(scores: number[]): number[] {
  const max = Math.max(...scores);
  return max > 5 ? sigmoidNormalise(scores) : scores;
}
```

### Pattern 3: TEI-compatible reranker for BGE-v2-M3

```typescript
// This is the existing teiReranker.ts; add a health retry:

async warmup(): Promise<void> {
  const url = this.cfg().RERANK_TEI_URL;
  if (!url) return;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await this.client.request({ url: `${url}/health`, purpose: 'api', timeoutMs: 5000 });
      this.healthy = true;
      return;
    } catch {
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
  }
  Logger.warn('[TeiReranker] Health check failed after 3 attempts — falling back to noop');
}
```

### Pattern 4: Cohere reranker with POPIA audit

```typescript
// src/rank/cohereReranker.ts
import { Logger } from '../utils/logger.js';
import type { Chunk, ScoredChunk, Reranker } from './types.js';

export class CohereReranker implements Reranker {
  readonly name = 'cohere';
  readonly maxSequenceTokens = 4096;
  private healthy = false;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = 'rerank-v3.5') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async warmup(): Promise<void> {
    this.healthy = true; // Cohere has no pre-warmup endpoint; validate on first call
  }

  isReady(): boolean { return this.healthy; }

  async rank(
    query: string,
    chunks: Chunk[],
    opts?: { signal?: AbortSignal }
  ): Promise<ScoredChunk[]> {
    // POPIA audit: log that document text is being sent to external API
    Logger.warn('[CohereReranker] Sending document text to Cohere API — verify POPIA data residency consent');

    const response = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Client-Name': 'markdown-for-agents-mcp',
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: chunks.map(c => c.text),
        top_n: chunks.length, // return all, caller slices
        max_tokens_per_doc: 2048,
      }),
      signal: opts?.signal,
    });

    if (!response.ok) {
      throw new Error(`Cohere Rerank ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as {
      results: Array<{ index: number; relevance_score: number }>;
    };

    return data.results.map(r => ({
      ...chunks[r.index]!,
      score: r.relevance_score,
    }));
  }

  async close(): Promise<void> {
    this.healthy = false;
  }
}
```

### Pattern 5: Score cache with Redis

```typescript
// src/rank/cachedReranker.ts
import type { Chunk, ScoredChunk, Reranker } from './types.js';
import { createHash } from 'crypto';

interface CacheStore {
  get(key: string): Promise<string | null>;
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
}

export class CachedReranker implements Reranker {
  readonly name: string;
  readonly maxSequenceTokens: number;

  constructor(
    private readonly inner: Reranker,
    private readonly cache: CacheStore,
    private readonly ttlSeconds = 3600
  ) {
    this.name = `cached:${inner.name}`;
    this.maxSequenceTokens = inner.maxSequenceTokens;
  }

  async warmup(): Promise<void> { await this.inner.warmup(); }
  isReady(): boolean { return this.inner.isReady(); }
  async close(): Promise<void> { await this.inner.close(); }

  async rank(query: string, chunks: Chunk[], opts?: { signal?: AbortSignal }): Promise<ScoredChunk[]> {
    const uncachedChunks: Array<{ chunk: Chunk; idx: number }> = [];
    const scored: ScoredChunk[] = new Array(chunks.length);
    const queryHash = createHash('sha256').update(query).digest('hex').slice(0, 16);

    // Check cache for each chunk
    for (let i = 0; i < chunks.length; i++) {
      const docHash = createHash('sha256').update(chunks[i]!.text).digest('hex').slice(0, 16);
      const cacheKey = `rerank:${queryHash}:${docHash}`;
      const cached = await this.cache.get(cacheKey);
      if (cached !== null) {
        scored[i] = { ...chunks[i]!, score: parseFloat(cached) };
      } else {
        uncachedChunks.push({ chunk: chunks[i]!, idx: i });
      }
    }

    // Rerank uncached chunks
    if (uncachedChunks.length > 0) {
      const newScored = await this.inner.rank(
        query,
        uncachedChunks.map(u => u.chunk),
        opts
      );
      for (let j = 0; j < uncachedChunks.length; j++) {
        const { idx } = uncachedChunks[j]!;
        const s = newScored.find(r => r.index === idx) ?? { ...uncachedChunks[j]!.chunk, score: 0 };
        scored[idx] = s;
        // Store in cache
        const docHash = createHash('sha256').update(chunks[idx]!.text).digest('hex').slice(0, 16);
        const cacheKey = `rerank:${queryHash}:${docHash}`;
        await this.cache.setex(cacheKey, this.ttlSeconds, s.score.toString());
      }
    }

    return (scored as ScoredChunk[]).sort((a, b) => b.score - a.score);
  }
}
```

---

## 15. When Not to Rerank

Reranking adds latency and complexity. Skip it when:

### Hard skip cases

1. **Sub-100ms p95 requirement** (voice interface, real-time autocomplete): A cross-encoder on 20+ candidates cannot meet 100ms p95 on CPU. Use a well-tuned hybrid retriever instead.
2. **Static or low-variance corpora**: If your corpus rarely changes and you have pre-ranked the top results offline, serve pre-computed rankings.
3. **Tiny corpus (<1,000 chunks)**: Dense + BM25 hybrid recall is already near-perfect. Reranking adds 5–10% quality lift that may not be perceptible.
4. **High-throughput bots where cost dominates**: A bi-encoder with a well-tuned threshold beats a cross-encoder on price-per-query for high-volume, low-stakes workloads.

### Soft skip cases (benchmark first)

1. **Single-language, single-domain corpus with a domain-tuned embedding model**: If your embedding model was fine-tuned on your specific content, bi-encoder recall may already be above 0.85@10, leaving little room for improvement.
2. **Short queries over short documents**: Very short queries (2–3 words) against very short documents (1–2 sentences) do not gain much from cross-encoder interaction.

### The decision rule from presenc.ai

> "Use a reranker if your retrieval recall at top-100 is materially above your recall at top-5 on a representative eval set; the reranker exists to recover that recall gap."

If recall@100 = 0.82 and recall@5 = 0.78, the gap is 0.04 — small. Reranking won't help much.  
If recall@100 = 0.82 and recall@5 = 0.45, the gap is 0.37 — a reranker will recover significant quality.

---

## 16. Failure Modes and Gotchas

### Model warmup race condition

Our `transformersReranker.ts` falls back to `NoopReranker` if `isReady()` returns false. The `readyz` endpoint gates on `rerankerGuard.isReady()`. But warmup takes 2,000–10,000 ms for model load. If a request arrives during warmup, it gets un-ranked results. This is acceptable for the web-fetch use case but means early search results after startup are lower quality.

**Mitigation:** Add a pre-warm step in the Dockerfile or Helm init container. Or add a startup delay before accepting traffic.

### Worker thread crash loop

If `rerankWorker.ts` crashes (OOM, model load failure, uncaught error), the worker exits and `TransformersReranker` marks `failed = true`. All subsequent requests fall back to NoopReranker silently. The only signal is the `reranker_ready` gauge in Prometheus dropping to 0.

**Mitigation:** Alert on `reranker_ready == 0` for more than 30 seconds. Restart the application (the worker does not auto-restart).

### TEI connection refuses at startup

`TeiReranker.warmup()` does a single health check. If the TEI pod is not yet ready, `healthy = false` and all requests fall back to noop forever (no retry). This is fragile in Kubernetes where pod startup ordering is not guaranteed.

**Mitigation:** Add retry logic with backoff (Pattern 3 above). Or use Kubernetes readiness probes to ensure TEI is ready before the MCP pod starts.

### Cohere API rate limits

Free tier: 100 calls/minute, 1,000/month. Production tier: check [cohere.com/pricing](https://cohere.com/pricing).

A 429 from Cohere should be caught, logged, and cause fallback to the local/TEI backend. Never let a Cohere rate limit fail the entire search request.

```typescript
try {
  return await cohereReranker.rank(query, chunks);
} catch (err) {
  if (err instanceof Error && err.message.includes('429')) {
    Logger.warn('[CohereReranker] Rate limited, falling back to local');
    return localReranker.rank(query, chunks);
  }
  throw err;
}
```

### Token limit truncation

Cohere truncates documents to `max_tokens_per_doc` (default 4,096). Long documents lose their tail. For knowledge base articles that front-load their metadata and bury answers in the body, this causes silent quality degradation.

**Mitigation:** Chunk documents before sending. Pass chunks, not full documents, to the reranker. This is already our architecture (the `Chunk` type has `tokenEstimate`).

### Cross-encoder score calibration across models

Different cross-encoders have different score scales:
- ms-marco-MiniLM: raw logits typically -5 to +10.
- BGE-Reranker: raw logits typically -10 to +20.
- Cohere Rerank: normalised 0.0 to 1.0.
- TEI (BAAI/bge-reranker-v2-m3): raw logits.

Do not compare scores across models or use score thresholds that assume a particular scale. Use rank (position) not absolute score for decisions like "is this relevant?"

### Multilingual cross-encoder fallback

ms-marco models do not support non-English queries. If a user sends a query in Afrikaans and the reranker was trained on English only, it will produce garbage scores (the model has never seen Afrikaans tokens). The ranking will be random.

For Phase 2 with SA language support:
- Use `BGE-Reranker-v2-M3` or `Qwen3-Reranker` (both multilingual).
- Or add language detection and skip reranking for non-English queries when running ms-marco.

### ONNX dtype mismatch

The `RERANK_DTYPE: z.string().default('q8')` allows `q8` (int8 quantised) and `fp32`. Some models do not have a published `q8` ONNX export. If `@huggingface/transformers` cannot find the quantised variant, it falls back to fp32 (larger, slower). Check the HuggingFace model card for available ONNX variants before changing `RERANK_MODEL`.

---

## Summary and Recommendations

### What to build now

1. **Upgrade default `RERANK_MODEL`** from `Xenova/bge-reranker-base` to `Xenova/bge-reranker-v2-m3` once it is available in a transformers.js-compatible ONNX format. This is the single largest quality improvement available at zero cost.

2. **Add `RERANK_BACKEND=cohere` support** with a `CohereReranker` class (see Pattern 4). Use it for the Phase 2 pilot where data residency is not a blocker. Gate it behind a POPIA audit log line.

3. **Add retry logic to `TeiReranker.warmup()`** (Pattern 3). Kubernetes startup ordering makes single-attempt health checks fragile.

4. **Add sigmoid normalisation** to `rerankWorker.ts` output so Prometheus metrics and logs show 0–1 scores rather than raw logits.

### What to build for Phase 2

5. **Deploy a TEI pod** (Hugging Face Text Embeddings Inference) running `BAAI/bge-reranker-v2-m3` as the `RERANK_BACKEND=tei` target. All MCP replicas share one GPU inference pod. This is the correct architecture for 50k+ queries/day.

6. **Extend `RERANK_BACKEND` to support a 4-value enum**: `none | local | tei | cohere`. Add `RERANK_TOP_N` config key (default 10).

7. **Evaluate on a domain-specific test set** — sample 200+ real Vodacom employee queries, annotate, compute nDCG@10. Do not assume BEIR scores predict performance on the actual corpus.

8. **Add score caching** (Pattern 5) for the TEI backend. With Redis, cache `(query_hash, doc_id) → score` at TTL 1 hour. Expect 20–30% hit rate on support bots.

### What to skip (for now)

- **ColBERT/PLAID as first-stage retrieval**: adds significant operational complexity (Python dependency, custom vector store, PLAID index management) for a quality gain achievable with a simpler cross-encoder reranker.
- **LLM-as-reranker (RankGPT, listwise reranking)**: materially more expensive and latency-heavy than dedicated cross-encoders. Only useful when you need ranking quality beyond what any cross-encoder achieves, at the cost of 5–10× inference cost.
- **Jina Reranker v2 weights self-hosted**: CC-BY-NC-4.0 prohibits commercial use. Use the Jina API (paid) or pick BGE/mxbai/Qwen3 instead.

---

*Sources consulted: docs.cohere.com, huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2, sbert.net, presenc.ai/research/best-open-weight-reranker-models-2026, n4n.ai/blog/how-much-latency-does-reranking-add-to-rag-pipelines/, markaicode.com/colbert-plaid-late-interaction-retrieval-rag/, pypi.org/project/FlashRank/, onnxruntime.ai, futureagi.com/blog/best-rerankers-for-rag-2026/, arxiv.org/abs/2205.09707 (PLAID), app.ailog.fr/en/blog/news/beir-benchmark-update, inferensys.com/glossary/cascade-ranking, github.com/agentset-ai/awesome-rerankers, docs.4allapi.com/en/rerank/cohere-rerank/*
