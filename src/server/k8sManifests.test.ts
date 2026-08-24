/**
 * Phase 1 — k8s security posture (TDD — these tests are RED before the fix).
 *
 * Asserts that server.yaml and worker.yaml have container-level securityContext
 * fields, and that networkpolicy.yaml declares an Ingress rule, and that
 * Dockerfile sets USER pwuser before CMD.
 *
 * RED reason (before fix):
 *   server.yaml and worker.yaml have no securityContext at all.
 *   networkpolicy.yaml has only policyTypes:[Egress].
 *   Dockerfile has no USER directive.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const K8S_BASE = join(__dirname, '../../deploy/k8s/base');

function readManifest(file: string): string {
  return readFileSync(join(K8S_BASE, file), 'utf8');
}

describe('k8s manifests — container securityContext', () => {
  for (const file of ['server.yaml', 'worker.yaml']) {
    describe(file, () => {
      const content = readManifest(file);

      it('has runAsNonRoot: true', () => {
        expect(content).toMatch(/runAsNonRoot:\s*true/);
      });

      it('has runAsUser: 1000 (pwuser)', () => {
        expect(content).toMatch(/runAsUser:\s*1000/);
      });

      it('has allowPrivilegeEscalation: false', () => {
        expect(content).toMatch(/allowPrivilegeEscalation:\s*false/);
      });

      it('drops ALL capabilities', () => {
        expect(content).toMatch(/drop:\s*\n\s*-\s*ALL/);
      });
    });
  }
});

describe('k8s manifests — Ingress NetworkPolicy', () => {
  const content = readManifest('networkpolicy.yaml');

  it('declares Ingress policyType', () => {
    expect(content).toContain('- Ingress');
  });

  it('allows traffic to port 3000', () => {
    expect(content).toMatch(/port:\s*3000/);
  });
});

describe('Dockerfile — USER directive', () => {
  it('sets USER pwuser before CMD', () => {
    const dockerfile = readFileSync(join(__dirname, '../../Dockerfile'), 'utf8');
    const userIdx = dockerfile.indexOf('USER pwuser');
    const cmdIdx = dockerfile.indexOf('\nCMD ');
    expect(userIdx, 'Dockerfile must contain USER pwuser').toBeGreaterThan(-1);
    expect(userIdx, 'USER pwuser must appear before CMD').toBeLessThan(cmdIdx);
  });
});
