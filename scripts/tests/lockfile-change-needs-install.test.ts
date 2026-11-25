/**
 * SMI-7238 -- unit corpus for scripts/lib/lockfile-change-needs-install.mjs.
 *
 * Every lockfile below is built in this file (never derived from the helper).
 * The helper runs as a real `node` child process, with the omit probe pinned
 * through SKILLSMITH_DEPS_OMIT_PROBE_OUTPUT so the host's npm config cannot
 * change a verdict. Each case declares its expected token up front; the
 * exempt cases are paired with must-block cases so a helper that always says
 * `no-install-needed` (or always `install-needed`) turns a test red.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HELPER = resolve(__dirname, '..', 'lib', 'lockfile-change-needs-install.mjs')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Lock = any

function baseLock(): Lock {
  return {
    name: 'root',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'root',
        version: '1.0.0',
        workspaces: ['packages/*'],
        dependencies: { tsx: '^4.0.0', zod: '^3.0.0' },
        devDependencies: { typescript: '^5.0.0' },
      },
      'packages/website': {
        name: 'website',
        version: '1.0.0',
        dependencies: { '@tailwindcss/vite': '^4.1.0', astro: '^5.0.0' },
        devDependencies: { vitest: '^3.0.0' },
      },
      'node_modules/website': { resolved: 'packages/website', link: true },
      'node_modules/tsx': {
        version: '4.0.1',
        resolved: 'https://registry.npmjs.org/tsx/-/tsx-4.0.1.tgz',
        integrity: 'sha512-TSX',
        bin: { tsx: 'dist/cli.mjs' },
        engines: { node: '>=18' },
      },
      'node_modules/typescript': {
        version: '5.0.1',
        resolved: 'https://registry.npmjs.org/typescript/-/typescript-5.0.1.tgz',
        integrity: 'sha512-TS',
        hasInstallScript: false,
      },
      'node_modules/lightningcss-android-arm64': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/lightningcss-android-arm64/-/l-1.0.0.tgz',
        integrity: 'sha512-LCSS',
        optional: true,
        os: ['android'],
        cpu: ['arm64'],
        peerDependencies: { postcss: '^8.0.0' },
      },
      'node_modules/shared-lib': {
        version: '2.0.0',
        resolved: 'https://registry.npmjs.org/shared-lib/-/shared-lib-2.0.0.tgz',
        integrity: 'sha512-SL',
        devOptional: true,
        dependencies: { 'dep-a': '^1.0.0' },
      },
      'node_modules/zod': {
        version: '3.0.1',
        resolved: 'https://registry.npmjs.org/zod/-/zod-3.0.1.tgz',
        integrity: 'sha512-ZOD',
      },
      'packages/website/node_modules/nested-b': {
        version: '1.2.3',
        resolved: 'https://registry.npmjs.org/nested-b/-/nested-b-1.2.3.tgz',
        integrity: 'sha512-NB',
      },
      'packages/cli/node_modules/better-sqlite3': {
        version: '12.10.0',
        resolved: 'https://registry.npmjs.org/better-sqlite3/-/b-12.10.0.tgz',
        integrity: 'sha512-BS12',
        hasInstallScript: true,
        dependencies: { bindings: '^1.5.0' },
      },
    },
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop() as string
    if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
})

interface RunOpts {
  /** raw text for the current lockfile (overrides l1) */
  curText?: string
  /** raw text for the saved copy (overrides l0); sentinel hashes THIS text */
  savedText?: string
  /** write no saved copy */
  noCopy?: boolean
  /** sentinel content override (default: sha256 of the saved text) */
  sentinel?: string
  /** write no sentinel */
  noSentinel?: boolean
  /** omit-probe stdout; null = do not set the override (really spawn npm) */
  omit?: string | null
  /** PATH for the child (used to make the real npm probe unspawnable) */
  path?: string
}

function runHelper(l0: Lock, l1: Lock, opts: RunOpts = {}) {
  const dir = makeFixtureTempDir('lockfile-needs-install')
  dirs.push(dir)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  const savedText = opts.savedText ?? JSON.stringify(l0, null, 2) + '\n'
  const cur = join(dir, 'package-lock.json')
  const copy = join(dir, 'node_modules', '.skillsmith-deps-lock.json')
  const sentinel = join(dir, 'node_modules', '.skillsmith-deps-hash')
  writeFileSync(cur, opts.curText ?? JSON.stringify(l1, null, 2) + '\n', 'utf8')
  if (!opts.noCopy) writeFileSync(copy, savedText, 'utf8')
  if (!opts.noSentinel) writeFileSync(sentinel, (opts.sentinel ?? sha256(savedText)) + '\n', 'utf8')
  const env: Record<string, string> = { PATH: opts.path ?? process.env['PATH'] ?? '/usr/bin:/bin' }
  if (opts.omit !== null) env['SKILLSMITH_DEPS_OMIT_PROBE_OUTPUT'] = opts.omit ?? ''
  const r = spawnSync(process.execPath, [HELPER, cur, copy, sentinel], {
    cwd: dir,
    encoding: 'utf8',
    env,
    timeout: 20_000,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** Run with L0 = base and L1 = base mutated; returns the stdout token. */
function verdict(mutate: (l0: Lock, l1: Lock) => void, opts: RunOpts = {}): string {
  const l0 = baseLock()
  const l1 = baseLock()
  mutate(l0, l1)
  const r = runHelper(l0, l1, opts)
  expect(r.status).toBe(0)
  return r.stdout
}

describe('SMI-7238 helper: exempt changes (no-install-needed)', () => {
  it('identical lockfiles', () => {
    expect(verdict(() => {})).toBe('no-install-needed\n')
  })

  it('instance-2 shape: dev added, peer added, devOptional removed, two same-spec section moves', () => {
    const out = verdict((_l0, l1) => {
      l1.packages['node_modules/typescript'].dev = true
      l1.packages['node_modules/tsx'].dev = true
      l1.packages['node_modules/lightningcss-android-arm64'].peer = true
      delete l1.packages['node_modules/shared-lib'].devOptional
      // root: tsx dependencies -> devDependencies, same spec
      const root = l1.packages['']
      root.devDependencies.tsx = root.dependencies.tsx
      delete root.dependencies.tsx
      // website: @tailwindcss/vite dependencies -> devDependencies, same spec
      const web = l1.packages['packages/website']
      web.devDependencies['@tailwindcss/vite'] = web.dependencies['@tailwindcss/vite']
      delete web.dependencies['@tailwindcss/vite']
    })
    expect(out).toBe('no-install-needed\n')
  })

  it.each(['dev', 'devOptional', 'peer'])('a lone %s flag flip is exempt', (flag) => {
    const out = verdict((_l0, l1) => {
      l1.packages['node_modules/zod'][flag] = true
    })
    expect(out).toBe('no-install-needed\n')
  })

  it('same-spec section move in the opposite direction (dev -> prod)', () => {
    const out = verdict((_l0, l1) => {
      const root = l1.packages['']
      root.dependencies.typescript = root.devDependencies.typescript
      delete root.devDependencies.typescript
    })
    expect(out).toBe('no-install-needed\n')
  })

  it('object key order inside an entry is ignored', () => {
    const out = verdict((_l0, l1) => {
      const e = l1.packages['node_modules/tsx']
      l1.packages['node_modules/tsx'] = {
        engines: e.engines,
        bin: e.bin,
        integrity: e.integrity,
        resolved: e.resolved,
        version: e.version,
      }
    })
    expect(out).toBe('no-install-needed\n')
  })

  it('writes a reason on stderr and exits 0', () => {
    const r = runHelper(baseLock(), baseLock())
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/\[lockfile-change-needs-install\]/)
  })
})

// Each case: [label, mutation of (l0, l1)]. All must print install-needed.
const MUST_BLOCK: Array<[string, (l0: Lock, l1: Lock) => void]> = [
  ['version changed', (_a, l1) => (l1.packages['node_modules/zod'].version = '3.0.2')],
  ['resolved changed', (_a, l1) => (l1.packages['node_modules/zod'].resolved += '?x')],
  ['integrity changed', (_a, l1) => (l1.packages['node_modules/zod'].integrity = 'sha512-NEW')],
  ['link flipped', (_a, l1) => (l1.packages['node_modules/website'].link = false)],
  ['bin changed', (_a, l1) => (l1.packages['node_modules/tsx'].bin = { tsx: 'dist/other.mjs' })],
  [
    'hasInstallScript flipped',
    (_a, l1) => (l1.packages['node_modules/typescript'].hasInstallScript = true),
  ],
  [
    'os changed',
    (_a, l1) => (l1.packages['node_modules/lightningcss-android-arm64'].os = ['linux']),
  ],
  [
    'cpu changed',
    (_a, l1) => (l1.packages['node_modules/lightningcss-android-arm64'].cpu = ['x64']),
  ],
  ['engines changed', (_a, l1) => (l1.packages['node_modules/tsx'].engines = { node: '>=20' })],
  [
    'optional removed',
    (_a, l1) => delete l1.packages['node_modules/lightningcss-android-arm64'].optional,
  ],
  ['optional added', (_a, l1) => (l1.packages['node_modules/zod'].optional = true)],
  [
    'peerDependencies changed',
    (_a, l1) =>
      (l1.packages['node_modules/lightningcss-android-arm64'].peerDependencies = { postcss: '^9' }),
  ],
  [
    'entry dependencies changed',
    (_a, l1) => (l1.packages['node_modules/shared-lib'].dependencies['dep-a'] = '^2.0.0'),
  ],
  ['entry added', (_a, l1) => (l1.packages['node_modules/brand-new'] = { version: '1.0.0' })],
  ['entry removed', (_a, l1) => delete l1.packages['node_modules/zod']],
  [
    // Same entry count, different key set: catches a count-only key comparison.
    'entry renamed (one removed, one added, same count)',
    (_a, l1) => {
      l1.packages['node_modules/zod-renamed'] = l1.packages['node_modules/zod']
      delete l1.packages['node_modules/zod']
    },
  ],
  [
    'section move that also changes the spec',
    (_a, l1) => {
      const root = l1.packages['']
      root.devDependencies.tsx = '^5.0.0'
      delete root.dependencies.tsx
    },
  ],
  [
    'section move that drops a dependency',
    (_a, l1) => {
      delete l1.packages[''].dependencies.tsx
    },
  ],
  [
    'workspace dependency added',
    (_a, l1) => (l1.packages['packages/website'].dependencies['new-dep'] = '^1.0.0'),
  ],
  ['workspace version changed', (_a, l1) => (l1.packages['packages/website'].version = '1.0.1')],
  ['lockfileVersion changed', (_a, l1) => (l1.lockfileVersion = 2)],
  ['requires changed', (_a, l1) => (l1.requires = false)],
  ['top-level extra key in L1', (_a, l1) => (l1.extra = 1)],
  [
    'nested key differs',
    (_a, l1) => (l1.packages['packages/website/node_modules/nested-b'].version = '1.2.4'),
  ],
  [
    'better-sqlite3 12.10.0 -> 13.0.3 with changed dependencies',
    (_a, l1) => {
      const e = l1.packages['packages/cli/node_modules/better-sqlite3']
      e.version = '13.0.3'
      e.resolved = 'https://registry.npmjs.org/better-sqlite3/-/b-13.0.3.tgz'
      e.integrity = 'sha512-BS13'
      e.dependencies = { bindings: '^1.5.0', 'prebuild-install': '^7.1.0' }
    },
  ],
  ['null entry in L1', (_a, l1) => (l1.packages['node_modules/zod'] = null)],
  ['string entry in L1', (_a, l1) => (l1.packages['node_modules/zod'] = 'x')],
  ['null entry in L0', (l0) => (l0.packages['node_modules/zod'] = null)],
  ['property missing in L1', (_a, l1) => delete l1.packages['node_modules/zod'].integrity],
  ['property missing in L0', (l0) => delete l0.packages['node_modules/zod'].integrity],
  ['name in both sections in L1', (_a, l1) => (l1.packages[''].devDependencies.tsx = '^4.0.0')],
  ['name in both sections in L0', (l0) => (l0.packages[''].devDependencies.tsx = '^4.0.0')],
  [
    'name in both sections in BOTH (identical overlap)',
    (l0, l1) => {
      l0.packages[''].devDependencies.tsx = '^4.0.0'
      l1.packages[''].devDependencies.tsx = '^4.0.0'
    },
  ],
  ['dependency section is not an object', (_a, l1) => (l1.packages[''].dependencies = ['tsx'])],
  ['packages object missing in L1', (_a, l1) => delete l1.packages],
]

describe('SMI-7238 helper: must block (install-needed)', () => {
  it.each(MUST_BLOCK)('%s', (_label, mutate) => {
    expect(verdict(mutate)).toBe('install-needed\n')
  })

  it('a mutation that is a pure flag flip is NOT in this table (paired control)', () => {
    // Guards the table: the same entry, flag-only, is exempt.
    const out = verdict((_a, l1) => (l1.packages['node_modules/zod'].dev = true))
    expect(out).toBe('no-install-needed\n')
  })
})

describe('SMI-7238 helper: saved copy and sentinel integrity', () => {
  it('saved copy missing', () => {
    const r = runHelper(baseLock(), baseLock(), { noCopy: true })
    expect(r.stdout).toBe('install-needed\n')
    expect(r.status).toBe(0)
  })

  it('saved copy hash differs from the raw sentinel: incomplete publication', () => {
    const r = runHelper(baseLock(), baseLock(), { sentinel: sha256('something else') })
    expect(r.stdout).toBe('install-needed\n')
    expect(r.stderr).toContain('incomplete sentinel publication; reinstall to refresh it')
  })

  it('a saved copy that differs from its own sentinel is rejected even when it equals the current lockfile', () => {
    // Copy equals L1 exactly, but the sentinel names different bytes. A helper
    // that trusted the copy without checking its hash would say no-install-needed.
    const same = baseLock()
    const r = runHelper(same, same, { sentinel: sha256('stale install') })
    expect(r.stdout).toBe('install-needed\n')
  })

  it('raw sentinel missing', () => {
    const r = runHelper(baseLock(), baseLock(), { noSentinel: true })
    expect(r.stdout).toBe('install-needed\n')
  })

  it('invalid JSON in the current lockfile', () => {
    const r = runHelper(baseLock(), baseLock(), { curText: '{not json' })
    expect(r.stdout).toBe('install-needed\n')
  })

  it('invalid JSON in the saved copy (hash still matches the sentinel)', () => {
    const r = runHelper(baseLock(), baseLock(), { savedText: '{not json' })
    expect(r.stdout).toBe('install-needed\n')
  })

  it('current lockfile has no packages object', () => {
    const r = runHelper(baseLock(), baseLock(), { curText: JSON.stringify({ name: 'x' }) })
    expect(r.stdout).toBe('install-needed\n')
  })

  it('paired control: the same inputs with valid JSON are exempt', () => {
    const r = runHelper(baseLock(), baseLock())
    expect(r.stdout).toBe('no-install-needed\n')
  })
})

describe('SMI-7238 helper: effective omit set', () => {
  const flagOnly = (_a: Lock, l1: Lock) => (l1.packages['node_modules/zod'].dev = true)

  it.each(['dev', 'peer', 'optional', 'dev peer'])('omit "%s" -> install-needed', (omit) => {
    expect(verdict(flagOnly, { omit })).toBe('install-needed\n')
  })

  it('omit probe output of only whitespace is an empty set (paired control)', () => {
    expect(verdict(flagOnly, { omit: '\n' })).toBe('no-install-needed\n')
  })

  it('omit probe that cannot run (npm unspawnable) -> install-needed', () => {
    const l0 = baseLock()
    const l1 = baseLock()
    l1.packages['node_modules/zod'].dev = true
    const r = runHelper(l0, l1, { omit: null, path: join(tmpMissingDir(), 'nope') })
    expect(r.stdout).toBe('install-needed\n')
    expect(r.stderr).toContain('could not read npm omit configuration')
  })
})

function tmpMissingDir(): string {
  const d = makeFixtureTempDir('lockfile-needs-install-nopath')
  dirs.push(d)
  return d
}
