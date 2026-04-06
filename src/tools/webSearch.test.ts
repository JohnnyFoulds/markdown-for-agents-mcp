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

  test('performs search and returns WebSearchResult', async () => {
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
    expect(result.query).toBe('test query');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].title).toBe('Result 1');
    expect(result.results[0].url).toBe('https://example.com/1');
    expect(result.durationMs).toBe(500);
  });

  test('includes snippet in results', async () => {
    vi.mocked(duckDuckGoSearch).mockResolvedValue({
      query: 'test',
      results: [{ title: 'Title', url: 'https://example.com', snippet: 'Snippet text', domain: 'example.com' }],
      durationMs: 500,
    });

    const result = await webSearch({ query: 'test' });

    expect(result.results[0].snippet).toBe('Snippet text');
  });

  test('includes durationMs in result', async () => {
    vi.mocked(duckDuckGoSearch).mockResolvedValue({
      query: 'test',
      results: [],
      durationMs: 123,
    });

    const result = await webSearch({ query: 'test' });

    expect(result.durationMs).toBe(123);
  });

  test('throws when search fails', async () => {
    vi.mocked(duckDuckGoSearch).mockRejectedValue(new Error('Search failed'));

    await expect(webSearch({ query: 'test query' })).rejects.toThrow('Search failed');
  });

  test('throws non-Error exceptions', async () => {
    vi.mocked(duckDuckGoSearch).mockRejectedValue('String error');

    await expect(webSearch({ query: 'test query' })).rejects.toBe('String error');
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

  test('includes fetchedContent when markdownResults returned', async () => {
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

    expect(result.fetchedContent).toHaveLength(1);
    expect(result.fetchedContent![0].url).toBe('https://example.com');
    expect(result.fetchedContent![0].markdown).toContain('# Title');
  });

  test('handles empty results', async () => {
    vi.mocked(duckDuckGoSearch).mockResolvedValue({
      query: 'test',
      results: [],
      durationMs: 500,
    });

    const result = await webSearch({ query: 'test' });

    expect(result.results).toHaveLength(0);
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
