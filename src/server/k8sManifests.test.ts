/**
 * k8s security posture — static manifest assertions.
 *
 * Phase 1: container securityContext, Ingress NetworkPolicy, Dockerfile USER.
 * Phase 2.2: STORE_SQLITE_PATH must be set to an absolute /tmp path in both
 *   the k8s configmap and docker-compose.yml, or UID 1000 cannot write the db.
 * Phase 8 / readOnlyRootFilesystem: /tmp and /dev/shm are already emptyDir
 *   volumes, so the root filesystem has no legitimate write target.
 *   Setting readOnlyRootFilesystem: true eliminates /home/pwuser as a writable
 *   path and is the last missing securityContext field.
 *
 * Phase 2.2 RED reason (before fix):
 *   configmap.yaml has no STORE_SQLITE_PATH at all; app defaults to 'crawl.db'
 *   relative to WORKDIR /app — UID 1000 cannot write there → CrashLoopBackOff.
 *
 * readOnlyRootFilesystem RED reason (before fix):
 *   securityContext in both server.yaml and worker.yaml has a comment saying
 *   "readOnlyRootFilesystem omitted: Chromium writes to /tmp at runtime" —
 *   but /tmp IS already an emptyDir mount, so the comment is wrong and the
 *   field is simply absent.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const K8S_BASE = join(__dirname, '../../deploy/k8s/base');
const REPO_ROOT = join(__dirname, '../..');

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

      it('has readOnlyRootFilesystem: true', () => {
        expect(content).toMatch(/readOnlyRootFilesystem:\s*true/);
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

describe('k8s + compose — SQLite write path (Phase 2.2)', () => {
  it('configmap.yaml sets STORE_SQLITE_PATH to an absolute /tmp path', () => {
    const content = readManifest('configmap.yaml');
    // Must be absolute — UID 1000 cannot write to the default 'crawl.db'
    // relative to /app (root-owned WORKDIR). /tmp is writable by all users.
    expect(content).toMatch(/STORE_SQLITE_PATH:\s*["']?\/tmp\//);
  });

  it('docker-compose.yml sets STORE_SQLITE_PATH to an absolute /tmp path', () => {
    const compose = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
    // The compose fix (commit 5ffb0dd) also needs to be guarded against revert.
    expect(compose).toMatch(/STORE_SQLITE_PATH:.*\/tmp\//);
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
