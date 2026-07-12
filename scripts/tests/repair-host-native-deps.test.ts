/**
 * SMI-5654 — vitest harness for scripts/repair-host-native-deps.sh's esbuild
 * platform-package hardening.
 *
 * Context: a host `node_modules` tree was found with `node_modules/esbuild/bin/esbuild`
 * (the CLI dispatch entry point) hard-linked to `node_modules/@esbuild/linux-arm64/bin/esbuild`,
 * both corrupted to the WRONG platform's binary content by an earlier `cp` onto the
 * existing (hard-linked) file — an in-place write that corrupted the shared inode
 * instead of replacing the directory entry. The pre-existing JS-API probe
 * (`require('esbuild').transformSync('')`) never executes the CLI dispatch entry, so
 * it passed silently throughout. This adds two probes plus rm-then-cp repairs:
 *
 *   (a) CLI-dispatch probe — `node_modules/.bin/esbuild --version` must exit 0 with
 *       non-empty stdout; on failure (while the JS-API probe passes), re-derive the
 *       dispatch binary from the verified-good `@esbuild/<platform>-<arch>` package.
 *   (b) Foreign-platform content check — every `@esbuild/linux-<arch>` package's `bin/esbuild`
 *       must begin with ELF magic bytes; on mismatch, refetch that platform package.
 *       This is the check that would have caught the actual incident end-state (the
 *       CLI dispatch itself was left in a WORKING state by the erroneous fix, only the
 *       foreign platform package's own file was wrong).
 *
 * Drives the bash script via spawnSync with:
 *   SKILLSMITH_NATIVE_DEPS_TEST=1              — master switch; enables every seam below
 *   SKILLSMITH_NATIVE_DEPS_REPO_ROOT=<fixture>  — operate on a fixture tree, NEVER the real repo
 *   SKILLSMITH_NATIVE_DEPS_FORCE_NON_DOCKER=1   — bypass the Docker no-op guard (CI runs vitest IN Docker)
 *   SKILLSMITH_NATIVE_DEPS_TEST_PLATFORM/_ARCH  — force the darwin-only gate open under Linux CI
 *   SKILLSMITH_NATIVE_DEPS_ESBUILD_API_PROBE    — control whether the pre-existing JS-API probe passes/fails
 *   SKILLSMITH_NATIVE_DEPS_FETCH_CMD            — stub the `npm pack` refetch so tests never hit the network
 *
 * Precedent: scripts/tests/retrieval-autoheal.test.ts drives a sibling bash
 * orchestrator the same way. Test mode exits immediately after the esbuild
 * platform-package phase (before the unrelated better-sqlite3 rebuild phase),
 * so nothing here can trigger a real native rebuild.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'repair-host-native-deps.sh')

const ESBUILD_VERSION = '0.28.1'
const GOOD_SCRIPT = `#!/bin/sh\necho "${ESBUILD_VERSION}"\n`
const BROKEN_SCRIPT = `#!/bin/sh\nexit 1\n`
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const MACHO_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe])

// ── Cleanup tracking ──────────────────────────────────────────────────────────

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

function makeFixtureRoot(): string {
  const d = makeFixtureTempDir('repair-host-native-deps-fixture')
  tmpDirs.push(d)
  return d
}

// ── Fixture builders ──────────────────────────────────────────────────────────

function writeExecutable(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
  chmodSync(path, 0o755)
}

/** Seeds the darwin-arm64 platform package: the "verified-good" source every
 * dispatch/foreign-platform repair derives from in these tests. */
function seedDarwinPlatform(root: string): void {
  mkdirSync(join(root, 'node_modules', 'esbuild'), { recursive: true })
  writeFileSync(
    join(root, 'node_modules', 'esbuild', 'package.json'),
    JSON.stringify({ name: 'esbuild', version: ESBUILD_VERSION }),
    'utf8'
  )
  mkdirSync(join(root, 'node_modules', '@esbuild', 'darwin-arm64'), { recursive: true })
  writeFileSync(
    join(root, 'node_modules', '@esbuild', 'darwin-arm64', 'package.json'),
    JSON.stringify({ name: '@esbuild/darwin-arm64', version: ESBUILD_VERSION }),
    'utf8'
  )
  writeExecutable(
    join(root, 'node_modules', '@esbuild', 'darwin-arm64', 'bin', 'esbuild'),
    GOOD_SCRIPT
  )
}

/** Mirrors real npm: node_modules/.bin/esbuild -> ../esbuild/bin/esbuild (relative symlink). */
function symlinkCliBin(root: string): void {
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
  symlinkSync('../esbuild/bin/esbuild', join(root, 'node_modules', '.bin', 'esbuild'))
}

function dispatchPath(root: string): string {
  return join(root, 'node_modules', 'esbuild', 'bin', 'esbuild')
}

function linuxBinPath(root: string, arch = 'arm64'): string {
  return join(root, 'node_modules', '@esbuild', `linux-${arch}`, 'bin', 'esbuild')
}

// ── Run helper ────────────────────────────────────────────────────────────────

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

function runScript(root: string, extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...makeFixtureEnv(),
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      SKILLSMITH_NATIVE_DEPS_TEST: '1',
      SKILLSMITH_NATIVE_DEPS_REPO_ROOT: root,
      SKILLSMITH_NATIVE_DEPS_FORCE_NON_DOCKER: '1',
      SKILLSMITH_NATIVE_DEPS_TEST_PLATFORM: 'darwin',
      SKILLSMITH_NATIVE_DEPS_TEST_ARCH: 'arm64',
      // Default: JS-API probe passes. Individual tests override as needed.
      SKILLSMITH_NATIVE_DEPS_ESBUILD_API_PROBE: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

// ── Static-source assertions ──────────────────────────────────────────────────

describe('static-source assertions', () => {
  const src = readFileSync(SCRIPT, 'utf8')

  it('contains the mandatory SMI-5654 rm-then-cp rationale comment at the dispatch fix site', () => {
    expect(src).toContain('SMI-5654: rm-then-cp is mandatory here — a plain cp onto the existing')
    expect(src).toContain('(possibly hard-linked) dispatch binary writes into the shared inode in')
    expect(src).toContain("place and corrupts the platform package's binary too.")
  })

  it('references SMI-5352 as the container-side sibling gap', () => {
    expect(src).toContain('SMI-5352')
  })

  it('test seams are gated behind a single SKILLSMITH_NATIVE_DEPS_TEST master switch', () => {
    expect(src).toContain('NATIVE_DEPS_TEST="${SKILLSMITH_NATIVE_DEPS_TEST:-}"')
  })
})

// ── CLI-dispatch probe (check a) ──────────────────────────────────────────────

describe('esbuild CLI-dispatch probe', () => {
  it('dispatch corrupted while JS-API probe passes → detected and repaired via rm-then-cp', () => {
    const root = makeFixtureRoot()
    seedDarwinPlatform(root)
    writeExecutable(dispatchPath(root), BROKEN_SCRIPT)
    symlinkCliBin(root)

    const { status, stdout } = runScript(root)

    expect(status).toBe(0)
    expect(stdout).toContain(
      'esbuild CLI dispatch (node_modules/esbuild/bin/esbuild) broken while the JS API still works'
    )
    expect(stdout).toContain('esbuild CLI dispatch repaired')
    expect(readFileSync(dispatchPath(root), 'utf8')).toBe(GOOD_SCRIPT)
  })

  it('healthy tree → probes pass, no repair triggered (no false positive)', () => {
    const root = makeFixtureRoot()
    seedDarwinPlatform(root)
    writeExecutable(dispatchPath(root), GOOD_SCRIPT)
    symlinkCliBin(root)
    mkdirSync(dirname(linuxBinPath(root)), { recursive: true })
    writeFileSync(linuxBinPath(root), Buffer.concat([ELF_MAGIC, Buffer.from('healthy')]))
    chmodSync(linuxBinPath(root), 0o755)

    const beforeInode = statSync(dispatchPath(root)).ino

    const { status, stdout } = runScript(root)

    expect(status).toBe(0)
    expect(stdout).toContain('esbuild CLI dispatch already works')
    expect(stdout).not.toContain('esbuild CLI dispatch repaired')
    expect(stdout).not.toContain('is not an ELF binary')
    expect(statSync(dispatchPath(root)).ino).toBe(beforeInode)
  })

  it('repair never overwrites the dispatch binary in place — a hardlinked twin outside the corrupted path survives untouched', () => {
    const root = makeFixtureRoot()
    seedDarwinPlatform(root)
    writeExecutable(dispatchPath(root), BROKEN_SCRIPT)
    symlinkCliBin(root)

    // Hardlink twin OUTSIDE @esbuild/linux-*, so the foreign-platform ELF
    // check (a separate probe) never touches it — isolates this assertion to
    // the CLI-dispatch repair's own rm-then-cp behavior, the exact mechanism
    // of the original SMI-5654 corruption (a `cp` writing into a shared,
    // hard-linked inode in place).
    const canaryPath = join(root, 'node_modules', '.hardlink-canary', 'esbuild')
    mkdirSync(dirname(canaryPath), { recursive: true })
    linkSync(dispatchPath(root), canaryPath)

    const beforeDispatchInode = statSync(dispatchPath(root)).ino
    const beforeCanaryInode = statSync(canaryPath).ino
    // Sanity: the fixture really is hard-linked before the repair runs.
    expect(beforeCanaryInode).toBe(beforeDispatchInode)

    const { status } = runScript(root)

    expect(status).toBe(0)
    const afterDispatchInode = statSync(dispatchPath(root)).ino
    const afterCanaryInode = statSync(canaryPath).ino

    // The dispatch binary got a brand-new inode (rm removed the directory
    // entry; cp created a new file) ...
    expect(afterDispatchInode).not.toBe(beforeDispatchInode)
    // ... while the canary twin kept its ORIGINAL inode and content — proving
    // the repair never wrote into the shared inode in place (the bug this
    // hardening exists to prevent recurring).
    expect(afterCanaryInode).toBe(beforeCanaryInode)
    expect(readFileSync(canaryPath, 'utf8')).toBe(BROKEN_SCRIPT)
  })
})

// ── Foreign-platform ELF content check (check b) ──────────────────────────────

describe('esbuild foreign-platform ELF content check', () => {
  // Stub the `npm pack` refetch: writes a fresh ELF-magic binary to the
  // requested dest without any network access.
  const GOOD_ELF_FETCH_CMD =
    'mkdir -p "$SKILLSMITH_NATIVE_DEPS_FETCH_DEST/bin" && ' +
    'printf "\\177ELFfakegood" > "$SKILLSMITH_NATIVE_DEPS_FETCH_DEST/bin/esbuild" && ' +
    'chmod +x "$SKILLSMITH_NATIVE_DEPS_FETCH_DEST/bin/esbuild"'

  it('non-ELF @esbuild/linux-*/bin/esbuild is detected and repaired via rm-then-cp', () => {
    const root = makeFixtureRoot()
    seedDarwinPlatform(root)
    writeExecutable(dispatchPath(root), GOOD_SCRIPT)
    symlinkCliBin(root)

    const linuxBin = linuxBinPath(root)
    mkdirSync(dirname(linuxBin), { recursive: true })
    // Mach-O magic instead of ELF — the SMI-5654 incident's actual corrupted
    // end-state (the linux-arm64 package held darwin/Mach-O content).
    writeFileSync(linuxBin, Buffer.concat([MACHO_MAGIC, Buffer.from('garbage')]))
    chmodSync(linuxBin, 0o755)

    const { status, stdout } = runScript(root, {
      SKILLSMITH_NATIVE_DEPS_FETCH_CMD: GOOD_ELF_FETCH_CMD,
    })

    expect(status).toBe(0)
    expect(stdout).toContain('@esbuild/linux-arm64 repaired')
    const magic = readFileSync(linuxBin).subarray(0, 4)
    expect(magic).toEqual(ELF_MAGIC)
  })

  it('ELF-magic @esbuild/linux-*/bin/esbuild is left untouched', () => {
    const root = makeFixtureRoot()
    seedDarwinPlatform(root)
    writeExecutable(dispatchPath(root), GOOD_SCRIPT)
    symlinkCliBin(root)

    const linuxBin = linuxBinPath(root)
    mkdirSync(dirname(linuxBin), { recursive: true })
    writeFileSync(linuxBin, Buffer.concat([ELF_MAGIC, Buffer.from('deadbeef')]))
    chmodSync(linuxBin, 0o755)
    const beforeInode = statSync(linuxBin).ino
    const beforeContent = readFileSync(linuxBin)

    // No SKILLSMITH_NATIVE_DEPS_FETCH_CMD provided — a healthy fixture must
    // never reach the refetch path (which would otherwise hit the network).
    const { status, stdout } = runScript(root)

    expect(status).toBe(0)
    expect(stdout).not.toContain('is not an ELF binary')
    expect(statSync(linuxBin).ino).toBe(beforeInode)
    expect(readFileSync(linuxBin)).toEqual(beforeContent)
  })
})
