/**
 * SCA — Software Composition Analysis
 *
 * Runs two scans:
 *   1. npm audit — known CVEs in production + dev dependencies
 *   2. license-checker — licence inventory (flags GPL/AGPL for legal review)
 *
 * Produces:
 *   security-reports/sca-npm-audit.json   raw npm audit JSON
 *   security-reports/sca-licenses.json    licence inventory JSON
 *   security-reports/sca-report.md        human + LLM readable summary
 *
 * Usage:
 *   node scripts/scan-sca.mjs
 *   node scripts/scan-sca.mjs --prod-only   (skip devDependencies in audit)
 */

import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { 'prod-only': { type: 'boolean', default: false } },
  strict: false,
});

const OUT = 'security-reports';
mkdirSync(OUT, { recursive: true });

const COPYLEFT = ['GPL', 'AGPL', 'LGPL', 'EUPL', 'OSL', 'MPL', 'CDDL'];

// ── 1. npm audit ──────────────────────────────────────────────────────────────

console.log('[ SCA ] Running npm audit…');

const auditArgs = ['audit', '--json'];
if (args['prod-only']) auditArgs.push('--omit=dev');

const auditResult = spawnSync('npm', auditArgs, { encoding: 'utf8' });
let auditJson;
try {
  auditJson = JSON.parse(auditResult.stdout || '{}');
} catch {
  auditJson = { error: 'Failed to parse npm audit output', raw: auditResult.stdout };
}
writeFileSync(`${OUT}/sca-npm-audit.json`, JSON.stringify(auditJson, null, 2));

const vulns = auditJson.vulnerabilities ?? {};
const vulnList = Object.entries(vulns).map(([name, v]) => ({
  name,
  severity: v.severity,
  via: Array.isArray(v.via) ? v.via.map(x => (typeof x === 'string' ? x : x.title)).join(', ') : String(v.via),
  fixAvailable: v.fixAvailable,
  range: v.range,
}));

const bySeverity = { critical: [], high: [], moderate: [], low: [], info: [] };
for (const v of vulnList) {
  (bySeverity[v.severity] ?? bySeverity.info).push(v);
}

const auditMeta = auditJson.metadata ?? {};
const totalVulns = auditMeta.vulnerabilities
  ? Object.values(auditMeta.vulnerabilities).reduce((a, b) => a + b, 0)
  : vulnList.length;

console.log(`[ SCA ] npm audit: ${totalVulns} vulnerabilities found`);

// ── 2. licence-checker ────────────────────────────────────────────────────────

console.log('[ SCA ] Running license-checker…');

let licenseJson = {};
let licenseError = null;
try {
  const lcResult = spawnSync(
    'npx', ['--yes', 'license-checker', '--json', '--production'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  licenseJson = JSON.parse(lcResult.stdout || '{}');
} catch (err) {
  licenseError = err.message;
  console.warn(`[ SCA ] license-checker failed: ${licenseError}`);
}
writeFileSync(`${OUT}/sca-licenses.json`, JSON.stringify(licenseJson, null, 2));

const copyleftPkgs = Object.entries(licenseJson)
  .filter(([, v]) => COPYLEFT.some(l => (v.licenses ?? '').includes(l)))
  .map(([name, v]) => ({ name, license: v.licenses, repository: v.repository }));

console.log(`[ SCA ] license-checker: ${copyleftPkgs.length} copyleft packages`);

// ── Report ────────────────────────────────────────────────────────────────────

const totalPkgs = Object.keys(licenseJson).length;
const now = new Date().toISOString();

const severityIcon = { critical: '🔴', high: '🟠', moderate: '🟡', low: '🔵', info: '⚪' };

function vulnTable(list) {
  if (!list.length) return '_None_\n';
  return [
    '| Package | Via | Fix available | Range |',
    '|---|---|---|---|',
    ...list.map(v => `| \`${v.name}\` | ${v.via} | ${v.fixAvailable ? '✅' : '❌'} | ${v.range ?? '—'} |`),
  ].join('\n') + '\n';
}

const report = `# SCA Report — Software Composition Analysis

**Scanned:** ${now}
**Tool:** npm audit ${auditArgs.slice(1).join(' ')}, license-checker

## Summary

| Severity | Count |
|---|---|
| 🔴 Critical | ${bySeverity.critical.length} |
| 🟠 High | ${bySeverity.high.length} |
| 🟡 Moderate | ${bySeverity.moderate.length} |
| 🔵 Low | ${bySeverity.low.length} |
| **Total** | **${totalVulns}** |

Copyleft licences requiring legal review: **${copyleftPkgs.length}** of ${totalPkgs} production packages

---

## CVE Findings

### Critical
${vulnTable(bySeverity.critical)}
### High
${vulnTable(bySeverity.high)}
### Moderate
${vulnTable(bySeverity.moderate)}
### Low
${vulnTable(bySeverity.low)}

---

## Copyleft Licence Flags

${copyleftPkgs.length === 0
  ? '_No copyleft licences detected in production dependencies._\n'
  : [
      '| Package | Licence | Repository |',
      '|---|---|---|',
      ...copyleftPkgs.map(p => `| \`${p.name}\` | ${p.license} | ${p.repository ?? '—'} |`),
    ].join('\n') + '\n'
}

---

## Fix guidance

\`npm audit fix\` — resolves findings where fixAvailable is true without breaking changes.
\`npm audit fix --force\` — resolves remaining findings; may introduce breaking semver changes. Review the diff before committing.

Raw data: \`${OUT}/sca-npm-audit.json\`, \`${OUT}/sca-licenses.json\`
`;

writeFileSync(`${OUT}/sca-report.md`, report);
console.log(`[ SCA ] Report written to ${OUT}/sca-report.md`);

// ── Exit code ─────────────────────────────────────────────────────────────────
if (bySeverity.critical.length > 0 || bySeverity.high.length > 0) {
  console.error(`[ SCA ] FAIL — ${bySeverity.critical.length} critical, ${bySeverity.high.length} high severity vulnerabilities`);
  process.exit(1);
}
console.log('[ SCA ] PASS — no critical or high severity vulnerabilities');
