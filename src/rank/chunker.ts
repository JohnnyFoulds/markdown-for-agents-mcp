import type { Chunk } from './types.js';

const TARGET_TOKENS = 400;
const OVERLAP_TOKENS = 64;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const FENCE_RE = /^```/;
const TABLE_ROW_RE = /^\s*\|/;

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
}

interface Block {
  type: 'heading' | 'fence' | 'table' | 'text';
  level?: number;
  text: string;
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  let inFence = false;
  let fenceBuffer: string[] = [];
  let tableBuffer: string[] = [];

  function flushTable(): void {
    if (tableBuffer.length > 0) {
      blocks.push({ type: 'table', text: tableBuffer.join('\n') });
      tableBuffer = [];
    }
  }

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      flushTable();
      if (inFence) {
        fenceBuffer.push(line);
        blocks.push({ type: 'fence', text: fenceBuffer.join('\n') });
        fenceBuffer = [];
        inFence = false;
      } else {
        inFence = true;
        fenceBuffer = [line];
      }
      continue;
    }
    if (inFence) {
      fenceBuffer.push(line);
      continue;
    }
    if (TABLE_ROW_RE.test(line)) {
      tableBuffer.push(line);
      continue;
    }
    // Non-table line: flush accumulated table rows first
    flushTable();
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1]!.length, text: headingMatch[2]! });
    } else {
      blocks.push({ type: 'text', text: line });
    }
  }

  flushTable();
  // Unclosed fence: treat as text
  if (fenceBuffer.length) {
    blocks.push({ type: 'text', text: fenceBuffer.join('\n') });
  }

  return blocks;
}

function headingPathFor(stack: Array<{ level: number; text: string }>): string {
  return stack.map(h => h.text).join(' > ');
}

export function chunkMarkdown(markdown: string, sourceUrl: string): Chunk[] {
  const blocks = parseBlocks(markdown);
  const chunks: Chunk[] = [];
  const headingStack: Array<{ level: number; text: string }> = [];

  let buffer: string[] = [];
  let bufferTokens = 0;
  let chunkIndex = 0;

  function flushBuffer(clearAll = false): void {
    const text = buffer.join('\n').trim();
    if (!text) return;
    const headingPath = headingPathFor(headingStack);
    const prefix = headingPath ? `${headingPath}\n\n` : '';
    const fullText = prefix + text;
    chunks.push({
      text: fullText,
      headingPath,
      sourceUrl,
      index: chunkIndex++,
      tokenEstimate: estimateTokens(fullText),
    });
    if (clearAll) {
      buffer = [];
      bufferTokens = 0;
      return;
    }
    // Overlap: keep last OVERLAP_TOKENS worth of buffer lines
    const lines = buffer;
    let kept: string[] = [];
    let keptTokens = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = estimateTokens(lines[i]!);
      if (keptTokens + t > OVERLAP_TOKENS) break;
      kept.unshift(lines[i]!);
      keptTokens += t;
    }
    buffer = kept;
    bufferTokens = keptTokens;
  }

  for (const block of blocks) {
    if (block.type === 'heading') {
      // Flush on section boundary — no overlap carry across heading boundaries
      if (bufferTokens > 0) flushBuffer(true);

      // Update heading stack
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= block.level!) {
        headingStack.pop();
      }
      headingStack.push({ level: block.level!, text: block.text });
      continue;
    }

    // Fence and table blocks: always emit as their own chunk if they exceed target
    if (block.type === 'fence' || block.type === 'table') {
      const tokens = estimateTokens(block.text);
      if (bufferTokens + tokens > TARGET_TOKENS && bufferTokens > 0) {
        flushBuffer();
      }
      buffer.push(block.text);
      bufferTokens += tokens;
      if (bufferTokens >= TARGET_TOKENS) flushBuffer();
      continue;
    }

    // Normal text line
    const tokens = estimateTokens(block.text);
    if (bufferTokens + tokens > TARGET_TOKENS && bufferTokens > 0) {
      flushBuffer();
    }
    buffer.push(block.text);
    bufferTokens += tokens;
  }

  if (bufferTokens > 0) flushBuffer();
  return chunks;
}
