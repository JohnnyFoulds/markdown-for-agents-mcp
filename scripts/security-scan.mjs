/**
 * Security scan orchestrator — runs SCA, SAST, and secrets scans and produces
 * a single consolidated report optimised for agentic review.
 *
 * DAST is excluded from this orchestrator because it requires a running server.
 * Run it separately: node scripts/scan-dast.mjs --base http://localhost:3000
 *
 * Produces:
 *   security-reports/sca-report.md        SCA findings
 *   security-reports/sast-report.md       SAST findings
 *   security-reports/secrets-report.md    Secrets findings
 *   security-reports/REPORT.md            Consolidated report (LLM-optimised)
 *
 * Usage:
 *   node scripts/security-scan.mjs                  # all scans
 *   node scripts/security-scan.mjs --skip-sca       # skip SCA
 *   node scripts/security-scan.mjs --skip-sast      # skip SAST
 *   node scripts/security-scan.mjs --skip-secrets   # skip secrets scan
 *
 * Exit codes:
 *   0  all scans pass (no critical or high findings)
 *   1  critical or high findings detected
 *   2  one or more scans failed to run
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'skip-sca':     { type: 'boolean', default: false },
    'skip-sast':    { type: 'boolean', default: false },
    'skip-secrets': { type: 'boolean', default: false },
    'prod-only':    { type: 'boolean', default: false },
  },
  strict: false,
});

const OUT = 'security-reports';
mkdirSync(OUT, { recursive: true });

const now    = new Date().toISOString();
const date   = now.slice(0, 10);
const results = {};

// ── Run each scanner ──────────────────────────────────────────────────────────

function run(label, script, extraArgs = []) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Running ${label}…`);
  console.log('─'.repeat(60));
  const r = spawnSync(
    'node',
    [`scripts/${script}`, ...extraArgs],
    { stdio: 'inherit', encoding: 'utf8' },
  );
  results[label] = {
    exitCode: r.status ?? 1,
    signal:   r.signal,
    failed:   r.status === null || r.status === 2,
  };
  return r.status;
}

if (!args['skip-sca']) {
  const extraArgs = args['prod-only'] ? ['--prod-only'] : [];
  run('SCA', 'scan-sca.mjs', extraArgs);
}
if (!args['skip-sast'])    run('SAST', 'scan-sast.mjs');
if (!args['skip-secrets']) run('Secrets', 'scan-secrets.mjs');

// ── Read individual reports ───────────────────────────────────────────────────

function readReport(file) {
  try { return readFileSync(`${OUT}/${file}`, 'utf8'); } catch { return null; }
}

const scaReport     = readReport('sca-report.md');
const sastReport    = readReport('sast-report.md');
const secretsReport = readReport('secrets-report.md');
const dastReport    = readReport('dast-report.md');

// ── Parse finding counts from JSON outputs ────────────────────────────────────

function countFindings(jsonFile, severities) {
  try {
    const raw = JSON.parse(readFileSync(`${OUT}/${jsonFile}`, 'utf8'));
    // npm audit format
    if (raw.metadata?.vulnerabilities) {
      const v = raw.metadata.vulnerabilities;
      return {
        critical: v.critical ?? 0,
        high:     v.high ?? 0,
        moderate: v.moderate ?? 0,
        low:      v.low ?? 0,
      };
    }
    // semgrep format
    if (raw.results) {
      const counts = { critical: 0, high: 0, moderate: 0, low: 0 };
      for (const r of raw.results) {
        const s = (r.extra?.severity ?? '').toLowerCase();
        if (s in counts) counts[s]++;
      }
      return counts;
    }
    // custom format
    if (raw.findings) {
      const counts = { critical: 0, high: 0, moderate: 0, low: 0 };
      for (const f of raw.findings) {
        const s = (f.severity ?? '').toLowerCase();
        if (s in counts) counts[s]++;
      }
      return counts;
    }
  } catch { /* ignore */ }
  return { critical: 0, high: 0, moderate: 0, low: 0 };
}

const scaCounts     = countFindings('sca-npm-audit.json', []);
// Bug fix: spread OVERWRITES keys — sum counts instead so custom-rule findings
// are added to semgrep findings, not replaced by them.
const semgrepCounts = countFindings('sast-semgrep.json', []);
const customCounts  = countFindings('sast-custom.json', []);
const sastCounts    = {
  critical: semgrepCounts.critical + customCounts.critical,
  high:     semgrepCounts.high     + customCounts.high,
  moderate: semgrepCounts.moderate + customCounts.moderate,
  low:      semgrepCounts.low      + customCounts.low,
};
const secretCounts  = countFindings('secrets-custom.json', []);

function totalHigh(c) { return (c.critical ?? 0) + (c.high ?? 0); }
function statusEmoji(exitCode) {
  if (exitCode === 0)  return '✅ PASS';
  if (exitCode === 1)  return '❌ FAIL';
  if (exitCode === 2)  return '⚠️ ERROR';
  return '⏭️ SKIPPED';
}

// ── Consolidated REPORT.md ────────────────────────────────────────────────────

const report = `# Security Scan — Consolidated Report

**Date:** ${date}
**Timestamp:** ${now}

> This report is produced by the automated security scan pipeline and is optimised
> for review by an AI agent. Each section contains the raw findings from its scanner
> followed by the full scanner report. The agent reviewer should:
>
> 1. Triage each HIGH and CRITICAL finding — confirm whether it is a real issue or a false positive
> 2. For confirmed issues: identify the file, line, and root cause
> 3. Propose a fix with a code snippet
> 4. Flag any finding that requires a dependency version bump (SCA) vs a code change (SAST/DAST)
> 5. Secrets: assume ALL findings are real until proven otherwise — rotate first, investigate second

---

## Executive Summary

| Scanner | Status | Critical | High | Moderate | Low |
|---|---|---|---|---|---|
| SCA (npm audit)    | ${args['skip-sca']     ? '⏭️ SKIPPED' : statusEmoji(results['SCA']?.exitCode)}    | ${scaCounts.critical}  | ${scaCounts.high}  | ${scaCounts.moderate}  | ${scaCounts.low}  |
| SAST (semgrep+custom) | ${args['skip-sast']  ? '⏭️ SKIPPED' : statusEmoji(results['SAST']?.exitCode)}   | ${sastCounts.critical} | ${sastCounts.high} | ${sastCounts.moderate} | ${sastCounts.low} |
| Secrets            | ${args['skip-secrets'] ? '⏭️ SKIPPED' : statusEmoji(results['Secrets']?.exitCode)} | — | ${secretCounts.critical + secretCounts.high} | — | — |
| DAST               | ${dastReport ? (() => { const m = dastReport.match(/\*\*Scanned:\*\*\s*(\S+)/); return m ? `✅ Prior run (${m[1]})` : '✅ Prior run (timestamp unknown)'; })() : '⏭️ Not run — requires live server'} | — | — | — | — |

**To run DAST:** \`node scripts/scan-dast.mjs --base http://localhost:3000 --token \$MCP_AUTH_TOKEN\`

---

## SCA Findings

${scaReport ?? '_SCA scan not run or report not found._'}

---

## SAST Findings

${sastReport ?? '_SAST scan not run or report not found._'}

---

## Secrets Findings

${secretsReport ?? '_Secrets scan not run or report not found._'}

${dastReport ? `---\n\n## DAST Findings\n\n${dastReport}` : ''}

---

## Agent Review Instructions

For each HIGH or CRITICAL finding above, provide a response in this format:

\`\`\`
FINDING: <finding ID>
VERDICT: REAL | FALSE_POSITIVE | NEEDS_MORE_INFO
FILE: <file path if applicable>
LINE: <line number if applicable>
ROOT_CAUSE: <one sentence>
FIX: <code snippet or action required>
EFFORT: <minutes estimate>
\`\`\`

Prioritise in this order:
1. Secrets (rotate immediately regardless of verdict)
2. Critical CVEs with fixAvailable=true (npm audit fix)
3. High CVEs
4. SAST critical/high
5. DAST critical/high
6. Everything else
`;

writeFileSync(`${OUT}/REPORT.md`, report);

// ── Final summary ─────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log('SECURITY SCAN COMPLETE');
console.log('═'.repeat(60));
for (const [name, r] of Object.entries(results)) {
  console.log(`  ${statusEmoji(r.exitCode).padEnd(12)} ${name}`);
}
console.log(`\nConsolidated report: ${OUT}/REPORT.md`);
console.log('Run DAST separately once the server is up:');
console.log('  node scripts/scan-dast.mjs --base http://localhost:3000\n');

const anyFail = Object.values(results).some(r => r.exitCode === 1);
const anyError = Object.values(results).some(r => r.failed);
process.exit(anyError ? 2 : anyFail ? 1 : 0);
