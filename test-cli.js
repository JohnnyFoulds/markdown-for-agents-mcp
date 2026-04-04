#!/usr/bin/env node
/**
 * Simple CLI test client for markdown-for-agents-mcp
 * Tests the fetch_url and fetch_urls tools via stdio
 */

import { spawn } from 'node:child_process';
import { stdin, stdout } from 'node:process';

const SERVER_PATH = new URL('./dist/index.js', import.meta.url).pathname;

// Spawn the MCP server
const server = spawn('node', [SERVER_PATH], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let buffer = '';

function sendRequest(request) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(request);
    const message = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
    server.stdin.write(message);

    const timeout = setTimeout(() => {
      reject(new Error('Request timeout'));
    }, 30000);

    const onData = (data) => {
      buffer += data.toString();
      const match = buffer.match(/Content-Length: (\d+)\r\n\r\n([\s\S]*)/);
      if (match) {
        clearTimeout(timeout);
        buffer = '';
        try {
          const response = JSON.parse(match[2]);
          resolve(response);
        } catch (e) {
          reject(new Error('Invalid response JSON'));
        }
        server.stdout.removeListener('data', onData);
      }
    };

    server.stdout.on('data', onData);
  });
}

async function testFetchUrl() {
  console.log('\n=== Testing fetch_url tool ===');

  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'call_tool',
    params: {
      name: 'fetch_url',
      arguments: {
        url: 'https://example.com',
      },
    },
  };

  try {
    const response = await sendRequest(request);
    console.log('Response:', JSON.stringify(response, null, 2));
    return response;
  } catch (error) {
    console.error('Error:', error.message);
    return null;
  }
}

async function testFetchUrls() {
  console.log('\n=== Testing fetch_urls tool ===');

  const request = {
    jsonrpc: '2.0',
    id: 2,
    method: 'call_tool',
    params: {
      name: 'fetch_urls',
      arguments: {
        urls: ['https://example.com', 'https://example.org'],
      },
    },
  };

  try {
    const response = await sendRequest(request);
    console.log('Response:', JSON.stringify(response, null, 2));
    return response;
  } catch (error) {
    console.error('Error:', error.message);
    return null;
  }
}

async function main() {
  console.log('Starting MCP server...');
  console.log('Server path:', SERVER_PATH);

  server.stderr.on('data', (data) => {
    console.error('Server stderr:', data.toString());
  });

  server.on('close', (code) => {
    console.log(`Server exited with code ${code}`);
  });

  // Give server time to start
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Run tests
  await testFetchUrl();
  await testFetchUrls();

  // Clean up
  server.kill();
  console.log('\nTests complete!');
}

main().catch(console.error);
