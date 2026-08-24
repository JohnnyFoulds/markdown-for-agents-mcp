import { describe, test, expect } from 'vitest';
import { chunkMarkdown } from './chunker.js';

const URL = 'https://example.com/docs';

describe('chunkMarkdown', () => {
  test('returns a single chunk for short text', () => {
    const md = 'Hello world. This is a short document.';
    const chunks = chunkMarkdown(md, URL);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain('Hello world');
    expect(chunks[0]!.sourceUrl).toBe(URL);
  });

  test('splits on ATX headings and prefixes chunks with heading path', () => {
    const md = `# Introduction\n\nIntro text.\n\n## Setup\n\nSetup text.\n\n## Usage\n\nUsage text.`;
    const chunks = chunkMarkdown(md, URL);
    const headingPaths = chunks.map(c => c.headingPath);
    expect(headingPaths.some(p => p.includes('Introduction'))).toBe(true);
    expect(headingPaths.some(p => p.includes('Setup'))).toBe(true);
    expect(chunks.every(c => c.text.includes(c.headingPath) || c.headingPath === '')).toBe(true);
  });

  test('builds nested heading paths', () => {
    const md = `# Docs\n\n## API\n\n### Auth\n\nAuth content here.`;
    const chunks = chunkMarkdown(md, URL);
    const authChunk = chunks.find(c => c.headingPath.includes('Auth'));
    expect(authChunk?.headingPath).toBe('Docs > API > Auth');
  });

  test('never splits inside a fenced code block', () => {
    const fence = '```\n' + 'x\n'.repeat(200) + '```';
    const md = `# Title\n\n${fence}`;
    const chunks = chunkMarkdown(md, URL);
    const codeChunks = chunks.filter(c => c.text.includes('```'));
    // Code block must be kept whole — no chunk should contain only the opening fence
    expect(codeChunks.every(c => c.text.includes('```\n') && c.text.lastIndexOf('```') > c.text.indexOf('```'))).toBe(true);
  });

  test('assigns sequential indices starting at 0', () => {
    const md = Array.from({ length: 5 }, (_, i) => `## Section ${i}\n\n${'text '.repeat(200)}`).join('\n\n');
    const chunks = chunkMarkdown(md, URL);
    expect(chunks.map(c => c.index)).toEqual(chunks.map((_, i) => i));
  });

  test('returns empty array for empty markdown', () => {
    expect(chunkMarkdown('', URL)).toHaveLength(0);
    expect(chunkMarkdown('   \n  ', URL)).toHaveLength(0);
  });

  test('estimates token count > 0 for non-empty chunks', () => {
    const md = 'Some content here that has multiple words in it.';
    const chunks = chunkMarkdown(md, URL);
    expect(chunks[0]!.tokenEstimate).toBeGreaterThan(0);
  });

  test('splits long sections into multiple chunks', () => {
    const longSection = Array.from({ length: 100 }, (_, i) => `Paragraph ${i} has several words in it.`).join('\n\n');
    const md = `# Long Section\n\n${longSection}`;
    const chunks = chunkMarkdown(md, URL);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
