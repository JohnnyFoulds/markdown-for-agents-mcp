#!/usr/bin/env node
/**
 * CLI for markdown-for-agents-mcp
 * Fetches a URL or URLs and outputs markdown to stdout
 */

import { fetchUrl } from './dist/tools/fetchUrl.js';
import { fetchUrls } from './dist/tools/fetchUrls.js';
import { webSearch } from './dist/tools/webSearch.js';
import { downloadFileHandler } from './dist/tools/downloadFile.js';
import { fetcher } from './dist/fetcher.js';
import { validateAndInitializeConfig } from './dist/config.js';

// Initialize config from environment variables
validateAndInitializeConfig();

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: markdown-cli <url>');
  console.error('       markdown-cli -b <url1> <url2> ...');
  console.error('       markdown-cli -s "search query"');
  console.error('       markdown-cli -d -o <output-path> <url>');
  console.error('');
  console.error('Options:');
  console.error('  -b, --batch          Fetch multiple URLs');
  console.error('  -s, --search         Search DuckDuckGo');
  console.error('  -m, --max-results    Max search results (default: 10)');
  console.error('  --allowed-domains    Only include these domains (comma-separated)');
  console.error('  --blocked-domains    Exclude these domains (comma-separated)');
  console.error('  -f, --fetch-results  Fetch top results as markdown (hybrid mode)');
  console.error('  -d, --download       Download a binary file (PDF, image, etc.)');
  console.error('  -o, --output <path>  Output path for downloaded file (required with -d)');
  process.exit(1);
}

let urls = [];
let isBatch = false;
let isDownload = false;
let outputPath = null;
let searchQuery = null;
let maxResults = 10;
let allowedDomains = null;
let blockedDomains = null;
let fetchResults = false;

// Parse arguments
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-b' || arg === '--batch') {
    isBatch = true;
  } else if (arg === '-d' || arg === '--download') {
    isDownload = true;
  } else if (arg === '-o' || arg === '--output') {
    outputPath = args[++i];
  } else if (arg === '-s' || arg === '--search') {
    searchQuery = args[++i];
  } else if (arg === '-m' || arg === '--max-results') {
    maxResults = parseInt(args[++i]);
  } else if (arg === '--allowed-domains') {
    allowedDomains = args[++i].split(',');
  } else if (arg === '--blocked-domains') {
    blockedDomains = args[++i].split(',');
  } else if (arg === '-f' || arg === '--fetch-results') {
    fetchResults = true;
  } else if (arg.startsWith('-')) {
    console.error(`Unknown option: ${arg}`);
    process.exit(1);
  } else {
    urls.push(arg);
  }
}

async function main() {
  try {
    let result;
    if (isDownload) {
      const url = urls[0];
      if (!url) {
        console.error('Error: no URL provided. Usage: markdown-cli -d -o <output-path> <url>');
        process.exit(1);
      }
      if (!outputPath) {
        console.error('Error: -o/--output <path> is required when using -d/--download');
        process.exit(1);
      }
      const downloadResult = await downloadFileHandler({ url, outputPath });
      if (downloadResult.isError) {
        console.error(downloadResult.content[0]?.text ?? 'Download failed');
        process.exit(1);
      }
      console.log(downloadResult.content[0]?.text ?? '');
      return;
    } else if (searchQuery) {
      result = await webSearch({
        query: searchQuery,
        maxResults,
        allowedDomains: allowedDomains || undefined,
        blockedDomains: blockedDomains || undefined,
        fetchResults,
      });
    } else if (isBatch || urls.length > 1) {
      result = await fetchUrls({ urls });
    } else {
      const url = urls[0];
      if (!url) {
        console.error('Error: no URL provided. Usage: markdown-cli <url>');
        process.exit(1);
      }
      result = await fetchUrl({ url });
    }
    console.log(result);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  } finally {
    // Close browser to allow process to exit
    await fetcher.close();
  }
}

main();
