/**
 * SMI-5650 (Wave 1 + Wave 2) extension of worktree-override-root-mount.test.ts
 * (split into its own file per CLAUDE.md's 500-line guidance — see the
 * sibling file's header for the original SMI-5626 root-mount cases and
 * shared fixture/generator infrastructure).
 *
 * SMI-5650 (Wave 1): the 2 alias-scope tmpfs overlays (@skillsmith,
 * @smith-horn) are present once per service (dev/test, 4 total), and
 * the generated document parses as valid YAML with the exact
 * shape docker compose expects (`type: tmpfs`, `target:`, nested
 * `tmpfs: { size: 1048576 }`) — not just a string-match, an actual
 * YAML-parse structural check via the `yaml` package (already a transitive
 * devDependency, used elsewhere in scripts/tests).
 *
 * SMI-5650 (Wave 2) — REVISED after live verification. Docker Compose's
 * `type: tmpfs` volumes hardcode `noexec`, which broke native module
 * loading (execve() for esbuild's spawned CLI binary; dlopen()/
 * mmap(PROT_EXEC) for onnxruntime-node's and hnswlib-node's .node addons).
 * Native modules therefore do NOT share the alias scopes' tmpfs shape —
 * they get a plain Docker-managed named volume instead
 * (`native-seed-<sanitized-name>:/app/node_modules/<original-name>` per
 * service, `driver: local` declared once at the top level). A second
 * discovery added `@esbuild` (the scope directory) as a 5th native-module
 * entry, sanitized to `native-seed-esbuild-scope` (volume names can't
 * contain `@`).
 *
 * SMI-5750: each top-level native-seed volume declaration also carries an
 * `app.skillsmith.owned: "true"` label (added in enumerate_native_module_
 * volumes alongside `driver: local`) so prune-orphaned-docker-volumes.sh can
 * identify and auto-reclaim orphaned native-seed volumes -- these are the
 * numerically dominant orphan class (5 per worktree).
 *
 * Cases:
 *   6  Darwin: the 2 alias-scope tmpfs overlays present per service with
 *      valid YAML shape (Wave 1).
 *   7  Darwin: the 5 native-module volume-reference lines are present once
 *      per service (dev/test, 10 total, including the @esbuild
 *      -> native-seed-esbuild-scope sanitization), the generated override's
 *      top-level `volumes:` YAML key exists with exactly the 5 expected
 *      `driver: local` + `app.skillsmith.owned` entries (no driver_opts, no
 *      tmpfs annotation), and the root `:ro` mount precedes every
 *      native-module volume-reference line within each service (same order
 *      invariant as the alias-scope tmpfs entries) (Wave 2).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { createHarness, count } from './worktree-override-root-mount.helpers.js'

const h = createHarness()

beforeEach(() => {
  h.reset()
})

afterEach(() => {
  h.cleanup()
})

describe('SMI-5650 (Wave 1 + Wave 2): alias-scope tmpfs overlays and native-module named volumes', () => {
  it('Case 6 (Darwin, SMI-5650): alias-scope tmpfs overlays present per service with valid YAML shape', () => {
    const repoRoot = h.makeGeneratorFixture({ withRootNodeModules: true, withAliasScopes: true })
    const worktreePath = join(repoRoot, '.worktrees', 'wt1')
    const { status, stdout } = h.generate({
      worktreePath,
      branch: 'fix/smi-5650',
      repoRoot,
      uname: 'Darwin',
    })
    expect(status).toBe(0)

    // Text-level: both alias-scope tmpfs targets present, once per service.
    const skillsmithTarget = '        target: /app/node_modules/@skillsmith'
    const smithHornTarget = '        target: /app/node_modules/@smith-horn'
    expect(count(stdout, skillsmithTarget)).toBe(2)
    expect(count(stdout, smithHornTarget)).toBe(2)
    expect(count(stdout, '      - type: tmpfs')).toBe(4) // 2 scopes * 2 services
    expect(count(stdout, '          size: 1048576')).toBe(4)

    // Regression: pre-existing root/per-package mounts are untouched by
    // the new tmpfs entries.
    const rootMount = `      - ${repoRoot}/node_modules:/app/node_modules:ro`
    expect(count(stdout, rootMount)).toBe(2)
    const perPkg = `      - ${repoRoot}/packages/foo/node_modules:/app/packages/foo/node_modules:ro`
    expect(count(stdout, perPkg)).toBe(2)

    // Structural: the WHOLE generated document parses as valid YAML (not
    // just a string match), and each service's tmpfs entries have the
    // exact nested shape docker compose expects: `type: tmpfs`,
    // `target: <path>`, `tmpfs: { size: 1048576 }`.
    const doc = parseYaml(stdout) as {
      services: Record<string, { volumes?: Array<string | Record<string, unknown>> }>
    }
    for (const serviceName of ['dev', 'test']) {
      const volumes = doc.services[serviceName]?.volumes ?? []
      const tmpfsEntries = volumes.filter(
        (v): v is Record<string, unknown> =>
          typeof v === 'object' && v !== null && (v as Record<string, unknown>).type === 'tmpfs'
      )
      expect(tmpfsEntries, `service ${serviceName} tmpfs entries`).toHaveLength(2)
      const targets = tmpfsEntries.map((e) => e.target).sort()
      expect(targets).toEqual(['/app/node_modules/@skillsmith', '/app/node_modules/@smith-horn'])
      for (const entry of tmpfsEntries) {
        expect(entry.tmpfs).toEqual({ size: 1048576 })
      }
    }

    // Mount order (plan-review M1): within each service's volumes array,
    // the root :ro mount (a plain string entry) must precede both
    // alias-scope tmpfs entries (structured entries).
    for (const serviceName of ['dev', 'test']) {
      const volumes = doc.services[serviceName]!.volumes!
      const rootIdx = volumes.findIndex(
        (v) => typeof v === 'string' && v.endsWith(':/app/node_modules:ro')
      )
      const tmpfsIdxs = volumes
        .map((v, i) => ({ v, i }))
        .filter(
          ({ v }) =>
            typeof v === 'object' && v !== null && (v as Record<string, unknown>).type === 'tmpfs'
        )
        .map(({ i }) => i)
      expect(rootIdx, `service ${serviceName} root mount index`).toBeGreaterThanOrEqual(0)
      for (const tmpfsIdx of tmpfsIdxs) {
        expect(
          rootIdx,
          `service ${serviceName}: root mount must precede tmpfs index ${tmpfsIdx}`
        ).toBeLessThan(tmpfsIdx)
      }
    }
  })

  it('Case 7 (Darwin, SMI-5650 Wave 2): native-module volume references + top-level volumes: YAML declarations', () => {
    const repoRoot = h.makeGeneratorFixture({
      withRootNodeModules: true,
      withAliasScopes: true,
      withNativeModules: true,
    })
    const worktreePath = join(repoRoot, '.worktrees', 'wt1')
    const { status, stdout } = h.generate({
      worktreePath,
      branch: 'fix/smi-5650-wave2',
      repoRoot,
      uname: 'Darwin',
    })
    expect(status).toBe(0)

    // Text-level: each native module's volume-reference line, once per
    // service (dev/test). @esbuild sanitizes to
    // native-seed-esbuild-scope (volume names can't contain `@`).
    const nativeRefs: Array<[moduleName: string, volumeName: string]> = [
      ['better-sqlite3', 'native-seed-better-sqlite3'],
      ['onnxruntime-node', 'native-seed-onnxruntime-node'],
      ['esbuild', 'native-seed-esbuild'],
      ['hnswlib-node', 'native-seed-hnswlib-node'],
      ['@esbuild', 'native-seed-esbuild-scope'],
    ]
    for (const [moduleName, volumeName] of nativeRefs) {
      const line = `      - ${volumeName}:/app/node_modules/${moduleName}`
      expect(count(stdout, line), `expected "${line}" exactly 2 times (dev/test)`).toBe(2)
    }

    // Regression: the alias-scope tmpfs entries (Case 6) are unaffected by
    // native modules sharing the fixture — still exactly 4 (2 scopes * 2
    // services), and native modules do NOT add to that count (they use a
    // different shape entirely).
    expect(count(stdout, '      - type: tmpfs')).toBe(4)

    // Structural: parse the WHOLE document. Each service's volumes array
    // must contain the 5 native-seed volume-reference strings as plain
    // strings (NOT tmpfs objects — that shape is exclusive to the alias
    // scopes).
    const doc = parseYaml(stdout) as {
      services: Record<string, { volumes?: Array<string | Record<string, unknown>> }>
      volumes?: Record<string, unknown>
    }
    for (const serviceName of ['dev', 'test']) {
      const volumes = doc.services[serviceName]?.volumes ?? []
      const stringVolumes = volumes.filter((v): v is string => typeof v === 'string')
      for (const [moduleName, volumeName] of nativeRefs) {
        expect(stringVolumes, `service ${serviceName} volumes`).toContain(
          `${volumeName}:/app/node_modules/${moduleName}`
        )
      }
    }

    // Top-level `volumes:` YAML key: exactly the 5 expected named volumes,
    // each declared as `{ driver: 'local' }` — no driver_opts, no tmpfs
    // annotation at all (the fix for Compose's tmpfs-hardcodes-noexec
    // discovery is an ordinary named volume, not a tmpfs variant of it) —
    // plus the SMI-5750 `app.skillsmith.owned` ownership label so
    // prune-orphaned-docker-volumes.sh can identify and auto-reclaim
    // orphaned native-seed volumes.
    expect(doc.volumes, 'top-level volumes: key').toBeDefined()
    const topLevelVolumeNames = Object.keys(doc.volumes!).sort()
    expect(topLevelVolumeNames).toEqual(
      [
        'native-seed-better-sqlite3',
        'native-seed-onnxruntime-node',
        'native-seed-esbuild',
        'native-seed-hnswlib-node',
        'native-seed-esbuild-scope',
      ].sort()
    )
    for (const [name, decl] of Object.entries(doc.volumes!)) {
      expect(decl, `top-level volume declaration for ${name}`).toEqual({
        driver: 'local',
        labels: { 'app.skillsmith.owned': 'true' },
      })
    }

    // Mount order: the root :ro mount (a plain string) must precede every
    // native-module volume-reference line (also a plain string) within
    // each service's volumes array — same invariant Case 6 already proves
    // for the alias-scope tmpfs entries.
    for (const serviceName of ['dev', 'test']) {
      const volumes = doc.services[serviceName]!.volumes!
      const rootIdx = volumes.findIndex(
        (v) => typeof v === 'string' && v.endsWith(':/app/node_modules:ro')
      )
      expect(rootIdx, `service ${serviceName} root mount index`).toBeGreaterThanOrEqual(0)
      for (const [, volumeName] of nativeRefs) {
        const nativeIdx = volumes.findIndex(
          (v) => typeof v === 'string' && v.startsWith(`${volumeName}:/app/node_modules/`)
        )
        expect(
          nativeIdx,
          `service ${serviceName}: native volume-reference ${volumeName} index`
        ).toBeGreaterThanOrEqual(0)
        expect(
          rootIdx,
          `service ${serviceName}: root mount must precede native volume-reference ${volumeName} at index ${nativeIdx}`
        ).toBeLessThan(nativeIdx)
      }
    }
  })
})
