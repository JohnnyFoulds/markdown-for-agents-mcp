#!/bin/bash
# Simple CLI test for markdown-for-agents-mcp
# Uses here-doc to send JSON-RPC requests to the server

SERVER="node dist/index.js"

echo "=== Testing markdown-for-agents-mcp ==="
echo ""

# Test 1: fetch_url tool
echo "--- Test 1: fetch_url ---"
echo 'Sending fetch_url request for https://example.com'

echo '{"jsonrpc":"2.0","id":1,"method":"call_tool","params":{"name":"fetch_url","arguments":{"url":"https://example.com"}}}' | $SERVER 2>/dev/null &
SERVER_PID=$!
sleep 1

# Send request to server
(echo '{"jsonrpc":"2.0","id":1,"method":"call_tool","params":{"name":"fetch_url","arguments":{"url":"https://example.com"}}}'; sleep 2; echo '{"jsonrpc":"2.0","id":null,"method":"notifications/exit","params":{}}') | nc -q 3 localhost 9999 2>/dev/null &

wait $SERVER_PID 2>/dev/null
echo "Done"

echo ""
echo "=== Manual Testing ==="
echo "You can interact with the server manually:"
echo ""
echo "  node dist/index.js"
echo ""
echo "Then send JSON-RPC requests like:"
echo '  {"jsonrpc":"2.0","id":1,"method":"call_tool","params":{"name":"fetch_url","arguments":{"url":"https://example.com"}}}'
echo ""
echo "To exit, send:"
echo '  {"jsonrpc":"2.0","id":null,"method":"notifications/exit","params":{}}'
