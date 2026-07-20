/**
 * SMI-5626: Unit tests for the ROOT node_modules bind mount that
 * `enumerate_compose_node_modules_mounts` / `generate_docker_override_to_stdout`
 * (scripts/_lib.sh) now emit into a worktree's docker-compose.override.yml, and
 * for `worktree-docker.sh cmd_generate`'s delegation to that single generator.
 *
 * Why this exists: in a worktree compose project the base file's named volume
 * at /app/node_modules is unusable — the worktree's host-side relative symlink
 * (node_modules -> ../../node_modules) sits under the .:/app bind and mount(2)
 * follows symlinks resolving a bind destination, so root-hoisted deps (marked,
 * sanitize-html, …) are unreachable in the container. The fix mounts the MAIN
 * checkout's real root node_modules read-only, mirroring the per-package :ro
 * mounts. See the plan doc's Wave 1 Context section.
 *
 * SMI-5650 Wave 1/Wave 2 additions (alias-scope tmpfs overlays, native-module
 * named volumes) are split into the sibling
 * worktree-override-root-mount-smi5650.test.ts per CLAUDE.md's 500-line
 * guidance — shared fixture/generator infrastructure lives in
 * worktree-override-root-mount.helpers.ts.
 *
 * Cases:
 *   1  Darwin: root :ro mount emitted 2× (dev/test) + the two
 *      root .vite/.vite-temp overlays; pre-existing per-package line still
 *      present (regression — root mount must not displace per-package mounts).
 *   2  Darwin, no root node_modules dir: no root-mount line; per-package
 *      lines unaffected (mirrors the [[ -d ]] gating convention).
 *   3  Linux: no volumes block at all (existing Darwin gate unchanged) — also
 *      proves the gate suppresses the SMI-5650 alias-scope/native-module
 *      mechanisms, not only the pre-existing root/per-package mounts.
 *   4  Path with spaces in repo_root: root-mount line survives verbatim.
 *   5  Dual-platform invariant (plan-review Open Q2): main's real
 *      node_modules/@esbuild must carry a linux-* build, since the root :ro
 *      bind now makes every (Linux) worktree container depend on it.
 *   D  Delegation: worktree-docker.sh `generate` writes a file byte-for-byte
 *      identical (modulo the `Generated:` line) to
 *      generate_docker_override_to_stdout — proving the divergent heredoc was
 *      deleted, not partially delegated. Also carries the SMI-5650 alias-scope
 *      and native-module fixture directories, so the comparison covers those
 *      lines too, not only the pre-existing root/per-package ones.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeFixtureEnv } from './_lib/git-fixture-env.js'
import {
  createHarness,
  REPO_ROOT,
  REAL_BASH,
  WORKTREE_DOCKER_SCRIPT,
  NATIVE_MODULE_DIR_NAMES,
  count,
  stripGenerated,
} from './worktree-override-root-mount.helpers.js'

const h = createHarness()

beforeEach(() => {
  h.reset()
})

afterEach(() => {
  h.cleanup()
})

describe('SMI-5626: root node_modules bind mount in the worktree override', () => {
  it('Case 1 (Darwin): emits the root :ro mount 2× + both root overlays, per-package line intact', () => {
    const repoRoot = h.makeGeneratorFixture({ withRootNodeModules: true })
    const worktreePath = join(repoRoot, '.worktrees', 'wt1')
    const { status, stdout } = h.generate({
      worktreePath,
      branch: 'fix/smi-5626',
      repoRoot,
      uname: 'Darwin',
    })
    expect(status).toBe(0)

    const rootMount = `      - ${repoRoot}/node_modules:/app/node_modules:ro`
    // Once per service (dev/test).
    expect(count(stdout, rootMount)).toBe(2)

    // Writable root cache overlays (NOT :ro), one per service.
    const viteOverlay = `      - ${repoRoot}/node_modules/.vite:/app/node_modules/.vite`
    const viteTempOverlay = `      - ${repoRoot}/node_modules/.vite-temp:/app/node_modules/.vite-temp`
    expect(count(stdout, viteOverlay)).toBe(2)
    expect(count(stdout, viteTempOverlay)).toBe(2)
    expect(stdout).not.toContain(`${viteOverlay}:ro`)

    // Regression: the pre-existing per-package :ro mount must still be present.
    const perPkg = `      - ${repoRoot}/packages/foo/node_modules:/app/packages/foo/node_modules:ro`
    expect(count(stdout, perPkg)).toBe(2)

    // v5 marker label bumped (SMI-5650).
    expect(stdout).toContain('# SMI-4689/SMI-5560/SMI-5626/SMI-5650 bind mounts v5')

    // No alias-scope tmpfs entries in THIS fixture (no @skillsmith/@smith-horn
    // dirs created) — regression guard that the tmpfs gate stays [[ -d ]]-only.
    expect(stdout).not.toContain('type: tmpfs')
  })

  it('Case 2 (Darwin, no root node_modules): no root-mount line; per-package lines unaffected', () => {
    const repoRoot = h.makeGeneratorFixture({ withRootNodeModules: false })
    const worktreePath = join(repoRoot, '.worktrees', 'wt1')
    const { status, stdout } = h.generate({
      worktreePath,
      branch: 'fix/smi-5626',
      repoRoot,
      uname: 'Darwin',
    })
    expect(status).toBe(0)

    // No root mount (gated on the [[ -d node_modules ]] check).
    expect(stdout).not.toContain(':/app/node_modules:ro')
    expect(stdout).not.toContain('/app/node_modules/.vite')

    // Per-package mounts still emitted.
    const perPkg = `      - ${repoRoot}/packages/foo/node_modules:/app/packages/foo/node_modules:ro`
    expect(count(stdout, perPkg)).toBe(2)
  })

  it('Case 3 (Linux): no volumes block at all (Darwin gate unchanged)', () => {
    // SMI-5650: withAliasScopes + withNativeModules true — the alias-scope
    // AND native-module directories DO exist on disk here, proving the
    // Darwin-only gate suppresses BOTH the tmpfs entries and the
    // native-module volume-reference lines / top-level volumes: key, not
    // only the pre-existing root/per-package mounts.
    const repoRoot = h.makeGeneratorFixture({
      withRootNodeModules: true,
      withAliasScopes: true,
      withNativeModules: true,
    })
    const worktreePath = join(repoRoot, '.worktrees', 'wt1')
    const { status, stdout } = h.generate({
      worktreePath,
      branch: 'fix/smi-5626',
      repoRoot,
      uname: 'Linux',
    })
    expect(status).toBe(0)
    expect(stdout).not.toContain('volumes:')
    expect(stdout).not.toContain('/app/node_modules')
    expect(stdout).not.toContain(':ro')
    expect(stdout).not.toContain('type: tmpfs')
    expect(stdout).not.toContain('@skillsmith')
    expect(stdout).not.toContain('@smith-horn')
    expect(stdout).not.toContain('native-seed-')
    expect(stdout).not.toContain('driver: local')
    // Sanity: it is still a valid override (container names present).
    expect(stdout).toContain('container_name: smi-5626-dev-1')
  })

  it('Case 4 (Darwin, spaces in repo_root): root-mount line survives verbatim', () => {
    const repoRoot = h.makeGeneratorFixture({
      withRootNodeModules: true,
      prefix: 'wt root mount has space',
    })
    const worktreePath = join(repoRoot, '.worktrees', 'wt1')
    const { status, stdout } = h.generate({
      worktreePath,
      branch: 'fix/smi-5626',
      repoRoot,
      uname: 'Darwin',
    })
    expect(status).toBe(0)
    expect(stdout).toContain(`      - ${repoRoot}/node_modules:/app/node_modules:ro`)
  })

  it('Case 5: main node_modules/@esbuild carries a linux-* build (dual-platform invariant, plan-review Open Q2)', () => {
    const esbuildDir = join(REPO_ROOT, 'node_modules', '@esbuild')
    expect(
      existsSync(esbuildDir),
      `${esbuildDir} does not exist — deps are not installed. The SMI-5626 root :ro bind ` +
        `requires main's node_modules/@esbuild to carry a linux-* build for worktree containers.`
    ).toBe(true)

    const entries = readdirSync(esbuildDir)
    const linux = entries.filter((e) => e.startsWith('linux-'))
    const darwin = entries.filter((e) => e.startsWith('darwin-'))
    expect(
      linux.length,
      `node_modules/@esbuild has only darwin variant(s) [${darwin.join(', ')}] and no linux-* build. ` +
        `The SMI-5626 root :ro bind mounts main's node_modules into every worktree's LINUX container, ` +
        `so a linux-* @esbuild build must persist in main's host tree. Present: [${entries.join(', ')}].`
    ).toBeGreaterThan(0)
  })
})

describe('SMI-5626: worktree-docker.sh cmd_generate delegation', () => {
  it('Case D (Darwin): generate writes a file identical to generate_docker_override_to_stdout (modulo Generated:)', () => {
    const repoRoot = h.tempDir('wt-root-mount-deleg')
    const env = makeFixtureEnv()

    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', repoRoot], { env })
    // Filesystem state the volumes block reads (main checkout, host tree).
    mkdirSync(join(repoRoot, 'node_modules', '.vite'), { recursive: true })
    // SMI-5650: alias-scope dirs too, so the byte-identical delegation
    // comparison below covers the new tmpfs lines, not only the
    // pre-existing root/per-package ones.
    mkdirSync(join(repoRoot, 'node_modules', '@skillsmith'), { recursive: true })
    mkdirSync(join(repoRoot, 'node_modules', '@smith-horn'), { recursive: true })
    // SMI-5650 Wave 2: native-module dirs too (including the @esbuild
    // scope), so the byte-identical comparison below also covers the
    // native-module volume-reference lines and the top-level volumes: key.
    for (const name of NATIVE_MODULE_DIR_NAMES) {
      mkdirSync(join(repoRoot, 'node_modules', name), { recursive: true })
    }
    mkdirSync(join(repoRoot, 'packages', 'foo', 'node_modules'), { recursive: true })
    writeFileSync(join(repoRoot, 'packages', 'foo', 'package.json'), '{}\n', 'utf8')
    // cmd_generate guards on a docker-compose.yml in the worktree.
    writeFileSync(join(repoRoot, 'docker-compose.yml'), 'services: {}\n', 'utf8')
    execFileSync('git', ['-C', repoRoot, 'add', '-A'], { env })
    execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', 'init'], { env })

    const worktreePath = join(repoRoot, '.worktrees', 'wt1')
    const branch = 'fix/smi-5626-deleg'
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '-q', '-b', branch, worktreePath], {
      env,
    })

    const shimPath = h.unameShimPath('Darwin')

    // Actual: run the real cmd_generate end-to-end (sources _lib.sh internally).
    const gen = spawnSync(REAL_BASH, [WORKTREE_DOCKER_SCRIPT, 'generate', worktreePath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...env, PATH: shimPath },
      timeout: 20_000,
    })
    expect(gen.status, gen.stdout + (gen.stderr ?? '')).toBe(0)
    const actualFile = join(worktreePath, 'docker-compose.override.yml')
    expect(existsSync(actualFile)).toBe(true)
    const actual = readFileSync(actualFile, 'utf8')

    // Expected: the single generator, with the same derived args.
    const expected = h.generate({ worktreePath, branch, repoRoot, uname: 'Darwin' }).stdout

    expect(stripGenerated(actual)).toBe(stripGenerated(expected))
    // And the delegated output really does carry the volumes block (not the
    // old volumes-less heredoc), including the SMI-5650 alias-scope tmpfs
    // overlays — the delegation isn't just equal on the pre-existing lines,
    // it carries the new ones through too.
    expect(actual).toContain('# SMI-4689/SMI-5560/SMI-5626/SMI-5650 bind mounts v5')
    expect(actual).toContain(`${repoRoot}/node_modules:/app/node_modules:ro`)
    expect(actual).toContain('        target: /app/node_modules/@skillsmith')
    expect(actual).toContain('        target: /app/node_modules/@smith-horn')
    // SMI-5650 Wave 2: native-module volume-reference lines and the
    // top-level volumes: key also carry through delegation, not just the
    // alias-scope tmpfs overlays.
    expect(actual).toContain('      - native-seed-better-sqlite3:/app/node_modules/better-sqlite3')
    expect(actual).toContain('      - native-seed-esbuild-scope:/app/node_modules/@esbuild')
    expect(actual).toContain('\nvolumes:\n')
    expect(actual).toContain('  native-seed-esbuild-scope:\n    driver: local')
  })
})
