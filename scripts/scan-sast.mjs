/**
 * SAST — Static Application Security Testing
 *
 * Uses Semgrep with four rule-sets:
 *   p/owasp-top-ten  — injection, XSS, broken auth, sensitive data, XXE, IDOR, ...
 *   p/nodejs         — Node.js-specific: prototype pollution, path traversal, child_process
 *   p/typescript     — TypeScript-specific unsafe patterns
 *   p/secrets        — hardcoded credentials and tokens
 *
 * Semgrep performs AST-level analysis (not regex line scanning), so it understands
 * code structure and produces very few false positives compared to line-based tools.
 *
 * Produces:
 *   security-reports/sast-semgrep.json   raw semgrep JSON
 *   security-reports/sast-report.md      human + LLM readable summary
 *
 * Prerequisites:
 *   brew install semgrep          macOS
 *   pip3 install semgrep          Linux / CI
 *   bash scripts/install-security-tools.sh
 *
 * Usage:
 *   node scripts/scan-sast.mjs
 *   node scripts/scan-sast.mjs --src src/   (scan a specific directory)
 *   node scripts/scan-sast.mjs --offline    (use only locally cached rules)
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    src:     { type: 'string',  default: 'src' },
    offline: { type: 'boolean', default: false },
  },
  strict: false,
});

const OUT = 'security-reports';
mkdirSync(OUT, { recursive: true });

// ── Pre-flight: semgrep must be installed ─────────────────────────────────────

const semgrepPath = spawnSync('which', ['semgrep'], { encoding: 'utf8' }).stdout.trim();
if (!semgrepPath) {
  console.error('[SAST] semgrep not found.');
  console.error('       Install: bash scripts/install-security-tools.sh');
  console.error('       Manual:  brew install semgrep  OR  pip3 install semgrep');
  console.error('       Docs:    docs/security/SECURITY_SCANNING.md');
  process.exit(2);
}
const semgrepVersion = spawnSync('semgrep', ['--version'], { encoding: 'utf8' }).stdout.trim();
console.log(`[SAST] semgrep ${semgrepVersion}`);

// ── Rulesets ──────────────────────────────────────────────────────────────────

const RULESETS = [
  'p/owasp-top-ten',
  'p/nodejs',
  'p/typescript',
  'p/secrets',
];

// ── Run semgrep ───────────────────────────────────────────────────────────────

const semgrepArgs = [
  ...RULESETS.flatMap(r => ['--config', r]),
  '--json',
  '--no-rewrite-rule-ids',
  '--metrics=off',
];
if (args.offline) semgrepArgs.push('--disable-version-check');
semgrepArgs.push(args.src);

console.log(`[SAST] Running: semgrep ${semgrepArgs.filter(a => !a.startsWith('--')).join(' ')}`);
console.log(`[SAST] Rulesets: ${RULESETS.join(', ')}`);
console.log(`[SAST] Ignore patterns: .semgrepignore`);
console.log('[SAST] This may take 30–120 seconds on first run (downloads rules)…\n');

const result = spawnSync('semgrep', semgrepArgs, {
  encoding: 'utf8',
  timeout: 300_000,
  maxBuffer: 50 * 1024 * 1024,
});

// semgrep exits 1 when findings exist, 0 when clean, 2+ on error
if (result.status !== null && result.status >= 2) {
  console.error('[SAST] semgrep exited with error:');
  console.error(result.stderr?.slice(0, 2000) ?? '(no stderr)');
  process.exit(2);
}

let raw = {};
try {
  raw = JSON.parse(result.stdout || '{}');
} catch (err) {
  console.error('[SAST] Failed to parse semgrep JSON output:', err.message);
  console.error('stdout:', result.stdout?.slice(0, 500));
  process.exit(2);
}

writeFileSync(`${OUT}/sast-semgrep.json`, JSON.stringify(raw, null, 2));

// ── Parse findings ────────────────────────────────────────────────────────────

const findings = (raw.results ?? []).map(r => ({
  file:     r.path,
  line:     r.start?.line,
  endLine:  r.end?.line,
  rule:     r.check_id,
  severity: (r.extra?.severity ?? 'WARNING').toUpperCase(),
  message:  r.extra?.message ?? '',
  snippet:  r.extra?.lines?.trim() ?? '',
  fix:      r.extra?.fix ?? null,
  refs:     r.extra?.metadata?.references ?? [],
  cwe:      r.extra?.metadata?.cwe ?? null,
  owasp:    r.extra?.metadata?.owasp ?? null,
}));

const errors  = raw.errors ?? [];
const skipped = raw.paths?.skipped ?? [];

const bySeverity = {};
for (const f of findings) (bySeverity[f.severity] ??= []).push(f);

const counts = {
  ERROR:    (bySeverity['ERROR']    ?? []).length,
  HIGH:     (bySeverity['HIGH']     ?? []).length,
  MODERATE: (bySeverity['MODERATE'] ?? []).length,
  WARNING:  (bySeverity['WARNING']  ?? []).length,
  LOW:      (bySeverity['LOW']      ?? []).length,
  INFO:     (bySeverity['INFO']     ?? []).length,
};

console.log(`[SAST] ${findings.length} findings — ERROR:${counts.ERROR} HIGH:${counts.HIGH} WARNING/MOD:${counts.WARNING + counts.MODERATE} LOW:${counts.LOW}`);
if (errors.length) console.warn(`[SAST] ${errors.length} scan errors (check ${OUT}/sast-semgrep.json .errors)`);

// ── Report ────────────────────────────────────────────────────────────────────

function findingRows(list) {
  if (!list.length) return '_None_\n';
  return [
    '| File | Line | Rule | Message |',
    '|---|---|---|---|',
    ...list.map(f =>
      `| [\`${f.file}:${f.line}\`](../${f.file}#L${f.line}) | ${f.line} | \`${f.rule.split('.').pop()}\` | ${f.message.replace(/\|/g, '\\|').slice(0, 100)} |`
    ),
  ].join('\n') + '\n';
}

function findingDetail(list) {
  if (!list.length) return '_None_\n';
  return list.map(f => `
#### \`${f.rule}\` — ${f.file}:${f.line}

**Message:** ${f.message}
${f.cwe    ? `**CWE:** ${Array.isArray(f.cwe)    ? f.cwe.join(', ')    : f.cwe}\n`    : ''}${f.owasp  ? `**OWASP:** ${Array.isArray(f.owasp)  ? f.owasp.join(', ')  : f.owasp}\n`  : ''}\`\`\`
${f.snippet}
\`\`\`
${f.fix    ? `**Suggested fix:**\n\`\`\`\n${f.fix}\n\`\`\`\n` : ''}${f.refs.length ? `**References:** ${f.refs.slice(0, 2).join(', ')}\n` : ''}`
  ).join('\n---\n') + '\n';
}

const now = new Date().toISOString();
const report = `# SAST Report — Static Application Security Testing

**Scanned:** ${now}
**Tool:** semgrep ${semgrepVersion}
**Rulesets:** ${RULESETS.join(', ')}
**Source:** \`${args.src}/\`
**Total findings:** ${findings.length}

## Summary

| Severity | Count |
|---|---|
| 🔴 ERROR    | ${counts.ERROR}    |
| 🟠 HIGH     | ${counts.HIGH}     |
| 🟡 WARNING  | ${counts.WARNING}  |
| 🟡 MODERATE | ${counts.MODERATE} |
| 🔵 LOW      | ${counts.LOW}      |
| ⚪ INFO     | ${counts.INFO}     |

---

## 🔴 Error / High Findings (fix before merge)

${findingDetail([...(bySeverity['ERROR'] ?? []), ...(bySeverity['HIGH'] ?? [])])}

## 🟡 Warning / Moderate Findings (review recommended)

${findingRows([...(bySeverity['WARNING'] ?? []), ...(bySeverity['MODERATE'] ?? [])])}

## 🔵 Low / Info Findings

${findingRows([...(bySeverity['LOW'] ?? []), ...(bySeverity['INFO'] ?? [])])}

---

## Scan Metadata

| Property | Value |
|---|---|
| Files scanned | ${raw.stats?.total_time != null ? 'see raw JSON' : (raw.paths?.scanned?.length ?? '—')} |
| Scan errors | ${errors.length} |
| Skipped paths | ${skipped.length} |
| Rulesets | ${RULESETS.join(', ')} |
| Ignore file | \`.semgrepignore\` |

Raw data: \`${OUT}/sast-semgrep.json\`
`;

writeFileSync(`${OUT}/sast-report.md`, report);
console.log(`[SAST] Report written to ${OUT}/sast-report.md`);

const critical = counts.ERROR + counts.HIGH;
if (critical > 0) {
  console.error(`[SAST] FAIL — ${critical} error/high severity findings`);
  process.exit(1);
}
console.log('[SAST] PASS — no error or high severity findings');
