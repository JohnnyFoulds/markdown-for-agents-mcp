#!/usr/bin/env node
/**
 * CLI for markdown-for-agents-mcp
 * Fetches a URL or URLs and outputs markdown to stdout
 */

import { fetchUrl } from './dist/tools/fetchUrl.js';
import { fetchUrls } from './dist/tools/fetchUrls.js';
import { fetcher } from './dist/fetcher.js';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: markdown-cli <url>');
  console.error('       markdown-cli -b <url1> <url2> ...');
  console.error('');
  console.error('Options:');
  console.error('  -b, --batch    Fetch multiple URLs');
  process.exit(1);
}

let urls = [];
let isBatch = false;

// Parse arguments
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-b' || arg === '--batch') {
    isBatch = true;
  } else if (arg.startsWith('-')) {
    console.error(`Unknown option: ${arg}`);
    process.exit(1);
  } else {
    urls.push(arg);
  }
}

if (urls.length === 0) {
  console.error('No URLs provided');
  process.exit(1);
}

async function main() {
  try {
    let result;
    if (isBatch || urls.length > 1) {
      result = await fetchUrls(urls);
    } else {
      result = await fetchUrl(urls[0]);
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
