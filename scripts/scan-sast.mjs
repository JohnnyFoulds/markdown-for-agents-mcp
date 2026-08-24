/**
 * SAST — Static Application Security Testing
 *
 * Runs two passes:
 *   1. Semgrep (if installed) — OWASP Top 10 + Node.js + secrets rulesets
 *   2. Custom grep scanner — catches patterns semgrep may miss for this codebase
 *      (eval, child_process shell injection, prototype pollution, hardcoded tokens)
 *
 * Produces:
 *   security-reports/sast-semgrep.json    raw semgrep JSON (if semgrep available)
 *   security-reports/sast-custom.json     custom pattern findings
 *   security-reports/sast-report.md       human + LLM readable summary
 *
 * Install semgrep (recommended):
 *   brew install semgrep          # macOS
 *   pip install semgrep           # any platform
 *
 * Usage:
 *   node scripts/scan-sast.mjs
 *   node scripts/scan-sast.mjs --src src/   (scan specific directory)
 */

import { spawnSync, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { src: { type: 'string', default: 'src' } },
  strict: false,
});

const OUT = 'security-reports';
mkdirSync(OUT, { recursive: true });

// ── 1. Semgrep ────────────────────────────────────────────────────────────────

console.log('[ SAST ] Checking for semgrep…');

const semgrepPath = spawnSync('which', ['semgrep'], { encoding: 'utf8' }).stdout.trim();
let semgrepFindings = [];
let semgrepAvailable = false;

if (semgrepPath) {
  semgrepAvailable = true;
  console.log(`[ SAST ] semgrep found at ${semgrepPath} — running OWASP + nodejs + secrets rulesets…`);

  const result = spawnSync(
    'semgrep',
    [
      '--config', 'p/owasp-top-ten',
      '--config', 'p/nodejs',
      '--config', 'p/secrets',
      '--json',
      '--no-rewrite-rule-ids',
      args.src,
    ],
    { encoding: 'utf8', timeout: 300_000 },
  );

  let raw = {};
  try { raw = JSON.parse(result.stdout || '{}'); } catch { raw = { error: result.stderr }; }
  writeFileSync(`${OUT}/sast-semgrep.json`, JSON.stringify(raw, null, 2));
  semgrepFindings = (raw.results ?? []).map(r => ({
    file: r.path,
    line: r.start?.line,
    rule: r.check_id,
    severity: r.extra?.severity ?? 'WARNING',
    message: r.extra?.message ?? '',
    snippet: r.extra?.lines?.trim() ?? '',
  }));
  console.log(`[ SAST ] semgrep: ${semgrepFindings.length} findings`);
} else {
  console.warn('[ SAST ] semgrep not found — skipping. Install: brew install semgrep');
  writeFileSync(`${OUT}/sast-semgrep.json`, JSON.stringify({ skipped: true, reason: 'semgrep not installed' }, null, 2));
}

// ── 2. Custom pattern scanner ─────────────────────────────────────────────────

console.log('[ SAST ] Running custom pattern scanner…');

const PATTERNS = [
  {
    id: 'EVAL_USAGE',
    severity: 'HIGH',
    description: 'eval() executes arbitrary code — forbidden in production',
    // Exclude .eval() (e.g. redis.eval, vm.runInContext) — only flag bare eval()
    regex: /(?<![.\w$])\beval\s*\(/,
    exclude: /\.test\.|\.spec\./,
  },
  {
    id: 'SHELL_INJECTION',
    severity: 'HIGH',
    description: 'child_process exec/execSync with a template literal or variable may allow shell injection',
    // Must be child_process context — exclude RegExp.exec() by requiring no preceding dot/identifier
    regex: /(?:child_process\.|(?<![.\w$]))(execSync|exec)\s*\(`/,
    exclude: /scripts\//,
  },
  {
    id: 'PROTOTYPE_POLLUTION',
    severity: 'MODERATE',
    description: '__proto__ or constructor[prototype] assignment can poison the prototype chain',
    regex: /__proto__|constructor\[.{0,20}prototype/,
    exclude: null,
  },
  {
    id: 'HARDCODED_SECRET',
    severity: 'CRITICAL',
    description: 'Possible hardcoded secret, token, or password',
    regex: /(?:password|secret|token|api[_-]?key)\s*[:=]\s*['"`][A-Za-z0-9+/]{16,}/i,
    exclude: /\.test\.|\.spec\.|\.env\.example|DEPLOYMENT\.md|README/,
  },
  {
    id: 'SQL_CONCAT',
    severity: 'HIGH',
    description: 'String concatenation in a SQL query may allow SQL injection',
    // Require a SQL keyword followed by quoted string fragment + concatenation to reduce false positives
    regex: /(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\s+['"`].{0,40}['"`]\s*\+\s*[a-zA-Z]/i,
    exclude: null,
  },
  {
    id: 'CONSOLE_LOG_CRED',
    severity: 'MODERATE',
    description: 'console.log with a token/key/password variable may leak secrets to logs',
    regex: /console\.log\([^)]*(?:token|password|secret|key)[^)]*\)/i,
    exclude: /\.test\.|\.spec\./,
  },
  {
    id: 'REGEXP_DOS',
    severity: 'MODERATE',
    description: 'Complex nested regex quantifiers may be vulnerable to ReDoS',
    regex: /new RegExp\(|\/(?:[^/]|\\.)*(?:\*|\+|\{[0-9,]+\}){2,}/,
    exclude: null,
  },
  {
    id: 'OPEN_REDIRECT',
    severity: 'MODERATE',
    description: 'res.redirect() with a user-controlled value allows open redirect',
    regex: /res\.redirect\(\s*req\.|res\.redirect\(\s*[a-zA-Z]+(?:Url|Redirect|Location)/,
    exclude: null,
  },
];

function walkDir(dir, ext = ['.ts', '.js', '.mjs']) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !['node_modules', 'dist', '.git'].includes(entry.name)) {
      results.push(...walkDir(full, ext));
    } else if (entry.isFile() && ext.some(e => entry.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

const customFindings = [];
for (const file of walkDir(args.src)) {
  const rel = relative('.', file);
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const pat of PATTERNS) {
    if (pat.exclude?.test(rel)) continue;
    lines.forEach((line, i) => {
      if (pat.regex.test(line)) {
        customFindings.push({
          file: rel,
          line: i + 1,
          rule: pat.id,
          severity: pat.severity,
          message: pat.description,
          snippet: line.trim().slice(0, 120),
        });
      }
    });
  }
}

writeFileSync(`${OUT}/sast-custom.json`, JSON.stringify({ findings: customFindings }, null, 2));
console.log(`[ SAST ] custom scanner: ${customFindings.length} findings`);

// ── Report ────────────────────────────────────────────────────────────────────

const allFindings = [...semgrepFindings, ...customFindings];

const bySeverity = {};
for (const f of allFindings) {
  const s = (f.severity ?? 'INFO').toUpperCase();
  (bySeverity[s] ??= []).push(f);
}

function findingTable(list) {
  if (!list.length) return '_None_\n';
  return [
    '| File | Line | Rule | Message |',
    '|---|---|---|---|',
    ...list.map(f => `| \`${f.file}\` | ${f.line ?? '—'} | \`${f.rule}\` | ${f.message.slice(0, 80)} |`),
  ].join('\n') + '\n';
}

const now = new Date().toISOString();

const report = `# SAST Report — Static Application Security Testing

**Scanned:** ${now}
**Source:** \`${args.src}/\`
**Semgrep:** ${semgrepAvailable ? `✅ available (${semgrepFindings.length} findings)` : '❌ not installed — install with `brew install semgrep` for full coverage'}
**Custom patterns:** ${customFindings.length} findings across ${PATTERNS.length} rules

## Summary

| Severity | Semgrep | Custom | Total |
|---|---|---|---|
${['CRITICAL', 'ERROR', 'HIGH', 'WARNING', 'MODERATE', 'LOW', 'INFO']
  .map(s => {
    const sg = semgrepFindings.filter(f => (f.severity ?? '').toUpperCase() === s).length;
    const cu = customFindings.filter(f => f.severity === s).length;
    return sg + cu > 0 ? `| ${s} | ${sg} | ${cu} | ${sg + cu} |` : null;
  })
  .filter(Boolean)
  .join('\n') || '| — | 0 | 0 | 0 |'}

---

## Findings by Severity

### 🔴 Critical / Error
${findingTable([...(bySeverity['CRITICAL'] ?? []), ...(bySeverity['ERROR'] ?? [])])}
### 🟠 High
${findingTable(bySeverity['HIGH'] ?? [])}
### 🟡 Moderate / Warning
${findingTable([...(bySeverity['MODERATE'] ?? []), ...(bySeverity['WARNING'] ?? [])])}
### 🔵 Low / Info
${findingTable([...(bySeverity['LOW'] ?? []), ...(bySeverity['INFO'] ?? [])])}

---

## Custom Rules Applied

| Rule | Severity | Description |
|---|---|---|
${PATTERNS.map(p => `| \`${p.id}\` | ${p.severity} | ${p.description} |`).join('\n')}

---

Raw data: \`${OUT}/sast-semgrep.json\`, \`${OUT}/sast-custom.json\`
`;

writeFileSync(`${OUT}/sast-report.md`, report);
console.log(`[ SAST ] Report written to ${OUT}/sast-report.md`);

const critical = (bySeverity['CRITICAL'] ?? []).length + (bySeverity['ERROR'] ?? []).length;
const high = (bySeverity['HIGH'] ?? []).length;
if (critical > 0 || high > 0) {
  console.error(`[ SAST ] FAIL — ${critical} critical/error, ${high} high severity findings`);
  process.exit(1);
}
console.log('[ SAST ] PASS — no critical or high severity findings');
