// Runs inside a worker_threads Worker. Loads the ONNX cross-encoder model
// once and processes rank requests from the main thread.
// Import via: new Worker(new URL('./rerankWorker.js', import.meta.url), { workerData })
import { workerData, parentPort, isMainThread } from 'worker_threads';

if (isMainThread) throw new Error('rerankWorker.ts must run inside a worker_threads Worker');
if (!parentPort) throw new Error('parentPort is null');

interface WorkerData {
  modelName: string;
  dtype: string;
  device: string;
}

interface RankRequest {
  id: number;
  query: string;
  passages: string[];
}

interface RankResponse {
  id: number;
  scores?: number[];
  error?: string;
}

const { modelName, dtype, device } = workerData as WorkerData;

async function init() {
  // Dynamic import so the package is optional
  // @ts-expect-error optional dependency — not declared in devDependencies
  const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');

  const tokenizer = await AutoTokenizer.from_pretrained(modelName);
  const model = await AutoModelForSequenceClassification.from_pretrained(modelName, {
    dtype: dtype as 'q8',
    device: device as 'cpu',
  });

  parentPort!.postMessage({ type: 'ready' });

  parentPort!.on('message', async (req: RankRequest) => {
    try {
      const pairs = req.passages.map(p => [req.query, p]);
      const inputs = await tokenizer(pairs, { padding: true, truncation: true });
      const output = await model(inputs);
      const logits: number[] = Array.from(output.logits.data as Float32Array);
      const response: RankResponse = { id: req.id, scores: logits };
      parentPort!.postMessage(response);
    } catch (err) {
      const response: RankResponse = { id: req.id, error: err instanceof Error ? err.message : String(err) };
      parentPort!.postMessage(response);
    }
  });
}

init().catch(err => {
  parentPort!.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
