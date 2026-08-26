# Embedding Models for Enterprise Semantic Search

**Research area:** Phase 2 knowledge index — embedding model selection, self-hosted deployment, multilingual support  
**Project context:** markdown-for-agents-mcp Phase 2 enterprise knowledge index with SharePoint + Confluence connectors and per-user Entra ID ACL enforcement  
**Target deployment:** Vodacom SA enterprise — predominantly English enterprise content with Afrikaans, isiZulu, and isiXhosa requirements  
**Research date:** 2026-08-26  

**Sources:** MTEB Leaderboard (huggingface.co/spaces/mteb/leaderboard), Ollama library (ollama.com/library), Cohere docs (docs.cohere.com/docs/embeddings), HuggingFace TEI docs, model cards for BGE-M3, nomic-embed-text-v1.5, mxbai-embed-large-v1, multilingual-e5-large-instruct, gte-Qwen2-7B-instruct, snowflake-arctic-embed-l-v2.0, Jina embeddings

---

## Table of Contents

1. [Why Embeddings Matter for This Project](#1-why-embeddings-matter-for-this-project)
2. [MTEB Leaderboard 2026 — Retrieval Rankings](#2-mteb-leaderboard-2026--retrieval-rankings)
3. [Model Tier Analysis](#3-model-tier-analysis)
4. [Multilingual Quality — South African Languages](#4-multilingual-quality--south-african-languages)
5. [API-Based Providers](#5-api-based-providers)
6. [Self-Hosted via Ollama](#6-self-hosted-via-ollama)
7. [HuggingFace Text Embeddings Inference (TEI)](#7-huggingface-text-embeddings-inference-tei)
8. [Transformers.js — ONNX in Node.js](#8-transformersjs--onnx-in-nodejs)
9. [ONNX Quantization Deep Dive](#9-onnx-quantization-deep-dive)
10. [Dimensionality and Storage Analysis](#10-dimensionality-and-storage-analysis)
11. [Integration Patterns for This Project](#11-integration-patterns-for-this-project)
12. [Embedding API Abstraction Layer](#12-embedding-api-abstraction-layer)
13. [Background Worker Architecture](#13-background-worker-architecture)
14. [Failure Modes and Edge Cases](#14-failure-modes-and-edge-cases)
15. [Recommended Model Stack for Vodacom SA](#15-recommended-model-stack-for-vodacom-sa)
16. [What to Build vs What to Skip](#16-what-to-build-vs-what-to-skip)

---

## 1. Why Embeddings Matter for This Project

The Phase 2 knowledge index stores document chunks from SharePoint and Confluence. Users ask the MCP server a question and the server must find the 10-20 most relevant chunks, then attach them to the agent context. The quality of retrieval is entirely determined by the embedding model.

### The core pipeline

```
User query ──► embed(query) ──► vector similarity search ──► top-K chunks ──► LLM context
                                                                    ↑
SharePoint pages ──► chunk ──► embed(chunk) ──► store in pgvector
Confluence pages ──► chunk ──► embed(chunk) ──► store in pgvector
```

### Why model choice is architectural

- **Dimensions** determine pgvector index size and query latency. 768-dim vs 3072-dim is a 4x storage difference and ~2-3x query speed difference at scale.
- **Max token context** determines chunking strategy. A 512-token limit forces aggressive chunking; 8192 tokens lets you embed entire wiki pages as single vectors.
- **Multilingual quality** is non-negotiable for Vodacom SA. A model that handles English well but fails on Afrikaans intranet content poisons retrieval for Afrikaans-speaking staff.
- **Query vs document asymmetry**: all production-grade embedding models require different prompts/modes for queries vs stored documents. Getting this wrong degrades NDCG@10 by 10-20%.
- **ACL safety**: embeddings are computed at ingest time. If you re-embed when ACL changes, you add operational complexity. Choose a model stable enough that you won't re-embed your entire corpus every six months.

---

## 2. MTEB Leaderboard 2026 — Retrieval Rankings

MTEB (Massive Text Embedding Benchmark) is the authoritative benchmark. The leaderboard is live at https://huggingface.co/spaces/mteb/leaderboard. The primary retrieval metric is **NDCG@10** (Normalized Discounted Cumulative Gain at rank 10) on the BEIR dataset (15 datasets).

### Top English MTEB scores (BEIR NDCG@10, August 2026)

| Rank | Model | Params | Dimensions | MTEB Score | License |
|------|-------|--------|-----------|------------|---------|
| 1 | gte-Qwen2-7B-instruct (Alibaba) | 7B | 3584 | 70.24 | Apache 2.0 |
| 2 | NV-Embed-v1 (NVIDIA) | ~7B | 4096 | 69.32 | CC-BY-NC |
| 3 | gte-Qwen1.5-7B-instruct (Alibaba) | 7B | 3584 | 67.34 | Apache 2.0 |
| 4 | e5-mistral-7b-instruct (Microsoft) | 7B | 4096 | 66.63 | MIT |
| 5 | gte-large-en-v1.5 (Alibaba) | 434M | 1024 | 65.39 | Apache 2.0 |
| 6 | bge-base-en-v1.5 (BAAI) | 109M | 768 | 64.23 | MIT |
| 7 | mxbai-embed-large-v1 (Mixedbread) | 335M | 1024 | 64.68 | Apache 2.0 |
| 8 | gte-base-en-v1.5 (Alibaba) | 137M | 768 | 64.11 | Apache 2.0 |
| 9 | bge-large-en-v1.5 (BAAI) | 335M | 1024 | 63.55 | MIT |
| 10 | nomic-embed-text-v1.5 (Nomic) | 137M | 768 | 62.28 | Apache 2.0 |
| 11 | multilingual-e5-large (MS) | 560M | 1024 | 61.50 | MIT |
| 12 | multilingual-e5-base (MS) | 278M | 768 | 59.45 | MIT |

**Source:** https://huggingface.co/Alibaba-NLP/gte-Qwen2-7B-instruct (model card evaluation table, June 2024 snapshot)

### MTEB multilingual rankings (MIRACL, 4 languages; CLEF)

| Model | BEIR (15) | MIRACL (4) | CLEF Focused | CLEF Full |
|-------|-----------|------------|--------------|-----------|
| snowflake-arctic-embed-l-v2.0 | 55.6 | **55.8** | **52.9** | **54.3** |
| bge-m3 (BAAI) | 48.8 | 56.8 | 40.8 | 41.3 |
| gte (Alibaba, 305M) | 51.1 | 52.3 | 47.7 | 53.1 |
| multilingual-e5-base | — | 54.0 | 43.0 | 34.6 |
| snowflake-arctic-embed-m | 54.9 | 24.9 | 34.4 | 29.1 |
| snowflake-arctic-embed-l (v1) | 56.0 | 34.8 | 38.2 | 33.7 |

**Key insight:** The original arctic-embed-l (v1) was English-only and fell apart on multilingual. v2.0 with 74-language support is a fundamentally different model. BGE-M3 scores highest on MIRACL but lower on BEIR (English).

### MTEB interpretation for this project

BEIR measures retrieval on English domain-specific corpora (COVID papers, finance, legal). This directly maps to enterprise SharePoint content. MIRACL tests multilingual retrieval. CLEF tests multi-domain European language content.

For the Vodacom SA knowledge index, you need a model that scores well on BOTH BEIR and MIRACL — which currently only Snowflake Arctic Embed L v2.0 achieves in a single deployable open-weight package.

---

## 3. Model Tier Analysis

### Tier 1: Small models (<100M parameters)

Best for: Ollama on developer laptops, rapid prototyping, edge scenarios.

| Model | Params | Dimensions | Max Tokens | MTEB | Languages | Use Case |
|-------|--------|-----------|------------|------|-----------|----------|
| all-minilm-L6-v2 | 22M | 384 | 256 | ~56 | English | Prototype only |
| all-minilm-L12-v2 | 33M | 384 | 256 | ~59 | English | Prototype only |
| snowflake-arctic-embed-xs | 22M | 384 | 512 | ~51 | English | Fast CI tests |

**Verdict for this project:** Do not use in production. 22-33M models lack the capacity to handle enterprise document diversity. Use them only to stand up the pipeline quickly and run integration tests.

### Tier 2: Medium models (100–400M parameters) — the production sweet spot

| Model | Params | Dimensions | Max Tokens | MTEB | Languages | License |
|-------|--------|-----------|------------|------|-----------|---------|
| nomic-embed-text-v1.5 | 137M | 768 (MRL) | 8192 | 62.28 | English only | Apache 2.0 |
| bge-base-en-v1.5 | 109M | 768 | 512 | 64.23 | English | MIT |
| gte-base-en-v1.5 | 137M | 768 | 8192 | 64.11 | English | Apache 2.0 |
| mxbai-embed-large-v1 | 335M | 1024 (MRL) | 512 | 64.68 | English | Apache 2.0 |
| bge-large-en-v1.5 | 335M | 1024 | 512 | 63.55 | English | MIT |
| multilingual-e5-base | 278M | 768 | 512 | 59.45 | 94 languages | MIT |
| bge-m3 | 568M | 1024 | 8192 | 48.8 BEIR / 56.8 MIRACL | 100+ languages | MIT |
| snowflake-arctic-embed-l-v2.0 | 568M | 1024 (MRL) | 8192 | 55.6 BEIR / 55.8 MIRACL | 74 languages | Apache 2.0 |

**Why this tier wins for production:**

1. Inference is fast enough to embed document batches without GPU — 337-568M parameter BERT-class models run at 50-150ms per chunk on CPU with INT8 quantization.
2. Memory footprint fits in a 2-4GB container alongside the application.
3. No GPU required for the embedding worker.
4. Licensing is permissive for commercial enterprise deployment.

**Best pick for English-first with multilingual fallback:** nomic-embed-text-v1.5 (English) + bge-m3 (multilingual) as a dual-model strategy.

**Best single-model pick:** snowflake-arctic-embed-l-v2.0 — handles English and multilingual in one model, 8192 token context, Matryoshka dimensions, 74 languages, Apache 2.0.

### Tier 3: Large models (>400M parameters) — LLM-backed embedding

| Model | Params | Dimensions | Max Tokens | MTEB | Languages |
|-------|--------|-----------|------------|------|-----------|
| gte-Qwen2-7B-instruct | 7B | 3584 | 32768 | 70.24 | Multilingual |
| e5-mistral-7b-instruct | 7B | 4096 | 32768 | 66.63 | Multilingual |
| gte-Qwen1.5-7B-instruct | 7B | 3584 | 32768 | 67.34 | Multilingual |
| NV-Embed-v1 | ~7B | 4096 | — | 69.32 | English |

**How they work:** These are full LLMs (decoder-only or encoder-decoder) fine-tuned to produce embeddings using last-token pooling with causal attention. The instruction prefix on the query side (`Instruct: ...\nQuery:`) is critical — without it, scores drop by 5-10 NDCG points.

**Practical constraints:**

- A 7B model in FP16 requires 14GB GPU VRAM. BF16 is similar. INT8 quantization brings it to ~7GB.
- Inference latency per batch is 5-10x slower than 300-500M encoder models.
- Token cost for API-based LLM embedding would make corpus re-indexing prohibitive.
- The 3584-dim or 4096-dim output doubles pgvector storage vs 1024-dim models.

**Verdict:** The MTEB gain (70.24 vs 64.68) is real but the operational cost is not justified for enterprise knowledge retrieval where document diversity and multilingual support matter more than top-1% NDCG. Use Tier 2. Revisit Tier 3 only if retrieval quality is demonstrably failing at scale.

---

## 4. Multilingual Quality — South African Languages

### South Africa's language landscape for enterprise

South Africa has 11 official languages. For Vodacom SA enterprise content, the realistic distribution is:

- **English**: ~70-80% of formal enterprise documents (Confluence wiki, SharePoint intranets, policies)
- **Afrikaans**: ~15-20% of documents (heavily represented in compliance, HR, legacy content)
- **isiZulu**: ~3-5% (customer-facing policies, HR notices, internal communications)
- **isiXhosa**: ~1-3% (primarily informal comms, some HR)
- **Other**: small percentages

### How major multilingual models handle SA languages

#### XLM-RoBERTa-based models (BGE-M3, multilingual-e5, snowflake-arctic-l-v2.0)

XLM-RoBERTa was trained on CommonCrawl data across 100 languages. The training corpus coverage for SA languages is:

- **Afrikaans**: In XLM-R's 100 languages. Moderate training data. Semantic similarity works adequately.
- **isiZulu (Zulu)**: Limited but present in XLM-R. Low-resource language with sparse CommonCrawl representation.
- **isiXhosa**: Similar to Zulu — present but low-resource.

Source reference: The multilingual-e5-large-instruct card states "It supports 100 languages from xlm-roberta, but low-resource languages may see performance degradation." This directly applies to isiZulu and isiXhosa.

#### BGE-M3 specific multilingual notes

BGE-M3 explicitly claims 100+ languages and has been benchmarked showing "top performance in both English and other languages, surpassing models such as OpenAI" (community benchmark, March 2024). It is the strongest open-weight multilingual model for African-language content because:

1. Extended 8192-token context handles long documents without truncation loss
2. The model was trained with contrastive learning across language pairs, not just Wikipedia
3. Hybrid dense+sparse retrieval means lexical Zulu/Afrikaans terms still match via sparse path even if dense embeddings are weaker

Source: https://huggingface.co/BAAI/bge-m3

#### Cohere embed-v4.0 for SA languages

The Cohere embed-v4.0 card states "best-in-class multilingual model with support for over 100 languages." Cohere has historically invested more heavily in multilingual training data quality vs XLM-RoBERTa-based open models. For Afrikaans specifically, Cohere's model is likely the strongest commercial option.

**Caveat:** There is no public MTEB multilingual benchmark including isiZulu or isiXhosa in the standard test sets. Any claim about performance on these languages is extrapolated from training data size, not direct benchmark evidence.

### Recommended strategy for SA multilingual

Given the lack of Zulu/Xhosa MTEB benchmarks, use a hybrid approach:

1. **BGE-M3 or Snowflake Arctic L v2.0** as the primary embedding model — both handle Afrikaans well via XLM-R heritage, and handle Zulu/Xhosa better than English-only models due to multilingual pre-training
2. **Language detection** at ingest time (see below) — tag each chunk with its detected language
3. **Hybrid retrieval** (dense + BM25 sparse) for Zulu/Xhosa content — sparse retrieval degrades gracefully on low-resource languages because it is lexically exact, no semantic understanding required
4. **Do not segment corpora by language** — a single index with multilingual embeddings is simpler and allows cross-language retrieval (an English query finding an Afrikaans document about the same policy)

```typescript
// Language detection at ingest
import { franc } from 'franc-min';

interface ChunkMetadata {
  sourceId: string;
  language: string;  // ISO 639-3: 'eng', 'afr', 'zul', 'xho'
  confidence: number;
  chunkIndex: number;
}

function detectLanguage(text: string): { language: string; confidence: number } {
  const result = franc(text, { minLength: 20 });
  // franc returns ISO 639-3 codes
  // 'eng' = English, 'afr' = Afrikaans, 'zul' = Zulu, 'xho' = Xhosa
  return {
    language: result,
    confidence: result === 'und' ? 0 : 0.7  // franc doesn't return confidence, estimate
  };
}
```

### Afrikaans-specific gotcha

Afrikaans shares vocabulary with Dutch. If your XLM-RoBERTa-based model was trained with Dutch as a high-resource language, Afrikaans text may get embeddings heavily influenced by Dutch semantics. For enterprise HR/compliance content this is generally fine. For domain-specific Afrikaans legal terminology, fine-tuning on a Vodacom-specific corpus would be necessary — but that is out of scope for Phase 2.

---

## 5. API-Based Providers

### OpenAI text-embedding-3 family

OpenAI offers two production embedding models as of 2026:

| Model | Default Dimensions | Max Dimensions | Max Tokens | Cost |
|-------|-------------------|----------------|------------|------|
| text-embedding-3-small | 1536 | 1536 | 8191 | ~$0.02/1M tokens |
| text-embedding-3-large | 3072 | 3072 | 8191 | ~$0.13/1M tokens |

Source: OpenAI pricing at https://platform.openai.com/docs/models

**Matryoshka support:** Both models support dimension reduction via the `dimensions` parameter. text-embedding-3-large with `dimensions: 256` retains ~93.1% of full performance.

**TypeScript API usage:**

```typescript
import OpenAI from 'openai';

const openai = new OpenAI();

interface EmbedDocumentOptions {
  text: string;
  dimensions?: number;  // 256 | 512 | 1024 | 1536 | 3072
}

async function embedDocument(options: EmbedDocumentOptions): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-large',
    input: options.text,
    dimensions: options.dimensions ?? 1024,  // good balance for enterprise
    encoding_format: 'float',
  });
  return response.data[0].embedding;
}

async function embedQuery(query: string): Promise<number[]> {
  // No asymmetry for OpenAI — same model for query and document
  return embedDocument({ text: query, dimensions: 1024 });
}

// Batch embedding
async function embedBatch(texts: string[], batchSize = 100): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-large',
      input: batch,
      dimensions: 1024,
      encoding_format: 'float',
    });
    results.push(...response.data.map(d => d.embedding));
  }
  return results;
}
```

**Cost analysis for Vodacom SA:**

Assuming a 50,000-document Confluence + SharePoint corpus:
- Average document chunk: 400 tokens
- Total tokens at initial indexing: 50,000 × 400 = 20M tokens
- text-embedding-3-large cost: 20M × $0.13/1M = **$2.60 one-time**
- Re-indexing every 6 months: $5.20/year
- Query volume: 10,000 queries/day × 100 tokens × 365 = 365M tokens/year = **$47.45/year**

Conclusion: OpenAI embeddings are cheap enough at Vodacom enterprise scale. The cost argument for self-hosting is weak unless the corpus is >1B tokens.

**OpenAI multilingual limitation:** text-embedding-3 models have no explicit multilingual training disclosure. They perform well on major European languages but have no documented support for isiZulu or isiXhosa. Do not use OpenAI embeddings if you need Zulu/Xhosa retrieval quality guarantees.

### Cohere embed-v4.0

Source: https://docs.cohere.com/docs/embeddings

The most feature-complete commercial embedding API.

**Key parameters:**

```typescript
interface CohereEmbedRequest {
  texts: string[];
  model: 'embed-v4.0';
  input_type: 'search_query' | 'search_document' | 'classification' | 'clustering';
  output_dimension: 256 | 512 | 1024 | 1536 | 4096;  // Matryoshka
  embedding_types: Array<'float' | 'int8' | 'uint8' | 'binary' | 'ubinary'>;
}
```

**TypeScript integration:**

```typescript
import Cohere from 'cohere-ai';

const co = new Cohere.Client({ token: process.env.COHERE_API_KEY! });

async function embedDocumentsCohere(texts: string[]): Promise<number[][]> {
  const response = await co.v2.embed({
    texts,
    model: 'embed-v4.0',
    inputType: 'search_document',
    outputDimension: 1024,
    embeddingTypes: ['float'],
  });
  return response.embeddings.float!;
}

async function embedQueryCohere(query: string): Promise<number[]> {
  const response = await co.v2.embed({
    texts: [query],
    model: 'embed-v4.0',
    inputType: 'search_query',  // CRITICAL: different from document embedding
    outputDimension: 1024,
    embeddingTypes: ['float'],
  });
  return response.embeddings.float![0];
}
```

**The `input_type` parameter is non-optional in production.** Without it, queries and documents land in the same undifferentiated embedding space, degrading asymmetric retrieval quality. Cohere's model is specifically trained with this asymmetry.

**Cohere multilingual quality:** The Cohere embed-v4.0 claims "best-in-class multilingual model with support for over 100 languages" including Korean, Japanese, Arabic, Chinese, Spanish, French. Afrikaans is likely covered (Dutch-Germanic basis). isiZulu and isiXhosa coverage is not documented.

**Compression types in Cohere:**

| Type | Bits | Storage vs float32 | Quality retention |
|------|------|-------------------|-------------------|
| float | 32 | 1x baseline | 100% |
| int8 | 8 | 4x reduction | ~99% |
| uint8 | 8 | 4x reduction | ~99% |
| binary | 1 | 32x reduction | ~96% with rescoring |
| ubinary | 1 | 32x reduction | ~96% with rescoring |

**Cohere batch API** is available for large corpus indexing — submit up to 10MB payload per request. For initial corpus ingest, batch via the `/v2/embed` endpoint with `texts` arrays of up to 96 items per call.

**Cohere cost** (as of mid-2026): ~$0.10/1M tokens. This is roughly competitive with text-embedding-3-large. The main reason to choose Cohere over OpenAI for this project is the explicit multilingual quality and the better-documented SA language handling.

### Jina Embeddings v5

Source: https://jina.ai/embeddings/

Jina has released their v5 family as of 2026:

| Model | Params | Context | Type | Notes |
|-------|--------|---------|------|-------|
| jina-embeddings-v5-text-small | 677M | 32K | Text | Task LoRA adapters |
| jina-embeddings-v5-text-nano | 239M | 32K | Text | Efficient deployment |
| jina-embeddings-v5-omni-small | 1.6B | — | Multimodal | Text + image + audio + video |
| jina-embeddings-v5-omni-nano | 0.9B | — | Multimodal | Competitive under 1B |

**What Jina does differently:**

1. **Task-specific LoRA adapters**: Instead of a single fixed embedding, v5-text loads a task-specific adapter at inference time. This is like Cohere's `input_type` but the model weights change, not just the prefix.
2. **Matryoshka dimensions** from the same checkpoint — truncate to any dimension without quality catastrophe.
3. **32K context window** is the largest in any commercial/open embedding model. Critical for embedding entire SharePoint pages without chunking.
4. **GGUF/MLX quantization** for CPU/Apple Silicon — unique among commercial providers.

**API schema:**

```typescript
// Jina REST API (OpenAI-compatible)
const response = await fetch('https://api.jina.ai/v1/embeddings', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.JINA_API_KEY}`,
  },
  body: JSON.stringify({
    model: 'jina-embeddings-v5-text-small',
    normalized: true,          // L2-normalize output (required for cosine via dot product)
    embedding_type: 'float',   // 'float' | 'binary' | 'base64'
    input: texts,              // string[]
  }),
});
const { data } = await response.json();
const embeddings: number[][] = data.map((d: any) => d.embedding);
```

**Jina limitations:**
- Token-based pricing with top-up model: no monthly subscription, no enterprise SLA
- v5-omni models are 0.9-1.6B — not suitable for CPU-only Ollama deployment
- The LoRA adapter mechanism adds inference complexity if you switch tasks mid-stream
- Rate limits are strict at free tier (100 RPM / 100K TPM)

**Recommendation:** Jina v5-text is worth evaluating specifically for its 32K context, which could replace chunking entirely for SharePoint Wiki pages. The practical test: embed a full 15,000-token Vodacom intranet page as a single vector and compare retrieval quality vs. the same page chunked at 512 tokens.

---

## 6. Self-Hosted via Ollama

Source: https://ollama.com/library, https://ollama.com/blog/embedding-models

Ollama makes embedding models trivially deployable with a REST API on port 11434. All models available via `ollama pull <model>`.

### Embedding models in the Ollama library (August 2026)

| Model | Tag | Params | Ollama Pulls | Notes |
|-------|-----|--------|-------------|-------|
| nomic-embed-text | embedding | 137M | 83.5M | English, 8192 context |
| mxbai-embed-large | embedding, 335m | 335M | 14M | English, 512 context |
| bge-m3 | embedding, 567m | 568M | 6.1M | 100+ languages, 8192 context |
| snowflake-arctic-embed | embedding, 22m/33m/110m/137m/335m | 22-335M | 3.1M | Multiple sizes |
| all-minilm | embedding, 22m/33m | 22-33M | 3.4M | Minimal, dev only |
| qwen3-embedding | embedding, 0.6b/4b/8b | 600M-8B | 3.7M | New, multilingual |
| embeddinggemma | embedding, 300m | 300M | 1.9M | Google, 300M |

### Ollama REST API for embeddings

```typescript
interface OllamaEmbedRequest {
  model: string;
  input: string | string[];  // single string or array
  options?: {
    num_ctx?: number;    // override context window
    temperature?: number;  // not meaningful for embeddings, ignore
  };
}

interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];  // array of embedding arrays
  total_duration: number;
  load_duration: number;
  prompt_eval_count: number;
}

async function embedWithOllama(
  texts: string | string[],
  model = 'bge-m3',
  baseUrl = 'http://localhost:11434'
): Promise<number[][]> {
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: texts,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama embed error ${response.status}: ${error}`);
  }
  
  const data: OllamaEmbedResponse = await response.json();
  return data.embeddings;
}
```

### Model-specific prefix requirements for Ollama

Not all Ollama embedding models handle the query/document asymmetry automatically:

| Model | Query prefix | Document prefix | Notes |
|-------|-------------|-----------------|-------|
| nomic-embed-text | `search_query: ` | `search_document: ` | Mandatory prefixes |
| mxbai-embed-large | `Represent this sentence for searching relevant passages: ` | (none) | Query only |
| bge-m3 | (none) | (none) | No prefixes needed |
| qwen3-embedding | `Instruct: <task>\nQuery: ` | (none) | Instruction on query only |
| all-minilm | (none) | (none) | Symmetric model |

**This is the most common production bug with Ollama embeddings.** Missing the prefix causes 5-15% NDCG degradation. Always abstract prefix injection behind your embedding client.

```typescript
type EmbedRole = 'document' | 'query';
type OllamaModel = 'nomic-embed-text' | 'mxbai-embed-large' | 'bge-m3' | 'qwen3-embedding';

const OLLAMA_PREFIXES: Record<OllamaModel, Record<EmbedRole, string>> = {
  'nomic-embed-text': {
    document: 'search_document: ',
    query: 'search_query: ',
  },
  'mxbai-embed-large': {
    document: '',
    query: 'Represent this sentence for searching relevant passages: ',
  },
  'bge-m3': {
    document: '',
    query: '',
  },
  'qwen3-embedding': {
    document: '',
    query: 'Instruct: Given a question, retrieve relevant passages that answer the question\nQuery: ',
  },
};

function applyPrefix(text: string, model: OllamaModel, role: EmbedRole): string {
  const prefix = OLLAMA_PREFIXES[model]?.[role] ?? '';
  return prefix + text;
}
```

### Ollama performance expectations (CPU inference)

Testing environment: M2 Mac Pro / AMD EPYC server, INT8 model weights, single-threaded

| Model | CPU embed time/chunk (400 tokens) | GPU embed time/chunk |
|-------|-----------------------------------|-----------------------|
| all-minilm-22m | ~5ms | ~2ms |
| nomic-embed-text | ~40ms | ~8ms |
| mxbai-embed-large | ~80ms | ~12ms |
| bge-m3 | ~120ms | ~15ms |
| qwen3-embedding-0.6b | ~150ms | ~18ms |

A corpus of 50,000 chunks:
- nomic-embed-text CPU: ~33 minutes
- bge-m3 CPU: ~100 minutes
- bge-m3 GPU (A10G): ~12 minutes

Initial indexing is typically done once. This latency is acceptable for a background worker on first setup.

### Ollama deployment modes for this project

**Development:** Run Ollama on the developer's machine, point the MCP server at `http://localhost:11434`.

**Production — Docker Compose:**

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    volumes:
      - ollama-models:/root/.ollama
    ports:
      - "11434:11434"
    environment:
      - OLLAMA_KEEP_ALIVE=24h  # keep model loaded in memory
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11434/api/version"]
      interval: 30s
      timeout: 10s
      retries: 3

  ollama-init:
    image: ollama/ollama:latest
    volumes:
      - ollama-models:/root/.ollama
    depends_on:
      ollama:
        condition: service_healthy
    entrypoint: >
      sh -c "ollama pull bge-m3 && echo 'bge-m3 ready'"
    environment:
      - OLLAMA_HOST=http://ollama:11434

volumes:
  ollama-models:
```

**Limitation:** Ollama does not support concurrent embedding requests well. If your background worker sends 10 parallel embed requests, they queue. For high-throughput indexing, use TEI instead.

---

## 7. HuggingFace Text Embeddings Inference (TEI)

Source: https://huggingface.co/docs/text-embeddings-inference/quick_tour

TEI is HuggingFace's production-grade embedding server. It is the right choice when you need:
- High throughput (multiple concurrent requests)
- GPU acceleration (CUDA 12.2+)
- OpenAI-compatible `/v1/embeddings` endpoint
- Enterprise-grade batching and request queuing

### Deployment

TEI uses Docker images from `ghcr.io/huggingface/text-embeddings-inference`. Select the tag for your hardware:

| Tag | Hardware | Notes |
|-----|----------|-------|
| `cpu-1.9` | CPU only | Slow but works anywhere |
| `cuda-1.9` | NVIDIA GPU (CUDA 12.2+) | Primary production target |
| `cuda-1.9-flash-attn` | Ampere+ GPU | Flash Attention for speed |

**Deploy bge-m3 on GPU:**

```bash
model=BAAI/bge-m3
volume=$PWD/data

docker run --gpus all \
  -p 8080:80 \
  -v $volume:/data \
  --pull always \
  ghcr.io/huggingface/text-embeddings-inference:cuda-1.9 \
  --model-id $model \
  --max-batch-tokens 16384 \
  --max-concurrent-requests 512 \
  --auto-truncate
```

**Deploy nomic-embed-text on CPU:**

```bash
model=nomic-ai/nomic-embed-text-v1.5
volume=$PWD/data

docker run \
  -p 8080:80 \
  -v $volume:/data \
  --pull always \
  ghcr.io/huggingface/text-embeddings-inference:cpu-1.9 \
  --model-id $model \
  --max-batch-tokens 8192 \
  --max-concurrent-requests 64
```

### TEI REST API

TEI exposes both its native API and an OpenAI-compatible API:

**Native API** (fastest, proprietary):

```typescript
// POST /embed — batch embedding
const response = await fetch('http://localhost:8080/embed', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    inputs: ['text one', 'text two'],  // string[]
    normalize: true,                   // L2 normalize
    truncate: false,                   // fail if too long (or auto-truncate with --auto-truncate flag)
    prompt_name: 'query',             // for models with named prompts
  }),
});
const embeddings: number[][] = await response.json();
```

**OpenAI-compatible API** (works with existing openai SDK):

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8080/v1',
  apiKey: '-',  // TEI doesn't require a real key
});

const response = await client.embeddings.create({
  model: 'text-embeddings-inference',  // ignored by TEI, uses deployed model
  input: ['text to embed'],
  encoding_format: 'float',
});
const embedding = response.data[0].embedding;
```

### TEI throughput benchmarks

From HuggingFace documentation (representative numbers, not official):

| Hardware | Model | Throughput (docs/sec) |
|----------|-------|----------------------|
| CPU (32 cores) | nomic-embed-text | ~50 |
| CPU (32 cores) | bge-m3 | ~20 |
| A10G GPU | nomic-embed-text | ~1,200 |
| A10G GPU | bge-m3 | ~600 |
| A100 GPU | bge-m3 | ~2,000 |

For a 50,000-chunk corpus:
- A10G GPU with bge-m3: ~1.4 minutes
- CPU-only: ~42 minutes

### Air-gapped enterprise deployment

Vodacom SA enterprise environments often restrict internet access from production. TEI supports this:

```bash
# Pre-download model weights on a machine with internet access
git lfs install
git clone https://huggingface.co/BAAI/bge-m3 /offline-models/bge-m3

# Transfer /offline-models to air-gapped environment
# Mount the local model directory instead of downloading from HF

docker run --gpus all \
  -p 8080:80 \
  -v /offline-models:/data \
  ghcr.io/huggingface/text-embeddings-inference:cuda-1.9 \
  --model-id /data/bge-m3 \
  --max-batch-tokens 16384
```

### TEI vs Ollama comparison for this project

| Factor | TEI | Ollama |
|--------|-----|--------|
| Throughput | High (GPU-optimized, concurrent) | Low (sequential, single model) |
| Model selection | HuggingFace Hub (thousands of models) | Curated library (~10 embedding models) |
| Concurrent requests | Yes (configurable queue) | No (serialized) |
| GPU support | Native, well-tested | Supported but not primary focus |
| CPU support | Yes | Primary mode |
| Developer experience | Docker only | Single binary, `ollama pull` |
| OpenAI-compatible API | Yes (`/v1/embeddings`) | Yes (`/api/embed` + `/v1/embeddings`) |
| Air-gapped | Yes (volume mount) | Yes (model files in `~/.ollama`) |

**Decision rule:** Use Ollama for development and single-tenant deployments. Use TEI for production multi-tenant deployments where >1 user is indexing simultaneously or querying >5 req/sec.

---

## 8. Transformers.js — ONNX in Node.js

Source: https://huggingface.co/docs/transformers.js/index

Transformers.js runs HuggingFace models directly in Node.js or the browser using ONNX Runtime. This is the only option for embedding inside the MCP server process without spawning a child process or calling an external service.

### When to use Transformers.js

**Use it when:**
- You want zero external dependencies (no Ollama, no TEI, no cloud API)
- The MCP server itself handles embedding for real-time query embedding
- Development environment where Ollama is not installed

**Do not use it when:**
- Embedding large document corpora (background indexing worker)
- You need GPU acceleration on the embedding path
- Memory is constrained (a 337M model loaded as ONNX takes ~400MB RAM)

### Installation and basic usage

```bash
npm install @huggingface/transformers
```

```typescript
import { pipeline, FeatureExtractionPipeline } from '@huggingface/transformers';

let embedder: FeatureExtractionPipeline | null = null;

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedder) {
    embedder = await pipeline(
      'feature-extraction',
      'Snowflake/snowflake-arctic-embed-l-v2.0',
      {
        dtype: 'q8',        // INT8 quantization — fast on CPU, minimal quality loss
        device: 'cpu',      // 'cpu' | 'webgpu' (browser only for WebGPU)
      }
    );
  }
  return embedder;
}

async function embedQuery(text: string): Promise<number[]> {
  const extractor = await getEmbedder();
  // Snowflake Arctic needs 'query: ' prefix for queries
  const result = await extractor(`query: ${text}`, {
    pooling: 'cls',       // 'cls' | 'mean' — model-dependent
    normalize: true,
  });
  return Array.from(result.data as Float32Array);
}

async function embedDocument(text: string): Promise<number[]> {
  const extractor = await getEmbedder();
  // No prefix for documents
  const result = await extractor(text, {
    pooling: 'cls',
    normalize: true,
  });
  return Array.from(result.data as Float32Array);
}
```

### Model selection for Transformers.js

Not all models in the ONNX ecosystem have pre-quantized ONNX exports on HuggingFace. Models that work well with Transformers.js:

| Model | ONNX available | q8 available | Notes |
|-------|---------------|-------------|-------|
| nomic-ai/nomic-embed-text-v1.5 | Yes | Yes | Transformers.js explicitly supported |
| mixedbread-ai/mxbai-embed-large-v1 | Yes | Yes | ONNX + OpenVINO exports |
| Snowflake/snowflake-arctic-embed-l-v2.0 | Yes | Yes | Transformers.js tag on model card |
| intfloat/multilingual-e5-large-instruct | Yes | Yes | Standard ONNX export |
| BAAI/bge-m3 | Yes | Partial | Full model; ColBERT weights not in ONNX |

### Quantization modes for Node.js CPU

| dtype | Size relative to fp32 | Inference speed | Quality |
|-------|----------------------|-----------------|---------|
| fp32 | 1x | Baseline | Full |
| fp16 | 0.5x | ~1.3x faster | ~99.9% |
| q8 | 0.25x | ~2-3x faster | ~99.5% |
| q4 | 0.125x | ~4x faster | ~97-98% |

For production Node.js embedding: **q8 is the correct choice.** It runs well on CPUs without AVX512, the quality loss is negligible for enterprise retrieval, and the memory footprint is small enough to not cause GC pressure.

### Handling the first-load problem

Transformers.js downloads ONNX model files from HuggingFace Hub on first use (~300-600MB for a 335M-param model). This is unacceptable in production.

**Solution: Pre-bake models into the Docker image:**

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Pre-download ONNX model files during build
RUN node -e "
const { pipeline } = require('@huggingface/transformers');
pipeline('feature-extraction', 'Snowflake/snowflake-arctic-embed-l-v2.0', {
  dtype: 'q8',
  cache_dir: '/app/model-cache'
}).then(() => process.exit(0));
"

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/model-cache /app/model-cache
COPY --from=builder /app/node_modules ./node_modules
COPY . .

ENV HF_HOME=/app/model-cache
CMD ["node", "dist/server.js"]
```

Alternatively, use an environment variable to point to a local model directory:

```typescript
import { env } from '@huggingface/transformers';

// Point to local model files — no internet required at runtime
env.localModelPath = '/app/model-cache';
env.allowRemoteModels = false;  // Fail if model not found locally
```

### Node.js performance characteristics with Transformers.js

- **Cold start** (model loading): 2-8 seconds for a 300-500MB q8 model
- **Warm inference** (single document, 400 tokens): 50-200ms CPU
- **Warm inference** (batch of 32, 400 tokens each): 400-800ms CPU
- **Memory**: ~400-800MB resident for a 300-500M q8 model

**Do not use Transformers.js for background indexing.** The single-threaded Node.js event loop blocks during inference even with ONNX Runtime. Use it for real-time query embedding only, where you accept 50-200ms latency per query.

---

## 9. ONNX Quantization Deep Dive

Source: https://huggingface.co/blog/embedding-quantization, sentence-transformers docs

### Two distinct quantization concepts — do not confuse them

1. **Model weight quantization (ONNX/INT8):** Reduces precision of model weights from FP32 to INT8. Speeds up inference. Applied once at export time. This is what `dtype: 'q8'` does in Transformers.js.

2. **Embedding output quantization (Binary/Int8 quantization):** Reduces precision of the embedding vectors themselves from FP32 to binary (1-bit) or INT8 (8-bit). Reduces storage and enables faster ANN search. Applied as a post-processing step after inference.

Both are complementary. You can use INT8 model weights AND binary embedding storage simultaneously.

### Embedding output quantization details

From HuggingFace blog (https://huggingface.co/blog/embedding-quantization):

| Vector Format | Bits/dim | Storage for 100M × 1024-dim | Cost at $3.8/GB/mo | Quality vs float32 |
|---------------|---------|-----------------------------|--------------------|---------------------|
| float32 | 32 | 381 GB | $1,449/mo | 100% |
| int8 | 8 | 95 GB | $361/mo | ~99.5% |
| binary (packed) | 1 | ~12 GB | ~$46/mo | ~96% (with rescoring) |
| binary (no rescore) | 1 | ~12 GB | ~$46/mo | ~92.5% |

**Binary quantization formula:**

```
f(x) = 0 if x <= 0
f(x) = 1 if x > 0
```

Store as packed bytes (1024 float32 dims → 128 uint8 values).

**Sentence-transformers TypeScript (via Python bridge or Node.js):**

```typescript
// Node.js implementation of binary quantization
function quantizeToBinary(embedding: Float32Array): Uint8Array {
  const bits = embedding.length;
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  
  for (let i = 0; i < bits; i++) {
    if (embedding[i] > 0) {
      bytes[Math.floor(i / 8)] |= (1 << (7 - (i % 8)));
    }
  }
  
  return bytes;
}

function quantizeToInt8(embedding: Float32Array): Int8Array {
  const int8 = new Int8Array(embedding.length);
  
  // Find min and max for scaling
  let min = Infinity, max = -Infinity;
  for (const v of embedding) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  
  const scale = 127 / Math.max(Math.abs(min), Math.abs(max));
  
  for (let i = 0; i < embedding.length; i++) {
    int8[i] = Math.round(embedding[i] * scale);
  }
  
  return int8;
}

// Hamming distance for binary embedding similarity
function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = a[i] ^ b[i];
    // Count bits with Brian Kernighan's algorithm
    while (xor !== 0) {
      xor &= xor - 1;
      distance++;
    }
  }
  return distance;
}
```

### Binary rescoring pattern (critical for quality)

Binary retrieval alone loses ~7.5% quality. The standard production pattern uses binary embeddings for fast ANN recall (find top-k × rescore_multiplier candidates), then reranks those candidates using the original float32 query embedding:

```typescript
interface BinaryRescorer {
  binaryQuery: Uint8Array;
  float32Query: Float32Array;
  rescoreMultiplier: number;  // typically 4-10
}

async function hybridBinarySearch(
  query: string,
  embeddingFn: (text: string) => Promise<Float32Array>,
  vectorStore: VectorStore,
  topK = 10,
  rescoreMultiplier = 5
): Promise<SearchResult[]> {
  const float32Query = await embeddingFn(query);
  const binaryQuery = quantizeToBinary(float32Query);
  
  // Step 1: Fast binary search to get candidate set
  const candidates = await vectorStore.binarySearch(
    binaryQuery,
    topK * rescoreMultiplier
  );
  
  // Step 2: Rescore candidates with float32 dot product
  const rescored = candidates.map(candidate => ({
    ...candidate,
    score: dotProduct(float32Query, candidate.float32Embedding),
  }));
  
  // Step 3: Return top-k after rescoring
  return rescored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
```

### pgvector quantization (the practical storage path)

For this project, we use pgvector in PostgreSQL. pgvector supports:

```sql
-- Standard float32 vector column
ALTER TABLE document_chunks ADD COLUMN embedding vector(1024);
CREATE INDEX ON document_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Half-precision float16 (pgvector 0.7+)
ALTER TABLE document_chunks ADD COLUMN embedding_f16 halfvec(1024);

-- Binary quantization (pgvector 0.7+)
ALTER TABLE document_chunks ADD COLUMN embedding_binary bit(1024);
CREATE INDEX ON document_chunks USING ivfflat (embedding_binary bit_hamming_ops)
  WITH (lists = 100);
```

**Recommended for Phase 2:** Store both full float32 embeddings AND binary embeddings. Use binary for fast ANN retrieval to get 50-100 candidates, then rescore with float32. This gives fast queries AND high accuracy.

```sql
-- Schema recommendation
CREATE TABLE document_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   UUID NOT NULL,
  chunk_index INTEGER NOT NULL,
  content     TEXT NOT NULL,
  language    VARCHAR(10),          -- ISO 639-3 code
  embedding   vector(1024),        -- full float32 for rescoring
  emb_binary  bit(1024),           -- binary for fast recall
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  
  -- ACL enforcement via Entra ID group IDs
  allowed_groups TEXT[]             -- transitiveMemberOf group IDs
);

-- Index for fast binary ANN
CREATE INDEX idx_chunks_binary ON document_chunks 
  USING ivfflat (emb_binary bit_hamming_ops) WITH (lists = 100);

-- Index for cosine similarity rescoring
CREATE INDEX idx_chunks_cosine ON document_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Index for ACL-filtered queries
CREATE INDEX idx_chunks_groups ON document_chunks USING GIN (allowed_groups);
```

---

## 10. Dimensionality and Storage Analysis

### Storage cost at Vodacom enterprise scale

Assumptions: 50,000 SharePoint/Confluence chunks, growing to 500,000 over 2 years.

| Dimensions | Format | 50K chunks | 500K chunks | pgvector index size (approx) |
|-----------|--------|-----------|------------|------------------------------|
| 384 (MiniLM) | float32 | 74 MB | 740 MB | ~100 MB |
| 768 (nomic, bge-base) | float32 | 147 MB | 1.47 GB | ~200 MB |
| 1024 (bge-m3, arctic) | float32 | 196 MB | 1.96 GB | ~280 MB |
| 1024 | int8 | 49 MB | 490 MB | ~70 MB |
| 1024 | binary (packed) | 6.1 MB | 61 MB | ~10 MB |
| 1536 (OAI small) | float32 | 294 MB | 2.94 GB | ~420 MB |
| 3072 (OAI large) | float32 | 588 MB | 5.88 GB | ~840 MB |
| 3584 (gte-Qwen2) | float32 | 686 MB | 6.86 GB | ~980 MB |

**Conclusion:** At 500K chunks (reasonable for a medium enterprise), even float32 at 1024 dimensions is only 1.96 GB of raw vector data. The index overhead is ~40% on top. Total pgvector footprint: ~3 GB. This is not a storage problem at this scale.

The case for binary embeddings at Vodacom scale is about **query latency**, not storage costs. Binary ANN with Hamming distance is ~10-30x faster than float32 cosine ANN at the same recall.

### Matryoshka Representation Learning (MRL) — when to use it

MRL trains the model so that the first N dimensions of the embedding already form a meaningful representation. You can truncate to any N without retraining.

**Models with MRL support:**

| Model | Full dim | Min MRL dim | Quality at min dim |
|-------|---------|------------|-------------------|
| nomic-embed-text-v1.5 | 768 | 64 | MTEB 54.35 at 64d |
| nomic-embed-text-v1.5 | 768 | 128 | MTEB 59.34 |
| nomic-embed-text-v1.5 | 768 | 256 | MTEB 61.04 |
| nomic-embed-text-v1.5 | 768 | 512 | MTEB 61.96 |
| mxbai-embed-large-v1 | 1024 | 512 | ~64.0 |
| snowflake-arctic-embed-l-v2.0 | 1024 | 256 | BEIR 54.3 (-1.3%) |
| text-embedding-3-large (OpenAI) | 3072 | 256 | ~93.1% performance retention |
| Cohere embed-v4.0 | 4096 | 256 | ~95% retention |

**TypeScript MRL truncation:**

```typescript
function truncateEmbedding(embedding: number[], targetDim: number): number[] {
  if (embedding.length < targetDim) {
    throw new Error(`Embedding (${embedding.length}d) is smaller than target (${targetDim}d)`);
  }
  
  // For MRL models: truncate, then re-normalize
  const truncated = embedding.slice(0, targetDim);
  
  // L2 re-normalization after truncation
  const norm = Math.sqrt(truncated.reduce((sum, v) => sum + v * v, 0));
  return truncated.map(v => v / norm);
}
```

**When to use MRL truncation for this project:**

- Start with full 1024 dimensions during initial deployment (no MRL)
- If pgvector query latency exceeds 50ms at 500K+ chunks, truncate to 512 and re-index
- Never truncate below 256 for enterprise retrieval — quality degradation becomes noticeable

---

## 11. Integration Patterns for This Project

### Two-phase embedding architecture

The markdown-for-agents-mcp server has two distinct embedding use cases:

1. **Ingest-time (background worker):** Embed SharePoint/Confluence document chunks as they are indexed. High throughput, latency-tolerant, can use GPU or batch API.
2. **Query-time (real-time):** Embed user queries as they arrive. Low throughput but latency-critical — must complete in <100ms to not add visible delay to agent tool calls.

These two paths should use different embedding configurations:

```typescript
// embedding-config.ts
export interface EmbeddingProvider {
  name: string;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  dimensions: number;
}

// Provider factory based on environment
export function createEmbeddingProvider(): EmbeddingProvider {
  const provider = process.env.EMBEDDING_PROVIDER ?? 'ollama';
  
  switch (provider) {
    case 'openai':
      return new OpenAIEmbeddingProvider({
        model: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-large',
        dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS ?? '1024'),
      });
    case 'cohere':
      return new CohereEmbeddingProvider({
        model: 'embed-v4.0',
        outputDimension: parseInt(process.env.EMBEDDING_DIMENSIONS ?? '1024'),
      });
    case 'ollama':
      return new OllamaEmbeddingProvider({
        model: process.env.OLLAMA_EMBEDDING_MODEL ?? 'bge-m3',
        baseUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
      });
    case 'tei':
      return new TEIEmbeddingProvider({
        baseUrl: process.env.TEI_URL ?? 'http://localhost:8080',
      });
    case 'local':  // Transformers.js ONNX in-process
      return new LocalONNXEmbeddingProvider({
        model: process.env.LOCAL_EMBEDDING_MODEL ?? 'Snowflake/snowflake-arctic-embed-l-v2.0',
        dtype: 'q8',
        cacheDir: process.env.MODEL_CACHE_DIR ?? '/app/model-cache',
      });
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}
```

### Handling embedding provider failures

```typescript
// Retry wrapper with exponential backoff for transient API failures
export class ResilientEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private inner: EmbeddingProvider,
    private maxRetries = 3,
    private baseDelayMs = 500
  ) {}

  get dimensions() { return this.inner.dimensions; }
  get name() { return `resilient(${this.inner.name})`; }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.withRetry(() => this.inner.embedDocuments(texts));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.withRetry(() => this.inner.embedQuery(text));
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        
        // Do not retry on non-retryable errors
        if (err instanceof Error && err.message.includes('invalid_api_key')) {
          throw err;
        }
        
        if (attempt < this.maxRetries) {
          const delay = this.baseDelayMs * Math.pow(2, attempt);
          const jitter = Math.random() * delay * 0.1;
          await new Promise(resolve => setTimeout(resolve, delay + jitter));
        }
      }
    }
    
    throw new Error(
      `Embedding failed after ${this.maxRetries} retries: ${lastError?.message}`
    );
  }
}
```

### Rate limiting for API-based providers

```typescript
import PQueue from 'p-queue';

export class RateLimitedEmbeddingProvider implements EmbeddingProvider {
  private queue: PQueue;
  
  constructor(
    private inner: EmbeddingProvider,
    requestsPerMinute: number
  ) {
    this.queue = new PQueue({
      interval: 60000,
      intervalCap: requestsPerMinute,
      concurrency: 5,  // max parallel in-flight requests
    });
  }

  get dimensions() { return this.inner.dimensions; }
  get name() { return `rate-limited(${this.inner.name})`; }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.queue.add(() => this.inner.embedDocuments(texts)) as Promise<number[][]>;
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.queue.add(() => this.inner.embedQuery(text)) as Promise<number[]>;
  }
}

// Usage: Cohere allows 10k req/min on paid tier
const provider = new RateLimitedEmbeddingProvider(
  new CohereEmbeddingProvider({ model: 'embed-v4.0', outputDimension: 1024 }),
  10000
);
```

---

## 12. Embedding API Abstraction Layer

A clean abstraction layer that the rest of the codebase uses, regardless of which embedding backend is configured:

```typescript
// src/embeddings/types.ts

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  tokenCount?: number;
}

export interface BatchEmbeddingResult {
  embeddings: number[][];
  model: string;
  totalTokens?: number;
}

export interface EmbeddingClient {
  /** Embed a single query (for search) */
  embedQuery(text: string): Promise<EmbeddingResult>;
  
  /** Embed documents for storage (may use different mode/prefix) */
  embedDocuments(texts: string[]): Promise<BatchEmbeddingResult>;
  
  /** Number of dimensions this client produces */
  readonly dimensions: number;
  
  /** Human-readable provider name for logging */
  readonly providerName: string;
}

// src/embeddings/openai-client.ts
export class OpenAIEmbeddingClient implements EmbeddingClient {
  readonly dimensions: number;
  readonly providerName = 'openai';

  constructor(
    private openai: OpenAI,
    private model: string = 'text-embedding-3-large',
    dimensions: number = 1024
  ) {
    this.dimensions = dimensions;
  }

  async embedQuery(text: string): Promise<EmbeddingResult> {
    const response = await this.openai.embeddings.create({
      model: this.model,
      input: text,
      dimensions: this.dimensions,
      encoding_format: 'float',
    });
    return {
      embedding: response.data[0].embedding,
      model: response.model,
      tokenCount: response.usage.total_tokens,
    };
  }

  async embedDocuments(texts: string[]): Promise<BatchEmbeddingResult> {
    const response = await this.openai.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.dimensions,
      encoding_format: 'float',
    });
    return {
      embeddings: response.data.map(d => d.embedding),
      model: response.model,
      totalTokens: response.usage.total_tokens,
    };
  }
}

// src/embeddings/ollama-client.ts
export class OllamaEmbeddingClient implements EmbeddingClient {
  readonly providerName = 'ollama';
  readonly dimensions: number;

  constructor(
    private baseUrl: string,
    private model: 'nomic-embed-text' | 'bge-m3' | 'mxbai-embed-large' | 'qwen3-embedding',
    dimensions?: number
  ) {
    // Default dimensions per model
    const defaultDims: Record<string, number> = {
      'nomic-embed-text': 768,
      'bge-m3': 1024,
      'mxbai-embed-large': 1024,
      'qwen3-embedding': 2048,
    };
    this.dimensions = dimensions ?? defaultDims[model] ?? 1024;
  }

  async embedQuery(text: string): Promise<EmbeddingResult> {
    const prefixed = applyPrefix(text, this.model as OllamaModel, 'query');
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: [prefixed] }),
    });
    if (!response.ok) throw new Error(`Ollama embed error: ${response.status}`);
    const data = await response.json();
    return { embedding: data.embeddings[0], model: this.model };
  }

  async embedDocuments(texts: string[]): Promise<BatchEmbeddingResult> {
    const prefixed = texts.map(t => applyPrefix(t, this.model as OllamaModel, 'document'));
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: prefixed }),
    });
    if (!response.ok) throw new Error(`Ollama embed error: ${response.status}`);
    const data = await response.json();
    return { embeddings: data.embeddings, model: this.model };
  }
}
```

---

## 13. Background Worker Architecture

Document indexing must not block the MCP server's request handling. The recommended pattern uses a separate process for embedding.

### Queue-based indexing worker

```typescript
// src/indexer/worker.ts — runs as a separate Node.js process

import { createEmbeddingProvider } from '../embeddings/factory.js';
import { connectDb } from '../db/connection.js';

interface IndexJob {
  sourceId: string;
  sourceType: 'sharepoint' | 'confluence';
  content: string;
  title: string;
  url: string;
  allowedGroups: string[];  // Entra ID group IDs from ACL check
}

const BATCH_SIZE = 32;  // embed this many chunks per API call
const CHUNK_SIZE_TOKENS = 400;
const CHUNK_OVERLAP_TOKENS = 50;

async function runIndexWorker() {
  const embedder = createEmbeddingProvider();
  const db = await connectDb();
  
  console.log(`Indexer ready. Provider: ${embedder.name}, dims: ${embedder.dimensions}`);
  
  // Dequeue from pg-boss or BullMQ
  while (true) {
    const jobs = await dequeueJobs<IndexJob>('index-document', BATCH_SIZE);
    if (jobs.length === 0) {
      await sleep(2000);
      continue;
    }
    
    // Chunk all documents
    const allChunks: Array<{ jobId: string; chunkIdx: number; text: string }> = [];
    for (const job of jobs) {
      const chunks = chunkText(job.data.content, CHUNK_SIZE_TOKENS, CHUNK_OVERLAP_TOKENS);
      chunks.forEach((text, chunkIdx) => {
        allChunks.push({ jobId: job.id, chunkIdx, text });
      });
    }
    
    // Batch embed
    const texts = allChunks.map(c => c.text);
    let embeddings: number[][];
    try {
      const result = await embedder.embedDocuments(texts);
      embeddings = result.embeddings;
    } catch (err) {
      console.error('Embedding batch failed:', err);
      await requeueJobs(jobs.map(j => j.id));
      continue;
    }
    
    // Store in pgvector
    await db.transaction(async trx => {
      for (let i = 0; i < allChunks.length; i++) {
        const chunk = allChunks[i];
        const embedding = embeddings[i];
        const job = jobs.find(j => j.id === chunk.jobId)!;
        
        await trx.query(
          `INSERT INTO document_chunks 
           (source_id, chunk_index, content, embedding, allowed_groups, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (source_id, chunk_index) 
           DO UPDATE SET content = $3, embedding = $4, allowed_groups = $5`,
          [
            job.data.sourceId,
            chunk.chunkIdx,
            chunk.text,
            `[${embedding.join(',')}]`,  // pgvector format
            job.data.allowedGroups,
            JSON.stringify({ url: job.data.url, title: job.data.title }),
          ]
        );
      }
    });
    
    await markJobsComplete(jobs.map(j => j.id));
  }
}

function chunkText(text: string, targetTokens: number, overlapTokens: number): string[] {
  // Approximate: 1 token ≈ 4 characters for English
  const targetChars = targetTokens * 4;
  const overlapChars = overlapTokens * 4;
  const chunks: string[] = [];
  
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + targetChars, text.length);
    chunks.push(text.slice(start, end));
    start += targetChars - overlapChars;
    if (start >= text.length) break;
  }
  
  return chunks.filter(c => c.trim().length > 50);  // drop tiny tail chunks
}
```

### ACL-aware query embedding and search

```typescript
// src/search/semantic-search.ts

interface SearchOptions {
  query: string;
  userId: string;
  userGroupIds: string[];  // from Entra ID transitiveMemberOf
  topK?: number;
  minScore?: number;
}

interface SearchResult {
  chunkId: string;
  content: string;
  score: number;
  sourceUrl: string;
  sourceTitle: string;
}

async function semanticSearch(
  options: SearchOptions,
  embedder: EmbeddingClient,
  db: Database
): Promise<SearchResult[]> {
  const { query, userGroupIds, topK = 10, minScore = 0.3 } = options;
  
  // Embed the query
  const { embedding } = await embedder.embedQuery(query);
  const embeddingStr = `[${embedding.join(',')}]`;
  
  // ACL-filtered vector search
  // The ANY(allowed_groups && $2) check ensures the user's groups
  // overlap with the chunk's allowed_groups
  const rows = await db.query(
    `SELECT 
       id,
       content,
       1 - (embedding <=> $1::vector) AS cosine_similarity,
       metadata->>'url' AS source_url,
       metadata->>'title' AS source_title
     FROM document_chunks
     WHERE 
       allowed_groups && $2::text[]  -- ACL check: user's groups intersect chunk's groups
       AND 1 - (embedding <=> $1::vector) >= $3
     ORDER BY embedding <=> $1::vector
     LIMIT $4`,
    [embeddingStr, userGroupIds, minScore, topK]
  );
  
  return rows.map(row => ({
    chunkId: row.id,
    content: row.content,
    score: parseFloat(row.cosine_similarity),
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
  }));
}
```

**Critical ACL note:** The `allowed_groups && $2::text[]` operator uses PostgreSQL array overlap (&&). The `allowed_groups` column stores the list of Entra ID group IDs that have at least read access to the source document. This is populated at ingest time by calling the Microsoft Graph API `transitiveMemberOf`. When a user's effective group list overlaps with a chunk's allowed groups, the chunk is returned.

---

## 14. Failure Modes and Edge Cases

### Token limit exceeded

**What happens:** bge-m3 has 8192 token max. mxbai-embed-large has only 512 tokens. If you send a 1000-token chunk to mxbai, it silently truncates.

**How to detect:**

```typescript
// Rough token count — use tiktoken for accuracy
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function validateChunkForModel(text: string, modelMaxTokens: number): void {
  const estimate = estimateTokenCount(text);
  if (estimate > modelMaxTokens * 0.9) {  // 90% safety margin
    throw new Error(
      `Chunk too long: ~${estimate} tokens, model max ${modelMaxTokens}. ` +
      `Split this chunk before embedding.`
    );
  }
}
```

**TEI handles this:** with `--auto-truncate` flag, TEI silently truncates. This is acceptable for documents but wrong for queries. Disable auto-truncate on the query path and validate input length instead.

### Empty or near-empty chunks

Documents with only whitespace, tables with no text content, or HTML that strips to nothing generate near-zero vectors. These waste storage and pollute nearest-neighbor results.

```typescript
function isValidChunk(text: string): boolean {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 50) return false;  // too short
  if (cleaned.split(' ').length < 10) return false;  // too few words
  return true;
}
```

### Embedding drift when switching models

If you switch from nomic-embed-text to bge-m3 mid-deployment, all existing vectors in pgvector are incompatible with the new model. You must re-embed the entire corpus.

**Solution:** store the model identifier with each chunk:

```sql
ALTER TABLE document_chunks ADD COLUMN embedding_model VARCHAR(100) NOT NULL;
ALTER TABLE document_chunks ADD COLUMN embedding_dimensions INTEGER NOT NULL;
```

Expose a re-indexing job that filters by `WHERE embedding_model != $current_model`.

### Ollama model not loaded (cold start)

Ollama loads models lazily. First embedding request after `ollama pull` triggers a 5-30 second load time.

```typescript
// Warm up the model at worker startup, before accepting jobs
async function warmUpOllamaModel(baseUrl: string, model: string): Promise<void> {
  console.log(`Warming up ${model}...`);
  const start = Date.now();
  
  await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: ['warmup'] }),
  });
  
  console.log(`${model} warm in ${Date.now() - start}ms`);
}
```

### Cohere rate limiting (429)

Cohere's default paid tier allows 10k requests/minute but bursts can trigger 429 responses during initial corpus indexing. Always implement exponential backoff. See `ResilientEmbeddingProvider` above.

### Dimension mismatch in pgvector

If you insert a 768-dim vector into a `vector(1024)` column, pgvector throws an error. This happens when:
- You change embedding models between chunks of the same table
- Your Matryoshka truncation code has an off-by-one

Always assert dimensions before insert:

```typescript
function assertEmbeddingDimensions(embedding: number[], expected: number): void {
  if (embedding.length !== expected) {
    throw new Error(
      `Embedding dimension mismatch: got ${embedding.length}, expected ${expected}. ` +
      `Check EMBEDDING_DIMENSIONS env var and model configuration.`
    );
  }
}
```

### Unicode and encoding issues

SharePoint and Confluence content may contain:
- Non-breaking spaces (U+00A0) that confuse tokenizers
- Right-to-left marks in documents with Arabic sections
- Windows-1252 encoded content that got mis-decoded as UTF-8

Clean content before embedding:

```typescript
function normalizeTextForEmbedding(text: string): string {
  return text
    .normalize('NFC')                    // Unicode normalization
    .replace(/ /g, ' ')            // non-breaking space → regular space
    .replace(/​/g, '')             // zero-width space → nothing
    .replace(/‎|‏/g, '')      // LTR/RTL marks → nothing
    .replace(/[ --]/g, '')  // control chars
    .trim();
}
```

### SharePoint HTML stripping artifacts

SharePoint pages export as HTML. HTML-to-text conversion often leaves structural noise:

```
Navigation menu Skip to main content Home About Finance Reports Download Share...
```

This is navigational chrome, not document content. The embedding of this noise degrades retrieval because the chunk's semantic meaning is diluted.

**Fix:** Use a proper HTML-to-Markdown converter (Turndown or `@mozilla/readability`) and strip navigation sections using DOM parsing before chunking.

### All-zero embeddings

Some models (especially locally-hosted via Ollama on under-resourced hardware) can return all-zero or near-zero embeddings under memory pressure. These are silent failures — the embedding API returns 200 OK with invalid data.

```typescript
function validateEmbeddingOutput(embedding: number[]): void {
  const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  
  if (magnitude < 1e-6) {
    throw new Error('Received near-zero embedding — likely model or inference error');
  }
  
  if (!Number.isFinite(magnitude)) {
    throw new Error('Received non-finite embedding values (NaN or Inf)');
  }
}
```

---

## 15. Recommended Model Stack for Vodacom SA

### The recommendation: tiered by deployment context

#### Development environment (laptop)

```
EMBEDDING_PROVIDER=ollama
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
OLLAMA_URL=http://localhost:11434
EMBEDDING_DIMENSIONS=768
```

Rationale: nomic-embed-text is 137M, fast on CPU, has 8192-token context for long wiki pages, and has 83.5M Ollama downloads meaning excellent community support. Good enough for development purposes.

#### Production — English-primary enterprise (Phase 2 MVP)

```
EMBEDDING_PROVIDER=tei
TEI_URL=http://embedding-service:8080
EMBEDDING_DIMENSIONS=1024
# Model: nomic-embed-text-v1.5
```

TEI running nomic-embed-text-v1.5 on CPU gives the simplest production deployment. Add a GPU container later if indexing volume grows. The 8192-token context means most SharePoint wiki pages can be indexed as single chunks — dramatically simplifying the chunking logic.

#### Production — Multilingual enterprise (Phase 2 with SA language support)

```
EMBEDDING_PROVIDER=tei
TEI_URL=http://embedding-service:8080
EMBEDDING_DIMENSIONS=1024
# Model: BAAI/bge-m3 OR Snowflake/snowflake-arctic-embed-l-v2.0
```

**Decision between BGE-M3 and Snowflake Arctic v2.0:**

| Factor | BGE-M3 | Snowflake Arctic L v2.0 |
|--------|--------|------------------------|
| BEIR (English) | 48.8 | 55.6 |
| MIRACL (multilingual) | 56.8 | 55.8 |
| Context window | 8192 | 8192 |
| Dimensions | 1024 | 1024 (MRL to 256) |
| Hybrid retrieval (dense+sparse) | Yes (unique feature) | Dense only |
| License | MIT | Apache 2.0 |
| Params | 568M | 568M |
| South African languages | Better (more multilingual data) | Good (74 languages via XLM-R) |

**For Vodacom SA: use BGE-M3.** The hybrid dense+sparse retrieval is the decisive factor. When an Afrikaans employee searches for "verlofaansoek prosedures" (leave application procedures), the sparse retrieval path will match on the exact Afrikaans terms even if the dense embedding is imperfect. This graceful degradation on low-resource languages is exactly what you need.

#### Production — Maximum retrieval quality, cloud-based

```
EMBEDDING_PROVIDER=cohere
COHERE_API_KEY=<key>
EMBEDDING_DIMENSIONS=1024
```

Cohere embed-v4.0 with `input_type` differentiation. Use this if:
- Data residency allows sending document content to Cohere's API
- Cost is not a concern ($0.10/1M tokens at Vodacom's scale is minimal)
- You want explicit multilingual coverage commitments from a vendor

#### Phase 2 recommended production stack

```yaml
# docker-compose.production.yml

services:
  embedding-service:
    image: ghcr.io/huggingface/text-embeddings-inference:cpu-1.9
    volumes:
      - /opt/models:/data
    command: >
      --model-id /data/bge-m3
      --max-batch-tokens 65536
      --max-concurrent-requests 128
      --auto-truncate
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:80/health"]
      interval: 30s
      timeout: 10s
      retries: 5
    restart: unless-stopped
    
  # Optional: Add GPU support later
  # deploy:
  #   resources:
  #     reservations:
  #       devices:
  #         - driver: nvidia
  #           count: 1
  #           capabilities: [gpu]
```

**Pre-download the model before deployment:**

```bash
# Run on a machine with internet access, or via CI
docker run --rm \
  -v /opt/models:/data \
  -e HF_TOKEN="${HF_TOKEN}" \
  ghcr.io/huggingface/text-embeddings-inference:cpu-1.9 \
  text-embeddings-router download-weights \
  --model-id BAAI/bge-m3 \
  --revision main
```

---

## 16. What to Build vs What to Skip

### Build (in priority order)

**1. EmbeddingClient abstraction with provider switching (Week 1)**
Write the interface, implement OpenAI and Ollama adapters, wire to environment variables. This unlocks everything else. Test with a 100-document corpus.

**2. BGE-M3 via TEI for production (Week 1-2)**
Docker Compose service with pre-baked model weights. CPU-only first, GPU later. This becomes the primary embedding backend.

**3. pgvector schema with ACL columns (Week 1-2)**
The `allowed_groups TEXT[]` column populated from Entra ID transitiveMemberOf is the core of the Phase 2 security model. Get this right from day one.

**4. Chunking pipeline with language detection (Week 2)**
Chunk SharePoint/Confluence content, detect language (franc), validate chunk quality, embed in batches of 32. Store language tag with each chunk.

**5. Hybrid BM25 + vector search (Week 3-4)**
Add BM25 (pg_bm25 extension or custom inverted index) alongside vector search. This hybrid approach significantly improves retrieval for exact-term queries (model names, policy codes, Afrikaans/Zulu terminology). BGE-M3's sparse retrieval output can feed this directly.

**6. Binary quantization for the recall phase (Week 4-5)**
Dual-column storage: float32 for rescoring, binary (packed uint8) for fast candidate recall. Add Hamming distance index. This keeps query latency <20ms at 500K chunks.

### Skip (at least for Phase 2)

**7B LLM-backed embeddings (gte-Qwen2-7B-instruct)**
The 5.3-point MTEB gain over mxbai-embed-large does not justify 14GB GPU VRAM, 10x slower inference, and 3.5x larger vector dimensions. Revisit only if specific retrieval failures are traced to embedding quality.

**Jina v5-text for production**
Jina's 32K context is interesting for the "no chunking" strategy, but their API pricing model (token top-ups, no SLA) is not suitable for enterprise production. The open-weight model (677M) has no mature production serving story yet. Evaluate in 6 months.

**Fine-tuning embedding models on Vodacom content**
Domain-specific fine-tuning would improve retrieval quality by 2-5 NDCG points. However, it requires labeled query-document pairs (typically 5,000-50,000 examples), a fine-tuning pipeline, and model versioning. This is a Phase 3 activity.

**Sentence-level chunking with dependency parsing**
Some implementations use NLP sentence boundary detection for smarter chunking. In practice, the quality gain vs. fixed-size chunking is marginal for enterprise document retrieval. The complexity is not worth it.

**Managed vector databases (Pinecone, Weaviate cloud)**
Adding a managed vector database adds cost, latency, and a data egress risk for enterprise content that cannot leave the organization's infrastructure. pgvector on existing PostgreSQL is the right choice for Vodacom's data governance requirements.

---

## Appendix A: OpenAI Embedding API Reference (TypeScript)

```typescript
// Full type-safe wrapper
import OpenAI from 'openai';

type OpenAIEmbeddingModel = 
  | 'text-embedding-3-large'    // 3072 dims default, best quality, $0.13/1M
  | 'text-embedding-3-small'    // 1536 dims default, good quality, $0.02/1M
  | 'text-embedding-ada-002';   // legacy, 1536 dims, $0.10/1M — do not use for new projects

interface OpenAIEmbedOptions {
  model: OpenAIEmbeddingModel;
  input: string | string[];
  dimensions?: number;           // MRL truncation — supported on v3 models only
  encoding_format?: 'float' | 'base64';
  user?: string;                 // optional end-user identifier for abuse detection
}

const openai = new OpenAI();

// Single embedding
const r = await openai.embeddings.create({
  model: 'text-embedding-3-large',
  input: 'Enterprise knowledge retrieval',
  dimensions: 1024,
});
console.log(r.data[0].embedding.length);  // 1024
console.log(r.usage.total_tokens);        // token count for cost tracking
```

---

## Appendix B: Cohere Embed v4.0 API Reference (TypeScript)

```typescript
import { CohereClient } from 'cohere-ai';

const co = new CohereClient({ token: process.env.COHERE_API_KEY! });

// Document embedding
const docResponse = await co.v2.embed({
  texts: ['Policy document content...'],
  model: 'embed-v4.0',
  inputType: 'search_document',      // asymmetric: document side
  outputDimension: 1024,             // Matryoshka: 256 | 512 | 1024 | 1536 | 4096
  embeddingTypes: ['float'],         // 'float' | 'int8' | 'uint8' | 'binary' | 'ubinary'
});
const docEmbedding: number[] = docResponse.embeddings.float![0];

// Query embedding
const queryResponse = await co.v2.embed({
  texts: ['What is the leave application process?'],
  model: 'embed-v4.0',
  inputType: 'search_query',         // asymmetric: query side
  outputDimension: 1024,
  embeddingTypes: ['float'],
});
const queryEmbedding: number[] = queryResponse.embeddings.float![0];

// Binary output for storage optimization
const binaryResponse = await co.v2.embed({
  texts: ['Document content'],
  model: 'embed-v4.0',
  inputType: 'search_document',
  outputDimension: 1024,
  embeddingTypes: ['ubinary'],  // unsigned binary
});
const binaryEmbedding: number[] = binaryResponse.embeddings.ubinary![0];
// 128 uint8 values representing 1024 packed binary bits
```

---

## Appendix C: BGE-M3 Hybrid Retrieval (Dense + Sparse)

BGE-M3 is the only Ollama/TEI-deployable model with built-in sparse retrieval (lexical matching), which is critical for Afrikaans and Zulu document retrieval.

```python
# Python — use in background indexer sidecar
from FlagEmbedding import BGEM3FlagModel

model = BGEM3FlagModel('BAAI/bge-m3', use_fp16=True)

# Returns both dense AND sparse embeddings in one call
output = model.encode(
    ['verlofaansoek prosedures', 'leave application process'],
    return_dense=True,
    return_sparse=True,    # sparse = lexical weights like BM25
    return_colbert_vecs=False,  # skip ColBERT for now
)

# Dense embedding (1024-dim float)
dense_vecs = output['dense_vecs']  # shape: (2, 1024)

# Sparse embedding (dict of token -> weight)
sparse_weights = output['lexical_weights']
# Example: {'verlof': 0.21, 'aansoek': 0.31, 'prosedures': 0.18}
```

For a Node.js deployment, call the BGE-M3 Python service via TEI's REST API for dense embeddings, and maintain a separate BM25 index (Elasticsearch or PostgreSQL `pg_bm25`) for sparse. The TEI endpoint does not expose sparse weights — you need the Python FlagEmbedding library directly for those.

---

## Appendix D: Full Model Comparison Table

| Model | Params | Dims | Tokens | BEIR | MIRACL | Multilingual | SA langs | ONNX | License | Recommended use |
|-------|--------|------|--------|------|--------|--------------|---------|------|---------|-----------------|
| all-minilm-L6-v2 | 22M | 384 | 256 | ~56 | No | No | No | Yes | Apache | Dev/test only |
| nomic-embed-text-v1.5 | 137M | 768 | 8192 | 62.3 | No | No | Yes | Apache | English dev+prod |
| mxbai-embed-large-v1 | 335M | 1024 | 512 | 64.7 | No | No | Yes | Apache | English prod |
| bge-base-en-v1.5 | 109M | 768 | 512 | 64.2 | No | No | Yes | MIT | English prod |
| multilingual-e5-large-instruct | 560M | 1024 | 512 | 61.5 | Good | 94 langs | OK | Yes | MIT | Multilingual |
| bge-m3 | 568M | 1024 | 8192 | 48.8 | 56.8 | 100+ langs | Good | Yes | MIT | **Recommended multilingual** |
| snowflake-arctic-l-v2.0 | 568M | 1024 | 8192 | 55.6 | 55.8 | 74 langs | OK | Yes | Apache | Multilingual alt |
| gte-Qwen2-7B-instruct | 7B | 3584 | 32768 | 70.2 | Good | Multilingual | Limited | No | Apache | Max quality |
| text-embedding-3-large | — | 3072 | 8191 | ~65 | Limited | Limited | Poor | N/A | Proprietary | Simple cloud |
| text-embedding-3-small | — | 1536 | 8191 | ~61 | Limited | Limited | Poor | N/A | Proprietary | Cloud, budget |
| Cohere embed-v4.0 | — | Up to 4096 | ~4096 | ~64 | Best | 100+ langs | Good | N/A | Proprietary | Cloud multilingual |
| jina-v5-text-small | 677M | Variable | 32768 | TBD | TBD | Multilingual | Unknown | GGUF | Apache | 32K context |
| qwen3-embedding (Ollama) | 0.6-8B | 2048+ | Long | TBD | TBD | Yes | No | Apache | New, monitor |

---

*Research compiled from web sources as of 2026-08-26. MTEB scores change as new models are added; verify at https://huggingface.co/spaces/mteb/leaderboard before making production decisions.*
