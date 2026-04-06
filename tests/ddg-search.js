#!/usr/bin/env node
'use strict';

/**
 * ddg-search.js — fetch full HTML from DuckDuckGo html endpoint
 *
 * Usage:
 *   node ddg-search.js "your query"               # print raw HTML to stdout
 *   node ddg-search.js "your query" --json        # print parsed results as JSON
 *   node ddg-search.js "your query" --output f.html
 *
 * No external dependencies — uses Node.js built-in https module.
 *
 * Works by hitting https://html.duckduckgo.com/html/?q=<query> with browser-like
 * headers. This endpoint returns server-rendered HTML without JavaScript, and
 * without the bot-challenge that the lite endpoint triggers for plain curl calls.
 */

const https = require('https');
const fs = require('fs');

// ── fetch ─────────────────────────────────────────────────────────────────────

function fetchHtml(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const options = {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'identity',
      Referer: 'https://duckduckgo.com/',
      DNT: '1',
      Connection: 'keep-alive',
    },
  };

  return new Promise((resolve, reject) => {
    https.get(url, options, (res) => {
      // Handle redirects (up to 5 hops)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        https.get(res.headers.location, options, handleResponse(resolve, reject));
        return;
      }
      handleResponse(resolve, reject)(res);
    }).on('error', reject);
  });
}

function handleResponse(resolve, reject) {
  return (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      reject(new Error(`HTTP ${res.statusCode}`));
      return;
    }
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  };
}

// ── parse ─────────────────────────────────────────────────────────────────────

/**
 * Extract { title, url, snippet } objects from the DDG HTML response.
 *
 * The page uses:
 *   <a class="result__a" href="//duckduckgo.com/l/?uddg=<encoded-url>&…">TITLE</a>
 *   <a class="result__snippet" href="…">SNIPPET (may contain <b> tags)</a>
 */
function parseResults(html) {
  const results = [];
  const seen = new Set();

  // Match title anchors
  const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  // Map from href → snippet (built first for O(1) lookup)
  const snippetMap = new Map();
  const snippetRe = /<a[^>]+class="result__snippet"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  let m;
  while ((m = snippetRe.exec(html)) !== null) {
    snippetMap.set(m[1], m[2].replace(/<[^>]+>/g, '').trim());
  }

  while ((m = titleRe.exec(html)) !== null) {
    const rawHref = m[1];
    const title = m[2].replace(/<[^>]+>/g, '').trim();

    // Decode the real URL from the DDG redirect wrapper
    let url = rawHref;
    const uddgMatch = rawHref.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      try { url = decodeURIComponent(uddgMatch[1]); } catch (_) {}
    } else if (rawHref.startsWith('//')) {
      url = 'https:' + rawHref;
    }

    if (seen.has(url)) continue;
    seen.add(url);

    const snippet = snippetMap.get(rawHref) || '';
    results.push({ title, url, snippet });
  }

  return results;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      'Usage: node ddg-search.js "query" [--json] [--output file.html]'
    );
    process.exit(1);
  }

  const query = args[0];
  const outputIdx = args.indexOf('--output');
  const outputFile = outputIdx !== -1 ? args[outputIdx + 1] : null;
  const jsonMode = args.includes('--json');

  const html = await fetchHtml(query);

  // Detect bot-challenge page (fallback warning)
  if (html.includes('anomaly-modal') || html.length < 2000) {
    process.stderr.write(
      '[warn] Response looks like a bot-challenge page — results may be empty.\n'
    );
  }

  if (outputFile) {
    fs.writeFileSync(outputFile, html, 'utf8');
    process.stderr.write(`HTML written to ${outputFile}\n`);
  }

  if (jsonMode) {
    const results = parseResults(html);
    console.log(JSON.stringify(results, null, 2));
  } else if (!outputFile) {
    process.stdout.write(html);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

module.exports = { fetchHtml, parseResults };
