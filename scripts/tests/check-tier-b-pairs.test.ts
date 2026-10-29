/**
 * SMI-7201 Wave 1 -- tests for scripts/lib/check-tier-b-pairs.mjs.
 *
 * See docs/internal/implementation/smi-7201-tier-b-seed-pair-drift.md
 * (What Changes 1, Wave 1 Step 2). Fixture trees are built in a temp dir per
 * test: <app>/package-lock.json, <app>/<path>/package.json, and
 * <seed>/<path>.version. The script takes its roots as arguments, so no
 * container and no test seam is needed.
 *
 * The assertions are on properties: the exit code, and WHICH paths (and which
 * parents) are named as mismatching. They deliberately do not match message
 * wording.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkTierBPairs } from '../lib/check-tier-b-pairs.mjs'

type Json = Record<string, unknown>

interface Fixture {
  /** package-lock.json `packages` map. */
  packages: Record<string, Json>
  /** dir (relative to app root) -> package.json object, or a raw string written verbatim. */
  files?: Record<string, Json | string>
  /** seed paths (each gets a `<path>.version` file). */
  seed?: string[]
  /** make a real semver resolvable at <app>/node_modules/semver (default true). */
  semver?: boolean
  /** write this instead of a JSON lockfile. */
  rawLock?: string
}

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'check-tier-b-pairs.mjs')
const REAL_SEMVER = dirname(
  realpathSync(createRequire(import.meta.url).resolve('semver/package.json'))
)
const scratch: string[] = []

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop() as string, { recursive: true, force: true })
})

function build(fx: Fixture): { app: string; seed: string } {
  const root = mkdtempSync(join(tmpdir(), 'check-tier-b-pairs-'))
  scratch.push(root)
  const app = join(root, 'app')
  const seed = join(root, 'seed')
  mkdirSync(app, { recursive: true })
  mkdirSync(seed, { recursive: true })
  writeFileSync(
    join(app, 'package-lock.json'),
    fx.rawLock ?? JSON.stringify({ lockfileVersion: 3, packages: fx.packages })
  )
  for (const [dir, content] of Object.entries(fx.files ?? {})) {
    mkdirSync(join(app, dir), { recursive: true })
    writeFileSync(
      join(app, dir, 'package.json'),
      typeof content === 'string' ? content : JSON.stringify(content)
    )
  }
  for (const entry of fx.seed ?? []) {
    mkdirSync(dirname(join(seed, entry)), { recursive: true })
    writeFileSync(join(seed, entry + '.version'), '0.0.0')
  }
  if (fx.semver !== false) {
    mkdirSync(join(app, 'node_modules'), { recursive: true })
    symlinkSync(REAL_SEMVER, join(app, 'node_modules', 'semver'))
  }
  return { app, seed }
}

// Every fixture runs as linux/arm64/glibc (the platform option overrides detection).
// The musl-named sharp children are given glibc here on purpose: the known-positive needs
// four applicable pairs; real musl/x64 applicability has its own cases below.
const PLATFORM = { os: 'linux', cpu: 'arm64', libc: 'glibc' }
const native = (version: string, extra: Json = {}): Json => ({
  version,
  os: ['linux'],
  cpu: ['arm64'],
  libc: ['glibc'],
  ...extra,
})
/** Drop cpu/libc so the fixture is applicable on any linux host (real-detection CLI tests). */
function bare(fx: Fixture): Fixture {
  for (const e of Object.values(fx.packages)) {
    delete e.cpu
    delete e.libc
  }
  return fx
}
const parent = (version: string, optionalDependencies: Record<string, string>): Json => ({
  version,
  optionalDependencies,
})
const installed = (name: string, version: string): Json => ({ name, version })

function run(fx: Fixture, worktree = false) {
  const { app, seed } = build(fx)
  return checkTierBPairs({ appRoot: app, seedRoot: seed, worktree, platform: PLATFORM })
}

interface Mismatch {
  path: string
  installed?: string
  parent?: string
  spec?: string
}

function mismatches(lines: string[]): Mismatch[] {
  const out: Mismatch[] = []
  for (const l of lines) {
    if (!l.includes('MISMATCH') || !l.includes('path=')) continue
    const m = (re: RegExp) => re.exec(l)?.[1]
    out.push({
      path: m(/path=(\S+)/) as string,
      installed: m(/installed=(\S+)/),
      parent: m(/parent=(\S+)/),
      spec: m(/spec=(\S+)/),
    })
  }
  return out
}

const paths = (lines: string[]) =>
  mismatches(lines)
    .map((m) => m.path)
    .sort()
const nm = (name: string) => `node_modules/${name}`
const notEvaluated = (lines: string[], needle: string) =>
  lines.some((l) => l.includes('NOT-EVALUATED') && l.includes(needle))

const SHARP_CHILDREN = [
  '@img/sharp-linux-arm64',
  '@img/sharp-linuxmusl-arm64',
  '@img/sharp-libvips-linux-arm64',
  '@img/sharp-libvips-linuxmusl-arm64',
]

/** sharp + its four native children; versions chosen per call. */
function sharpFixture(opts: {
  sharpNative: string
  libvips: string
  specNative?: string
  specLibvips?: string
  children?: string[]
  semver?: boolean
}): Fixture {
  const children = opts.children ?? SHARP_CHILDREN
  const specNative = opts.specNative ?? '0.35.5'
  const specLibvips = opts.specLibvips ?? '1.3.4'
  const isLib = (c: string) => c.includes('libvips')
  const od: Record<string, string> = {}
  const packages: Record<string, Json> = {}
  const files: Record<string, Json> = {}
  for (const c of children) {
    od[c] = isLib(c) ? specLibvips : specNative
    packages[nm(c)] = native(isLib(c) ? specLibvips : specNative)
    files[nm(c)] = installed(c, isLib(c) ? opts.libvips : opts.sharpNative)
  }
  packages[nm('sharp')] = parent('0.35.5', od)
  files[nm('sharp')] = parent('0.35.5', od)
  return { packages, files, semver: opts.semver }
}

describe('check-tier-b-pairs', () => {
  it('known-positive: the measured sharp/libvips drift is exit 1 and names all four pairs', () => {
    const { exit, lines } = run(sharpFixture({ sharpNative: '0.33.5', libvips: '1.0.4' }))
    expect(exit).toBe(1)
    expect(paths(lines)).toEqual(SHARP_CHILDREN.map(nm).sort())
    for (const m of mismatches(lines)) expect(m.parent).toBe(nm('sharp'))
  })

  it('known-negative: matching versions are exit 0 with the denominator', () => {
    const { exit, lines } = run(
      sharpFixture({
        sharpNative: '0.35.5',
        libvips: '1.3.4',
        children: ['@img/sharp-linux-arm64', '@img/sharp-libvips-linux-arm64'],
      })
    )
    expect(exit).toBe(0)
    expect(mismatches(lines)).toEqual([])
    expect(lines.join('\n')).toContain(
      '2 packages expected (2 applicable, 0 skipped for another platform), 2 pairs checked'
    )
  })

  it('every output line carries the [tier-b-pairs] prefix', () => {
    const { lines } = run(sharpFixture({ sharpNative: '0.33.5', libvips: '1.0.4' }), true)
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l.startsWith('[tier-b-pairs] ')).toBe(true)
  })

  describe('parent attribution', () => {
    const nested = nm('astro') + '/' + nm('lightningcss-linux-arm64-gnu')
    const root = nm('lightningcss-linux-arm64-gnu')
    const nestedFx = (rootVersion: string, nestedVersion: string): Fixture => ({
      packages: {
        [nm('lightningcss')]: parent('1.1.0', { 'lightningcss-linux-arm64-gnu': '1.1.0' }),
        [root]: native('1.1.0'),
        [nm('astro')]: parent('5.0.0', { 'lightningcss-linux-arm64-gnu': '1.2.0' }),
        [nested]: native('1.2.0'),
      },
      files: {
        [nm('lightningcss')]: parent('1.1.0', { 'lightningcss-linux-arm64-gnu': '1.1.0' }),
        [root]: installed('lightningcss-linux-arm64-gnu', rootVersion),
        [nm('astro')]: parent('5.0.0', { 'lightningcss-linux-arm64-gnu': '1.2.0' }),
        [nested]: installed('lightningcss-linux-arm64-gnu', nestedVersion),
      },
    })

    it('nested parent: each copy is paired only with the parent Node resolves to it', () => {
      const { exit, lines } = run(nestedFx('1.1.0', '1.2.0'))
      expect(exit).toBe(0)
      // Crossing the parents would produce 4 pairs and a mismatch.
      expect(lines.join('\n')).toContain(
        '2 packages expected (2 applicable, 0 skipped for another platform), 2 pairs checked'
      )
    })

    it('nested parent: a bad nested copy is attributed to the nested parent, not the root one', () => {
      const { exit, lines } = run(nestedFx('1.1.0', '1.9.0'))
      expect(exit).toBe(1)
      const found = mismatches(lines)
      expect(found.map((m) => m.path)).toEqual([nested])
      expect(found[0].parent).toBe(nm('astro'))
      expect(found[0].spec).toBe('1.2.0')
    })

    it('root-hoisted vs nested: a bad hoisted copy is named without implicating the nested one', () => {
      const { exit, lines } = run(nestedFx('1.0.0', '1.2.0'))
      expect(exit).toBe(1)
      const found = mismatches(lines)
      expect(found.map((m) => m.path)).toEqual([root])
      expect(found[0].parent).toBe(nm('lightningcss'))
    })
  })

  it('scoped names: @esbuild/ and @img/ paths are parsed and attributed to their parents', () => {
    const fx = (esbuildInstalled: string): Fixture => ({
      packages: {
        [nm('esbuild')]: parent('0.21.5', { '@esbuild/linux-arm64': '0.21.5' }),
        [nm('@esbuild/linux-arm64')]: native('0.21.5'),
        [nm('sharp')]: parent('0.35.5', { '@img/sharp-linux-arm64': '0.35.5' }),
        [nm('@img/sharp-linux-arm64')]: native('0.35.5'),
      },
      files: {
        [nm('esbuild')]: parent('0.21.5', { '@esbuild/linux-arm64': '0.21.5' }),
        [nm('@esbuild/linux-arm64')]: installed('@esbuild/linux-arm64', esbuildInstalled),
        [nm('sharp')]: parent('0.35.5', { '@img/sharp-linux-arm64': '0.35.5' }),
        [nm('@img/sharp-linux-arm64')]: installed('@img/sharp-linux-arm64', '0.35.5'),
      },
    })
    const clean = run(fx('0.21.5'))
    expect(clean.exit).toBe(0)
    expect(clean.lines.join('\n')).toContain(
      '2 packages expected (2 applicable, 0 skipped for another platform), 2 pairs checked'
    )

    const bad = run(fx('0.19.0'))
    expect(bad.exit).toBe(1)
    const found = mismatches(bad.lines)
    expect(found.map((m) => m.path)).toEqual([nm('@esbuild/linux-arm64')])
    expect(found[0].parent).toBe(nm('esbuild'))
  })

  describe('multiple parents', () => {
    const P = nm('foo-linux-x64')
    const entries: Record<string, Json> = {
      [nm('a')]: parent('1.0.0', { 'foo-linux-x64': '1.0.0' }),
      [nm('b')]: parent('1.0.0', { 'foo-linux-x64': '2.0.0' }),
    }
    it.each([
      ['good parent first', ['a', 'b']],
      ['good parent last', ['b', 'a']],
    ])('conflicting specs: exit 1 and only the unsatisfied parent is named (%s)', (_l, order) => {
      const packages: Record<string, Json> = {}
      const files: Record<string, Json> = {}
      for (const k of order) {
        packages[nm(k)] = entries[nm(k)]
        files[nm(k)] = entries[nm(k)]
      }
      packages[P] = native('1.0.0')
      files[P] = installed('foo-linux-x64', '1.0.0')
      const { exit, lines } = run({ packages, files })
      expect(exit).toBe(1)
      expect(mismatches(lines).map((m) => [m.path, m.parent])).toEqual([[P, nm('b')]])
    })
  })

  describe('missing vs unreadable policy', () => {
    const base = (): Fixture =>
      sharpFixture({
        sharpNative: '0.35.5',
        libvips: '1.3.4',
        children: SHARP_CHILDREN.slice(0, 2),
      })

    it('live package absent from an old seed and not installed: exit 1, package named', () => {
      const fx = base()
      delete fx.files![nm('@img/sharp-linux-arm64')]
      fx.seed = [] // an old seed that never had it
      const { exit, lines } = run(fx)
      expect(exit).toBe(1)
      expect(paths(lines)).toEqual([nm('@img/sharp-linux-arm64')])
    })

    it('one valid pair plus one missing target: the valid pair does not mask the missing one', () => {
      const fx = base()
      delete fx.files![nm('@img/sharp-linuxmusl-arm64')]
      const { exit, lines } = run(fx)
      expect(exit).toBe(1)
      expect(paths(lines)).toEqual([nm('@img/sharp-linuxmusl-arm64')])
    })

    it('a directory with no package.json counts as missing: exit 1', () => {
      const { app } = build(base())
      rmSync(join(app, nm('@img/sharp-linux-arm64'), 'package.json'))
      const r = checkTierBPairs({
        appRoot: app,
        seedRoot: join(app, 'no-seed'),
        platform: PLATFORM,
      })
      expect(r.exit).toBe(1)
      expect(paths(r.lines)).toEqual([nm('@img/sharp-linux-arm64')])
    })

    it('unreadable target (present but not JSON): exit 2, not 1 and not 0', () => {
      const fx = base()
      fx.files![nm('@img/sharp-linux-arm64')] = 'this is not json'
      const { exit, lines } = run(fx)
      expect(exit).toBe(2)
      expect(mismatches(lines)).toEqual([])
      expect(notEvaluated(lines, `path=${nm('@img/sharp-linux-arm64')} installed`)).toBe(true)
    })

    it('unreadable parent (package.json missing): exit 2, not 0', () => {
      const fx = base()
      delete fx.files![nm('sharp')]
      const { exit, lines } = run(fx)
      expect(exit).toBe(2)
      expect(mismatches(lines)).toEqual([])
      expect(notEvaluated(lines, `parent=${nm('sharp')} package.json missing`)).toBe(true)
    })

    it('an installed parent that does not list the package: exit 2, that parent named', () => {
      const fx = base()
      fx.files![nm('sharp')] = parent('0.35.5', { '@img/sharp-linuxmusl-arm64': '0.35.5' })
      const { exit, lines } = run(fx)
      expect(exit).toBe(2)
      expect(mismatches(lines)).toEqual([])
      expect(
        notEvaluated(lines, `path=${nm('@img/sharp-linux-arm64')} parent=${nm('sharp')} installed`)
      ).toBe(true)
    })

    it('unparseable parent package.json: exit 2', () => {
      const fx = base()
      fx.files![nm('sharp')] = '{ nope'
      expect(run(fx).exit).toBe(2)
    })

    it('a real mismatch outranks a not-evaluated package: exit 1', () => {
      const fx = base()
      fx.files![nm('@img/sharp-linux-arm64')] = 'not json'
      fx.files![nm('@img/sharp-linuxmusl-arm64')] = installed('@img/sharp-linuxmusl-arm64', '0.1.0')
      const { exit, lines } = run(fx)
      expect(exit).toBe(1)
      expect(paths(lines)).toEqual([nm('@img/sharp-linuxmusl-arm64')])
    })

    it('an unreadable lockfile: exit 2', () => {
      expect(run({ packages: {}, rawLock: '{ truncated' }).exit).toBe(2)
    })

    it('a missing lockfile: exit 2', () => {
      const { app, seed } = build({ packages: {} })
      rmSync(join(app, 'package-lock.json'))
      const r = checkTierBPairs({ appRoot: app, seedRoot: seed, platform: PLATFORM })
      expect(r.exit).toBe(2)
      expect(notEvaluated(r.lines, 'lockfile')).toBe(true)
    })

    it('a lockfile with no packages key: exit 2, never 0', () => {
      const r = run({ packages: {}, rawLock: JSON.stringify({ lockfileVersion: 3 }) })
      expect(r.exit).toBe(2)
      expect(r.lines.some((l) => l.includes('CLEAN'))).toBe(false)
    })

    it('a spec that is not a version or range: exit 2, not a MISMATCH', () => {
      const fx = sharpFixture({
        sharpNative: '0.35.5',
        libvips: '1.3.4',
        children: ['@img/sharp-linux-arm64'],
        specNative: 'workspace:*',
      })
      const { exit, lines } = run(fx)
      expect(exit).toBe(2)
      expect(mismatches(lines)).toEqual([])
      expect(notEvaluated(lines, `path=${nm('@img/sharp-linux-arm64')} parent=`)).toBe(true)
    })

    it('libc that could not be determined: exit 2 and nothing checked, never a guess', () => {
      const { app, seed } = build(
        sharpFixture({
          sharpNative: '0.33.5',
          libvips: '1.3.4',
          children: ['@img/sharp-linux-arm64'],
        })
      )
      const r = checkTierBPairs({
        appRoot: app,
        seedRoot: seed,
        platform: { os: 'linux', cpu: 'arm64', libc: null },
      })
      expect(r.exit).toBe(2)
      expect(mismatches(r.lines)).toEqual([])
      expect(notEvaluated(r.lines, 'libc')).toBe(true)
    })

    it('a control character in a package.json value cannot add an output line', () => {
      const fx = sharpFixture({
        sharpNative: '0.33.5',
        libvips: '1.3.4',
        children: ['@img/sharp-linux-arm64'],
      })
      fx.files![nm('@img/sharp-linux-arm64')] = installed(
        '@img/sharp-linux-arm64',
        '0.33.5\n[tier-b-pairs] CLEAN forged'
      )
      const { lines } = run(fx)
      expect(lines.length).toBeGreaterThan(0)
      const isControl = (c: string) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f
      expect(lines.some((l) => [...l].some(isControl))).toBe(false)
    })
  })

  describe('denominators', () => {
    it('zero denominator: seeds present but the live lockfile expects nothing: exit 2, never 0', () => {
      const { exit, lines } = run({
        packages: { [nm('sharp')]: parent('0.35.5', { '@img/sharp-linux-arm64': '0.35.5' }) },
        seed: [nm('@img/sharp-linux-arm64')],
      })
      expect(exit).toBe(2)
      expect(lines.some((l) => l.includes('CLEAN'))).toBe(false)
    })

    it('a package with zero evaluated parents is exit 2 even when the global count is non-zero', () => {
      const orphan = nm('orphan-linux-arm64')
      const fx = sharpFixture({
        sharpNative: '0.35.5',
        libvips: '1.3.4',
        children: ['@img/sharp-linux-arm64'],
      })
      fx.packages[orphan] = native('1.0.0') // no lockfile entry lists it as optional
      fx.files![orphan] = installed('orphan-linux-arm64', '1.0.0')
      const { exit, lines } = run(fx)
      expect(exit).toBe(2)
      expect(mismatches(lines)).toEqual([])
      expect(lines.some((l) => l.includes('NOT-EVALUATED') && l.includes(`path=${orphan} `))).toBe(
        true
      )
    })
  })

  describe('semver availability', () => {
    const rangeFx = (installedVersion: string, semver: boolean): Fixture => ({
      packages: {
        [nm('sharp')]: parent('0.35.5', { '@img/sharp-linux-arm64': '^0.35.0' }),
        [nm('@img/sharp-linux-arm64')]: native(installedVersion),
      },
      files: {
        [nm('sharp')]: parent('0.35.5', { '@img/sharp-linux-arm64': '^0.35.0' }),
        [nm('@img/sharp-linux-arm64')]: installed('@img/sharp-linux-arm64', installedVersion),
      },
      semver,
    })

    it('range spec without semver: exit 2', () => {
      expect(run(rangeFx('0.35.5', false)).exit).toBe(2)
    })

    it('the same range with semver available is evaluated: satisfied exit 0, violated exit 1', () => {
      expect(run(rangeFx('0.35.5', true)).exit).toBe(0)
      expect(run(rangeFx('0.36.0', true)).exit).toBe(1)
    })

    it('an exact spec without semver is still compared: mismatch exit 1', () => {
      const fx = sharpFixture({
        sharpNative: '0.33.5',
        libvips: '1.3.4',
        children: ['@img/sharp-linux-arm64'],
        semver: false,
      })
      expect(run(fx).exit).toBe(1)
    })
  })

  // npm: aliases are deliberately not judged (owner decision, SMI-7201): every alias spec,
  // including ones that look healthy, is NOT-EVALUATED -- never CLEAN and never a mismatch.
  describe('npm alias specs', () => {
    const ALIAS = nm('native-alias')
    it.each([
      ['a healthy-looking alias', 'npm:@vendor/native-linux@^1.2.0', '@vendor/native-linux'],
      [
        'an alias with a trailing @ and no range',
        'npm:@vendor/native-linux@',
        '@vendor/native-linux',
      ],
      ['an alias to an invalid package name', 'npm:foo/bar@1.2.3', 'foo/bar'],
      ['an alias with no range at all', 'npm:@vendor/native-linux', '@vendor/native-linux'],
    ])('%s: exit 2, not evaluated, never CLEAN', (_label, spec, installedName) => {
      const { exit, lines } = run({
        packages: {
          [nm('host')]: parent('1.0.0', { 'native-alias': spec }),
          [ALIAS]: native('1.2.3', { name: installedName }),
        },
        files: {
          [nm('host')]: parent('1.0.0', { 'native-alias': spec }),
          [ALIAS]: installed(installedName, '1.2.3'),
        },
      })
      expect(exit).toBe(2)
      expect(mismatches(lines)).toEqual([])
      expect(lines.some((l) => l.includes('CLEAN'))).toBe(false)
      expect(notEvaluated(lines, `path=${ALIAS} parent=${nm('host')}`)).toBe(true)
      expect(notEvaluated(lines, 'npm alias')).toBe(true) // named as an alias, not a generic bad spec
    })
  })

  describe('obsolete seed entries', () => {
    const fx = (): Fixture => ({
      ...sharpFixture({
        sharpNative: '0.35.5',
        libvips: '1.3.4',
        children: ['@img/sharp-linux-arm64'],
      }),
      seed: [nm('@img/sharp-linux-arm64'), nm('@img/removed-linux-arm64')],
    })

    it('a live dependency removed with an old seed remaining: exit 0, one informational line on worktree routes', () => {
      const { exit, lines } = run(fx(), true)
      expect(exit).toBe(0)
      const info = lines.filter((l) => l.includes('removed-linux-arm64'))
      expect(info).toHaveLength(1)
      expect(info[0]).not.toContain('sharp-linux-arm64')
    })

    it('a trailing slash on the seed root does not mangle entry names', () => {
      const { app, seed } = build(fx())
      const r = checkTierBPairs({
        appRoot: app,
        seedRoot: seed + '/',
        worktree: true,
        platform: PLATFORM,
      })
      const info = r.lines.filter((l) => l.includes('INFO'))
      expect(info).toHaveLength(1)
      expect(info[0]).toMatch(/: node_modules\/@img\/removed-linux-arm64$/)
    })

    it('without --worktree the obsolete entry is not reported', () => {
      const { exit, lines } = run(fx(), false)
      expect(exit).toBe(0)
      expect(lines.some((l) => l.includes('removed-linux-arm64'))).toBe(false)
    })
  })

  describe('platform applicability', () => {
    const goodPair = (
      extra: Fixture['packages'] = {},
      extraFiles: Fixture['files'] = {}
    ): Fixture => {
      const fx = sharpFixture({
        sharpNative: '0.35.5',
        libvips: '1.3.4',
        children: ['@img/sharp-linux-arm64'],
      })
      Object.assign(fx.packages, extra)
      Object.assign(fx.files!, extraFiles)
      return fx
    }
    const addChild = (fx: Fixture, name: string): void => {
      const sharp = fx.packages[nm('sharp')] as { optionalDependencies: Record<string, string> }
      sharp.optionalDependencies[name] = '0.35.5'
      fx.files![nm('sharp')] = fx.packages[nm('sharp')]
    }

    it('an x64-only package that is not installed is skipped, not missing: exit 0', () => {
      const fx = goodPair({ [nm('@esbuild/linux-x64')]: native('0.21.5', { cpu: ['x64'] }) })
      addChild(fx, '@esbuild/linux-x64')
      const { exit, lines } = run(fx)
      expect(exit).toBe(0)
      expect(paths(lines)).toEqual([])
      expect(lines.join('\n')).toContain(
        '2 packages expected (1 applicable, 1 skipped for another platform), 1 pairs checked'
      )
    })

    it('a musl-only package that is not installed is skipped: exit 0', () => {
      const fx = goodPair({
        [nm('@img/sharp-linuxmusl-arm64')]: native('0.35.5', { libc: ['musl'] }),
      })
      addChild(fx, '@img/sharp-linuxmusl-arm64')
      const { exit, lines } = run(fx)
      expect(exit).toBe(0)
      expect(paths(lines)).toEqual([])
    })

    it('an applicable arm64 glibc package that is not installed is a MISMATCH', () => {
      const fx = goodPair({ [nm('@img/sharp-libvips-linux-arm64')]: native('1.3.4') })
      addChild(fx, '@img/sharp-libvips-linux-arm64')
      const { exit, lines } = run(fx)
      expect(exit).toBe(1)
      expect(paths(lines)).toEqual([nm('@img/sharp-libvips-linux-arm64')])
    })

    it('a negated cpu (!x64) is applicable on arm64: checked, and missing is a MISMATCH', () => {
      const fx = goodPair({ [nm('neg-linux')]: native('1.0.0', { cpu: ['!x64'] }) })
      addChild(fx, 'neg-linux')
      const { exit, lines } = run(fx)
      expect(exit).toBe(1)
      expect(paths(lines)).toEqual([nm('neg-linux')])
    })

    it('a negated cpu naming the running arch is skipped', () => {
      const fx = goodPair({ [nm('neg-linux')]: native('1.0.0', { cpu: ['!arm64'] }) })
      addChild(fx, 'neg-linux')
      expect(run(fx).exit).toBe(0)
    })

    it('a non-linux os entry (negated or not) is skipped when it does not admit the platform', () => {
      const fx = goodPair({ [nm('win-only')]: native('1.0.0', { os: ['win32'] }) })
      addChild(fx, 'win-only')
      expect(run(fx).exit).toBe(0)
    })

    it('every package skipped for another platform: exit 2 (zero applicable denominator), never 0', () => {
      const fx = sharpFixture({
        sharpNative: '0.35.5',
        libvips: '1.3.4',
        children: ['@img/sharp-linux-arm64'],
      })
      fx.packages[nm('@img/sharp-linux-arm64')] = native('0.35.5', { cpu: ['x64'] })
      delete fx.files![nm('@img/sharp-linux-arm64')]
      const { exit, lines } = run(fx)
      expect(exit).toBe(2)
      expect(lines.some((l) => l.includes('CLEAN'))).toBe(false)
    })

    it('skipped-for-platform entries are still live: their seed entries are not reported obsolete', () => {
      const fx = goodPair({ [nm('@esbuild/linux-x64')]: native('0.21.5', { cpu: ['x64'] }) })
      addChild(fx, '@esbuild/linux-x64')
      fx.seed = [nm('@esbuild/linux-x64')]
      const { lines } = run(fx, true)
      expect(lines.some((l) => l.includes('INFO'))).toBe(false)
    })
  })

  // The CLI runs real platform detection, and the fixtures are linux packages, so these
  // cases are only meaningful on a linux host (the dev container and CI). Elsewhere they
  // would exit 2 for a correct reason, so they are skipped rather than left to fail.
  describe.skipIf(process.platform !== 'linux')('CLI', () => {
    it('exits with the same code and writes only to stderr', () => {
      const { app, seed } = build(bare(sharpFixture({ sharpNative: '0.33.5', libvips: '1.0.4' })))
      const r = spawnSync(
        process.execPath,
        [SCRIPT, '--app-root', app, '--seed-root', seed, '--worktree'],
        {
          encoding: 'utf8',
        }
      )
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(r.stderr).toContain('[tier-b-pairs] ')
    })

    it('exit 0 on a clean tree', () => {
      const { app, seed } = build(
        bare(
          sharpFixture({
            sharpNative: '0.35.5',
            libvips: '1.3.4',
            children: ['@img/sharp-linux-arm64'],
          })
        )
      )
      const r = spawnSync(process.execPath, [SCRIPT, '--app-root', app, '--seed-root', seed], {
        encoding: 'utf8',
      })
      expect(r.status).toBe(0)
      expect(r.stderr).toContain(
        '1 packages expected (1 applicable, 0 skipped for another platform), 1 pairs checked'
      )
    })

    // Real libc detection, judged against an oracle independent of the code: ldd's own
    // banner. Only the host's own libc variant is installed, so a detector that reports the
    // other libc makes that package applicable-and-missing and the case fails.
    it('real libc detection checks the host libc package and skips the other one', () => {
      const ldd = spawnSync('ldd', ['--version'], { encoding: 'utf8' })
      const banner = `${ldd.stdout ?? ''}${ldd.stderr ?? ''}`
      const isGlibc = /GLIBC|GNU libc/i.test(banner)
      const isMusl = /musl/i.test(banner)
      expect(isGlibc !== isMusl).toBe(true) // exactly one: an empty or ambiguous banner is no oracle
      const hostLibc = isGlibc ? 'glibc' : 'musl'
      const name = { glibc: '@img/sharp-linux-x', musl: '@img/sharp-linuxmusl-x' }
      const od = { [name.glibc]: '1.0.0', [name.musl]: '1.0.0' }
      const own = hostLibc === 'glibc' ? name.glibc : name.musl
      const { app, seed } = build({
        packages: {
          [nm('sharp')]: parent('0.35.5', od),
          [nm(name.glibc)]: native('1.0.0', { cpu: [process.arch], libc: ['glibc'] }),
          [nm(name.musl)]: native('1.0.0', { cpu: [process.arch], libc: ['musl'] }),
        },
        files: { [nm('sharp')]: parent('0.35.5', od), [nm(own)]: installed(own, '1.0.0') },
      })
      const r = spawnSync(process.execPath, [SCRIPT, '--app-root', app, '--seed-root', seed], {
        encoding: 'utf8',
      })
      expect(r.status).toBe(0)
      expect(r.stderr).toContain(
        '2 packages expected (1 applicable, 1 skipped for another platform), 1 pairs checked'
      )
    })

    it('an unknown argument is exit 2', () => {
      const r = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' })
      expect(r.status).toBe(2)
    })

    it.each(['--app-root=', '--seed-root='])(
      'an empty %s value is exit 2, like the spaced form',
      (arg) => {
        const r = spawnSync(process.execPath, [SCRIPT, arg], { encoding: 'utf8' })
        expect(r.status).toBe(2)
        expect(r.stderr).toContain('bad arguments')
      }
    )

    it('run through a symlink it still acts as the CLI, never a silent exit 0', () => {
      const dir = mkdtempSync(join(tmpdir(), 'check-tier-b-pairs-link-'))
      scratch.push(dir)
      const link = join(dir, 'check-tier-b-pairs.mjs')
      symlinkSync(SCRIPT, link)
      const r = spawnSync(process.execPath, [link, '--bogus'], { encoding: 'utf8' })
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('[tier-b-pairs] ')
    })
  })
})
