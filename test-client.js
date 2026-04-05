#!/usr/bin/env node
/**
 * MCP Client for testing markdown-for-agents-mcp
 * Uses the @modelcontextprotocol/sdk to communicate with the server
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';

const SERVER_PATH = new URL('./dist/index.js', import.meta.url).pathname;

async function main() {
  console.log('=== Testing markdown-for-agents-mcp ===\n');

  // Create transport to spawn server
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_PATH],
  });

  // Create client
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} }
  );

  console.log('Connecting to MCP server...');

  try {
    // Connect to server
    await client.connect(transport);
    console.log('Connected!\n');

    // List available tools
    console.log('=== Available Tools ===');
    const tools = await client.listTools();
    for (const tool of tools.tools) {
      console.log(`- ${tool.name}`);
      console.log(`  Description: ${tool.description}`);
    }
    console.log('');

    // Test fetch_url
    console.log('=== Testing fetch_url ===');
    const fetchResult = await client.callTool({
      name: 'fetch_url',
      arguments: {
        url: 'https://example.com',
      },
    });

    if (fetchResult.content) {
      console.log('Result:');
      for (const content of fetchResult.content) {
        if (content.type === 'text') {
          console.log(content.text);
        }
      }
    }
    console.log('');

    // Test fetch_urls with multiple URLs
    console.log('=== Testing fetch_urls ===');
    const urlsResult = await client.callTool({
      name: 'fetch_urls',
      arguments: {
        urls: ['https://example.com', 'https://example.org'],
      },
    });

    if (urlsResult.content) {
      console.log('Result:');
      for (const content of urlsResult.content) {
        if (content.type === 'text') {
          console.log(content.text);
        }
      }
    }
    console.log('');

    console.log('=== Tests Complete ===');

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    // Disconnect
    await client.close();
    console.log('Disconnected');
  }
}

main().catch(console.error);
