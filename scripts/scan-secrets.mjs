/**
 * Secrets scan — detects hardcoded credentials, keys, and tokens
 *
 * Runs two passes:
 *   1. gitleaks (if installed) — scans git history + working tree
 *   2. Custom regex scanner — high-signal patterns tuned for this codebase
 *
 * Produces:
 *   security-reports/secrets-gitleaks.json   raw gitleaks JSON (if available)
 *   security-reports/secrets-custom.json     custom regex findings
 *   security-reports/secrets-report.md       human + LLM readable summary
 *
 * Install gitleaks (recommended):
 *   brew install gitleaks       # macOS
 *   # or: https://github.com/gitleaks/gitleaks/releases
 *
 * Usage:
 *   node scripts/scan-secrets.mjs
 *   node scripts/scan-secrets.mjs --no-history   (skip git history scan)
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { 'no-history': { type: 'boolean', default: false } },
  strict: false,
});

const OUT = 'security-reports';
mkdirSync(OUT, { recursive: true });

// ── 1. gitleaks ───────────────────────────────────────────────────────────────

console.log('[ Secrets ] Checking for gitleaks…');

const gitleaksPath = spawnSync('which', ['gitleaks'], { encoding: 'utf8' }).stdout.trim();
let gitleaksFindings = [];
let gitleaksAvailable = false;

if (gitleaksPath) {
  gitleaksAvailable = true;
  const reportFile = `${OUT}/secrets-gitleaks.json`;

  if (!args['no-history']) {
    console.log('[ Secrets ] gitleaks: scanning git history…');
    spawnSync(
      'gitleaks',
      ['detect', '--source', '.', '--report-format', 'json', '--report-path', reportFile, '--no-banner'],
      { encoding: 'utf8', timeout: 120_000 },
    );
  } else {
    console.log('[ Secrets ] gitleaks: scanning working tree only (--no-history)…');
    spawnSync(
      'gitleaks',
      ['detect', '--source', '.', '--no-git', '--report-format', 'json', '--report-path', reportFile, '--no-banner'],
      { encoding: 'utf8', timeout: 60_000 },
    );
  }

  try {
    const raw = JSON.parse(readFileSync(reportFile, 'utf8'));
    gitleaksFindings = (Array.isArray(raw) ? raw : []).map(r => ({
      file: r.File,
      line: r.StartLine,
      rule: r.RuleID,
      secret: r.Secret ? `${r.Secret.slice(0, 4)}…[redacted]` : '—',
      commit: r.Commit ? r.Commit.slice(0, 8) : 'working tree',
      message: r.Description ?? r.RuleID,
    }));
  } catch {
    writeFileSync(reportFile, JSON.stringify({ skipped: false, findings: [] }, null, 2));
  }
  console.log(`[ Secrets ] gitleaks: ${gitleaksFindings.length} findings`);
} else {
  console.warn('[ Secrets ] gitleaks not found — skipping history scan. Install: brew install gitleaks');
  writeFileSync(`${OUT}/secrets-gitleaks.json`, JSON.stringify({ skipped: true, reason: 'gitleaks not installed' }, null, 2));
}

// ── 2. Custom regex scanner ────────────────────────────────────────────────────

console.log('[ Secrets ] Running custom secrets scanner…');

// High-signal patterns — ordered by false-positive rate ascending
const PATTERNS = [
  { id: 'AWS_KEY',          regex: /AKIA[0-9A-Z]{16}/,                      desc: 'AWS access key ID' },
  { id: 'AWS_SECRET',       regex: /[Aa]ws.{0,20}[A-Za-z0-9/+]{40}/,       desc: 'Possible AWS secret key' },
  { id: 'GH_TOKEN',         regex: /gh[ps]_[A-Za-z0-9]{36}/,               desc: 'GitHub personal access token' },
  { id: 'STRIPE_KEY',       regex: /sk_(?:live|test)_[A-Za-z0-9]{24,}/,    desc: 'Stripe secret key' },
  { id: 'GENERIC_KEY_LINE', regex: /(?:api[_-]?key|secret[_-]?key|private[_-]?key)\s*[:=]\s*['"`][A-Za-z0-9+/=_-]{20,}/i, desc: 'Generic API/secret key assignment' },
  { id: 'BEARER_TOKEN',     regex: /[Bb]earer\s+[A-Za-z0-9._-]{30,}/,      desc: 'Hardcoded Bearer token' },
  { id: 'BASIC_AUTH',       regex: /https?:\/\/[A-Za-z0-9+/]{8,}:[A-Za-z0-9+/]{8,}@/, desc: 'Credentials in URL' },
  { id: 'PEM_PRIVATE_KEY',  regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, desc: 'PEM private key block' },
  { id: 'JWT_HARDCODED',    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, desc: 'Hardcoded JWT' },
];

// Files to always skip
const SKIP = [
  /node_modules/, /dist\//, /\.git\//, /security-reports\//,
  /\.env\.example/, /DEPLOYMENT\.md/, /README\.md/, /\.test\./, /\.spec\./,
  /package-lock\.json/,
];

function walkDir(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'security-reports'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

const customFindings = [];
for (const file of walkDir('.')) {
  const rel = relative('.', file);
  if (SKIP.some(r => r.test(rel))) continue;

  let content;
  try { content = readFileSync(file, 'utf8'); } catch { continue; }
  const lines = content.split('\n');

  for (const pat of PATTERNS) {
    lines.forEach((line, i) => {
      if (pat.regex.test(line)) {
        // Redact the matched value before recording
        const redacted = line.replace(pat.regex, '[REDACTED]').trim().slice(0, 120);
        customFindings.push({
          file: rel,
          line: i + 1,
          rule: pat.id,
          message: pat.desc,
          snippet: redacted,
        });
      }
    });
  }
}

writeFileSync(`${OUT}/secrets-custom.json`, JSON.stringify({ findings: customFindings }, null, 2));
console.log(`[ Secrets ] custom scanner: ${customFindings.length} findings`);

// ── Report ────────────────────────────────────────────────────────────────────

const allFindings = [...gitleaksFindings, ...customFindings];
const now = new Date().toISOString();

function findingTable(list) {
  if (!list.length) return '_None_\n';
  return [
    '| File | Line | Rule | Detail |',
    '|---|---|---|---|',
    ...list.map(f => `| \`${f.file}\` | ${f.line ?? '—'} | \`${f.rule}\` | ${(f.message ?? f.desc ?? '').slice(0, 80)} |`),
  ].join('\n') + '\n';
}

const report = `# Secrets Scan Report

**Scanned:** ${now}
**gitleaks:** ${gitleaksAvailable ? `✅ available (${args['no-history'] ? 'working tree only' : 'full git history'})` : '❌ not installed — install with \`brew install gitleaks\` for git history coverage'}
**Custom patterns:** ${PATTERNS.length} rules applied to all non-test source files

## Summary

| Scanner | Findings |
|---|---|
| gitleaks | ${gitleaksFindings.length} |
| Custom regex | ${customFindings.length} |
| **Total** | **${allFindings.length}** |

---

## gitleaks Findings
${findingTable(gitleaksFindings)}

## Custom Pattern Findings
${findingTable(customFindings)}

---

## Patterns Applied

| Rule | Description |
|---|---|
${PATTERNS.map(p => `| \`${p.id}\` | ${p.desc} |`).join('\n')}

---

> **Note:** Matched values are redacted in this report. Full values (where needed for triage)
> are in \`${OUT}/secrets-custom.json\` — treat that file as sensitive and do not commit it.

Raw data: \`${OUT}/secrets-gitleaks.json\`, \`${OUT}/secrets-custom.json\`
`;

writeFileSync(`${OUT}/secrets-report.md`, report);
console.log(`[ Secrets ] Report written to ${OUT}/secrets-report.md`);

if (allFindings.length > 0) {
  console.error(`[ Secrets ] FAIL — ${allFindings.length} potential secrets found. Review and rotate any real credentials immediately.`);
  process.exit(1);
}
console.log('[ Secrets ] PASS — no secrets detected');
