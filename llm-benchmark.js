// Simple LLM benchmark that measures token generation speed
const { spawn } = require('child_process');

// Generate a longer prompt to measure generation speed
const promptText = `Respond with exactly 100 words. Count your words carefully.

${' '.repeat(1000)}`;

const startTime = Date.now();
let output = '';

const child = spawn('node', ['cli.js', '-p', promptText], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe']
});

child.stdout.on('data', (data) => {
  output += data.toString();
});

child.on('close', (code) => {
  const endTime = Date.now();
  const totalMs = endTime - startTime;
  const estimatedTokens = Math.ceil(output.length / 4);
  const tokensPerSecond = output.length > 0 ? (estimatedTokens / (totalMs / 1000)) : 0;

  console.log('\n=== LLM Benchmark Results ===');
  console.log(`Total time: ${totalMs}ms`);
  console.log(`Output length: ${output.length} chars`);
  console.log(`Estimated tokens: ${estimatedTokens}`);
  console.log(`Tokens/second: ${tokensPerSecond.toFixed(2)}`);
  console.log(`\nSample output:\n${output.substring(0, 200)}...`);
});
