import { describe, test, expect, beforeEach, vi } from 'vitest';
import { webSearch } from './webSearch.js';
import { duckDuckGoSearch } from '../services/webSearch.js';

vi.mock('../services/webSearch.js', () => ({
  duckDuckGoSearch: vi.fn(),
}));

describe('webSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('performs search and returns formatted results', async () => {
    vi.mocked(duckDuckGoSearch).mockResolvedValue({
      query: 'test query',
      results: [
        { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1', domain: 'example.com' },
        { title: 'Result 2', url: 'https://example.com/2', snippet: 'Snippet 2', domain: 'example.com' },
      ],
      durationMs: 500,
    });

    const result = await webSearch({ query: 'test query' });

    expect(duckDuckGoSearch).toHaveBeenCalledWith({
      query: 'test query',
      maxResults: 10,
      fetchResults: false,
    });
    expect(result).toContain('# Web Search Results');
    expect(result).toContain('test query');
    expect(result).toContain('Result 1');
    expect(result).toContain('Result 2');
    expect(result).toContain('https://example.com/1');
    expect(result).toContain('https://example.com/2');
  });

  test('includes snippet in output', async () => {
    vi.mocked(duckDuckGoSearch).mockResolvedValue({
      query: 'test',
      results: [{ title: 'Title', url: 'https://example.com', snippet: 'Snippet text', domain: 'example.com' }],
      durationMs: 500,
    });

    const result = await webSearch({ query: 'test' });

    expect(result).toContain('Snippet text');
  });

  test('includes duration in output', async () => {
    vi.mocked(duckDuckGoSearch).mockResolvedValue({
      query: 'test',
      results: [],
      durationMs: 123,
    });

    const result = await webSearch({ query: 'test' });

    expect(result).toContain('123ms');
  });

  test('handles search errors gracefully', async () => {
    vi.mocked(duckDuckGoSearch).mockRejectedValue(new Error('Search failed'));

    const result = await webSearch({ query: 'test query' });

    expect(result).toContain('# Web Search Error');
    expect(result).toContain('Search failed');
  });

  test('handles non-Error exceptions', async () => {
    vi.mocked(duckDuckGoSearch).mockRejectedValue('String error');

    const result = await webSearch({ query: 'test query' });

    expect(result).toContain('# Web Search Error');
    expect(result).toContain('Unknown error');
  });

  test('respects maxResults parameter', async () => {
    vi.mocked(duckDuckGoSearch).mockResolvedValue({
      query: 'test',
      results: [{ title: 'A', url: 'https://example.com', snippet: '', domain: 'example.com' }],
      durationMs: 500,
    });

    await webSearch({ query: 'test', maxResults: 5 });

    expect(duckDuckGoSearch).toHaveBeenCalledWith({
      query: 'test',
      maxResults: 5,
      fetchResults: false,
    });
  });

  test('passes allowedDomains parameter', async () => {
    vi.mocked(duckDuckGoSearch).mockResolvedValue({
      query: 'test',
      results: [],
      durationMs: 500,
    });

    await webSearch({
      query: 'test',
      allowedDomains: ['example.com', 'other.com'],
    });

    expect(duckDuckGoSearch).toHaveBeenCalledWith({
      query: 'test',
      allowedDomains: ['example.com', 'other.com'],
      maxResults: 10,
      fetchResults: false,
    });
  });

  test('passes blockedDomains parameter', async () => {
    vi.mocked(duckDuckGoSearch).mockResolvedValue({
      query: 'test',
      results: [],
      durationMs: 500,
    });

    await webSearch({
      query: 'test',
      blockedDomains: ['blocked.com'],
    });

    expect(duckDuckGoSearch).toHaveBeenCalledWith({
      query: 'test',
      blockedDomains: ['blocked.com'],
      maxResults: 10,
      fetchResults: false,
    });
  });

  test('includes fetched content when fetchResults is true', async () => {
    vi.mocked(duckDuckGoSearch).mockResolvedValue({
      query: 'test',
      results: [{ title: 'A', url: 'https://example.com', snippet: '', domain: 'example.com' }],
      markdownResults: [{ url: 'https://example.com', markdown: '# Title\nContent' }],
      durationMs: 500,
    });

    const result = await webSearch({
      query: 'test',
      fetchResults: true,
    });

    expect(result).toContain('## Fetched Content:');
    expect(result).toContain('# Title');
    expect(result).toContain('Content');
  });

  test('handles empty results', async () => {
    vi.mocked(duckDuckGoSearch).mockResolvedValue({
      query: 'test',
      results: [],
      durationMs: 500,
    });

    const result = await webSearch({ query: 'test' });

    expect(result).toContain('Found 0 results');
  });

  test('handles timeout parameter', async () => {
    vi.mocked(duckDuckGoSearch).mockResolvedValue({
      query: 'test',
      results: [],
      durationMs: 500,
    });

    await webSearch({
      query: 'test',
      timeout: 60000,
    });

    expect(duckDuckGoSearch).toHaveBeenCalledWith({
      query: 'test',
      timeout: 60000,
      maxResults: 10,
      fetchResults: false,
    });
  });
});
