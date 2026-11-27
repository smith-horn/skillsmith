/**
 * SMI-7271: the WASM read-only remedy follows what the installed better-sqlite3
 * package can do, never the shape of its load error.
 *
 * The advice is derived from real package fixtures in a temp dir, shaped like
 * the two packages Skillsmith ships: 12.x (the MCP server's: an install script
 * and a binding.gyp, so it can build) and 13.0.3 (the CLI's, measured from its
 * tarball: `gypfile: false`, no install script, a binding.gyp it never uses,
 * and `prebuilds/<platform>-<arch>.node`, `./package.json` exported).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Module, { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { adviseFor, type NativePlatform } from '../../src/db/drivers/native-driver-advice.js'
import { isBetterSqlite3Available } from '../../src/db/drivers/betterSqlite3Driver.js'
import { wasmOpenNotice, wasmReadOnlyError, type WasmAdvice } from '../../src/db/wasm-read-only.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'smi7271-advice-'))
  mkdirSync(join(root, 'node_modules'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const LINUX_X64: NativePlatform = { platform: 'linux', arch: 'x64', isMusl: () => false }
const MUSL_X64: NativePlatform = { platform: 'linux', arch: 'x64', isMusl: () => true }

/**
 * Node's own resolution from inside the fixture, confined to it: a package
 * found above the fixture (the dev container has a `/node_modules`) counts as
 * not found, as it would on a machine without one.
 */
function fixtureResolve(request: string): string {
  const resolved = createRequire(join(root, 'probe.js')).resolve(request)
  if (!resolved.startsWith(root + sep)) {
    throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' })
  }
  return resolved
}

/** A better-sqlite3 package in the fixture's node_modules. */
function installPackage(manifest: object, files: Record<string, string> = {}): string {
  const pkg = join(root, 'node_modules', 'better-sqlite3')
  mkdirSync(join(pkg, 'prebuilds'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'better-sqlite3', ...manifest }))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(pkg, name), content)
  return pkg
}

const V12 = {
  version: '12.10.0',
  scripts: { install: 'prebuild-install || node-gyp rebuild --release' },
}
const V13 = {
  version: '13.0.3',
  gypfile: false,
  exports: { '.': './lib/index.js', './package.json': './package.json' },
}

describe('SMI-7271: advice from the installed package', () => {
  it('a package that does not resolve is not-installed', () => {
    expect(adviseFor(fixtureResolve, LINUX_X64)).toEqual({ kind: 'not-installed' })
  })

  it('a package whose manifest cannot be read is not-installed (a broken install)', () => {
    installPackage({})
    writeFileSync(join(root, 'node_modules', 'better-sqlite3', 'package.json'), '{ not json')
    expect(adviseFor(fixtureResolve, LINUX_X64)).toEqual({ kind: 'not-installed' })
  })

  it('12.x-like (an install script): rebuild', () => {
    installPackage(V12, { 'binding.gyp': '{}' })
    expect(adviseFor(fixtureResolve, LINUX_X64)).toEqual({ kind: 'rebuild' })
  })

  it('a binding.gyp with no gypfile:false and no script: rebuild (npm runs node-gyp)', () => {
    installPackage({ version: '12.0.0' }, { 'binding.gyp': '{}' })
    expect(adviseFor(fixtureResolve, LINUX_X64)).toEqual({ kind: 'rebuild' })
  })

  it('13.x-like with no prebuild for the platform: no-prebuilt, naming it', () => {
    installPackage(V13, { 'binding.gyp': '{}', 'prebuilds/darwin-arm64.node': 'x' })
    expect(adviseFor(fixtureResolve, LINUX_X64)).toEqual({
      kind: 'no-prebuilt',
      target: 'linux-x64',
    })
  })

  it('13.x-like with the prebuild present: prebuilt-failed', () => {
    installPackage(V13, { 'binding.gyp': '{}', 'prebuilds/linux-x64.node': 'x' })
    expect(adviseFor(fixtureResolve, LINUX_X64)).toEqual({
      kind: 'prebuilt-failed',
      target: 'linux-x64',
    })
  })

  it('musl uses the linuxmusl prebuild, as better-sqlite3 13 does', () => {
    installPackage(V13, { 'prebuilds/linux-x64.node': 'x' })
    expect(adviseFor(fixtureResolve, MUSL_X64)).toEqual({
      kind: 'no-prebuilt',
      target: 'linuxmusl-x64',
    })
    writeFileSync(join(root, 'node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node'), 'x')
    expect(adviseFor(fixtureResolve, MUSL_X64)).toEqual({
      kind: 'prebuilt-failed',
      target: 'linuxmusl-x64',
    })
  })

  it('an unsupported platform is no-prebuilt even with a matching file', () => {
    installPackage(V13, { 'prebuilds/freebsd-x64.node': 'x' })
    const freebsd: NativePlatform = { platform: 'freebsd', arch: 'x64', isMusl: () => false }
    expect(adviseFor(fixtureResolve, freebsd)).toEqual({
      kind: 'no-prebuilt',
      target: 'freebsd-x64',
    })
  })
})

describe('SMI-7271: a damaged 13.x prebuilt is never told to rebuild', () => {
  it('the real dlopen error does not pick the advice', () => {
    const pkg = installPackage(V13, {
      'binding.gyp': '{}',
      'prebuilds/linux-x64.node': 'not an ELF file, just text padding padding',
    })
    // The error Node really throws for this file, then thrown as the native
    // driver's load failure, so the process holds it as the recorded cause.
    let dlopenError: unknown
    try {
      createRequire(join(pkg, 'probe.js'))(join(pkg, 'prebuilds', 'linux-x64.node'))
    } catch (error) {
      dlopenError = error
    }
    expect((dlopenError as { code?: string }).code).toBe('ERR_DLOPEN_FAILED')
    const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
    const real = loader._load
    vi.spyOn(loader, '_load').mockImplementation(function (this: unknown, ...a: unknown[]) {
      if (a[0] === 'better-sqlite3') throw dlopenError
      return real.apply(this, a)
    })
    expect(isBetterSqlite3Available()).toBe(false)

    const advice = adviseFor(fixtureResolve, LINUX_X64)
    expect(advice).toEqual({ kind: 'prebuilt-failed', target: 'linux-x64' })
    const text = wasmOpenNotice('/home/u/.skillsmith/skills.db', 'existing', advice)
    expect(text).toContain('The prebuilt native SQLite driver for linux-x64 failed to load')
    expect(text).not.toContain('npm rebuild')
    expect(text).not.toContain('install scripts')
  })
})

describe('SMI-7271: the remedy text for each advice', () => {
  const path = '/home/u/.skillsmith/skills.db'
  const surfaces = [
    ['existing-file notice', (a: WasmAdvice | undefined) => wasmOpenNotice(path, 'existing', a)],
    ['first-run notice', (a: WasmAdvice | undefined) => wasmOpenNotice(path, 'first-run', a)],
    ['write refusal', (a: WasmAdvice | undefined) => wasmReadOnlyError(path, a).message],
  ] as const

  describe.each(surfaces)('%s', (_label, render) => {
    it('not-installed: reinstall with optional dependencies, never a rebuild', () => {
      const text = render({ kind: 'not-installed' })
      expect(text).toContain('better-sqlite3 is not installed')
      expect(text).toContain('without --omit=optional')
      expect(text).toContain('if npm reported that better-sqlite3 failed to install')
      expect(text).not.toContain('npm rebuild')
      expect(text).not.toContain('install scripts')
    })

    it('rebuild: npm rebuild or install scripts', () => {
      const text = render({ kind: 'rebuild' })
      expect(text).toContain('npm rebuild better-sqlite3')
      expect(text).toContain('install scripts enabled')
      expect(text).toContain('SKILLSMITH_DEBUG=1')
      expect(text).not.toContain('--omit=optional')
    })

    it('no-prebuilt: names the platform and the supported ones, never a rebuild', () => {
      const text = render({ kind: 'no-prebuilt', target: 'freebsd-x64' })
      expect(text).toContain('for this platform (freebsd-x64)')
      expect(text).toContain('darwin, linux, linuxmusl and win32, on x64 or arm64')
      expect(text).toContain('reads but cannot save')
      expect(text).toContain('SKILLSMITH_DEBUG=1')
      expect(text).not.toContain('npm rebuild')
      expect(text).not.toContain('install scripts')
    })

    it('prebuilt-failed: reinstall, never a rebuild', () => {
      const text = render({ kind: 'prebuilt-failed', target: 'linux-arm64' })
      expect(text).toContain('for linux-arm64 failed to load')
      expect(text).toContain('reinstall Skillsmith, then restart')
      expect(text).toContain('SKILLSMITH_DEBUG=1')
      expect(text).not.toContain('npm rebuild')
      expect(text).not.toContain('install scripts')
    })

    it('forced: names the variable', () => {
      const text = render({ kind: 'forced' })
      expect(text).toContain('SKILLSMITH_FORCE_WASM is set')
      expect(text).toContain('Unset SKILLSMITH_FORCE_WASM')
      expect(text).not.toContain('npm rebuild')
    })

    it('no captured advice: a reinstall, right for every install', () => {
      const text = render(undefined)
      expect(text).toContain('reinstall Skillsmith with its optional dependencies')
      expect(text).not.toContain('npm rebuild')
    })
  })
})
