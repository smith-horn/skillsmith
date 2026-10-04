/**
 * SMI-6944 Test 4: scripts/ci/use-lockfile-vercel.sh against fake trees.
 *
 * GITHUB_WORKSPACE, RUNNER_TEMP and GITHUB_PATH are set per test (no seam in the
 * script). The fake `vercel` CLI logs the path it was invoked by, so the tests can
 * prove the version check ran THROUGH the shim and not through the .bin entry.
 *
 * @see docs/internal/implementation/smi-6944-vercel-cli-from-lockfile.md
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'ci', 'use-lockfile-vercel.sh')
const VERSION = '52.2.0'

interface Tree {
  ws: string
  temp: string
  ghPath: string
  log: string
}

function writeJson(path: string, obj: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(obj))
}

function fakeCli(path: string, version: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `#!/usr/bin/env node\nrequire('fs').appendFileSync(process.env.VC_LOG, process.argv[1] + '\\n')\nconsole.log('${version}')\n`
  )
  chmodSync(path, 0o755)
}

function smolToml(dir: string, version: string) {
  writeJson(join(dir, 'package.json'), { name: 'smol-toml', version, main: 'index.js' })
  writeFileSync(join(dir, 'index.js'), '')
}

interface Opts {
  override?: string | null
  nested?: string | null
  hoisted?: string
  lockVersion?: string
  pinned?: string
  installed?: string
  binTarget?: 'vc' | 'decoy' | 'none'
}

function buildTree(root: string, o: Opts = {}): Tree {
  const ws = join(root, 'ws')
  const temp = join(root, 'temp')
  mkdirSync(temp, { recursive: true })
  const overrides = o.override === null ? {} : { 'smol-toml': o.override ?? '^1.8.0' }
  writeJson(join(ws, 'package.json'), {
    devDependencies: { vercel: o.pinned ?? VERSION },
    overrides,
  })
  writeJson(join(ws, 'package-lock.json'), {
    packages: { 'node_modules/vercel': { version: o.lockVersion ?? VERSION } },
  })
  writeJson(join(ws, 'node_modules/vercel/package.json'), { name: 'vercel', version: VERSION })
  fakeCli(join(ws, 'node_modules/vercel/dist/vc.js'), o.installed ?? VERSION)
  // Decoy: prints the RIGHT version but is a different file, so only the realpath
  // identity check can tell it from the real CLI. Also serves as the `vite` stand-in.
  fakeCli(join(ws, 'node_modules/decoy/bin.js'), o.installed ?? VERSION)
  fakeCli(join(ws, 'node_modules/vite/bin/vite.js'), '7.0.0')
  const binDir = join(ws, 'node_modules/.bin')
  mkdirSync(binDir, { recursive: true })
  symlinkSync('../vite/bin/vite.js', join(binDir, 'vite'))
  if (o.binTarget !== 'none') {
    const target = o.binTarget === 'decoy' ? '../decoy/bin.js' : '../vercel/dist/vc.js'
    symlinkSync(target, join(binDir, 'vercel'))
  }
  smolToml(join(ws, 'node_modules/smol-toml'), o.hoisted ?? '1.9.0')
  if (o.nested) smolToml(join(ws, 'node_modules/vercel/node_modules/smol-toml'), o.nested)
  const ghPath = join(root, 'github_path')
  writeFileSync(ghPath, '')
  return { ws, temp, ghPath, log: join(root, 'vc.log') }
}

function run(
  t: Tree,
  extraPath?: string,
  args: string[] = [],
  envOverride: Record<string, string | undefined> = {}
) {
  const env: Record<string, string> = {
    PATH: `${extraPath ? extraPath + ':' : ''}${process.env.PATH}`,
    HOME: process.env.HOME ?? '/tmp',
    GITHUB_WORKSPACE: t.ws,
    RUNNER_TEMP: t.temp,
    GITHUB_PATH: t.ghPath,
    VC_LOG: t.log,
  }
  for (const [k, v] of Object.entries(envOverride)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  const r = spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf-8' })
  return { status: r.status, out: r.stdout, err: r.stderr }
}

describe('SMI-6944 Test 4: use-lockfile-vercel.sh', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ulv-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('green: hoisted smol-toml 1.9.0 passes and prints versions and path', () => {
    const t = buildTree(root)
    const r = run(t)
    expect(r.err).toBe('')
    expect(r.status).toBe(0)
    expect(r.out).toContain(`vercel ${VERSION} from lockfile; smol-toml 1.9.0 at `)
    expect(r.out).toContain(join(t.ws, 'node_modules/smol-toml'))
  })

  it('red: hoisted >= 1.8.0 PLUS nested 1.5.2 fails and names the nested path', () => {
    const t = buildTree(root, { nested: '1.5.2' })
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('::error::use-lockfile-vercel: smol-toml-canary')
    expect(r.err).toContain('vercel/node_modules/smol-toml')
    expect(readFileSync(t.ghPath, 'utf-8')).toBe('') // a failed run leaves PATH untouched
  })

  it('fails when the installed version differs from the lockfile version', () => {
    const t = buildTree(root, { installed: '51.0.0' })
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: installed-version')
  })

  it('fails when package.json pin and lockfile version disagree', () => {
    const t = buildTree(root, { pinned: '52.2.1' })
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: pin-matches-lockfile')
  })

  it('binary identity: shim resolves to vc.js and the version check ran through the shim', () => {
    const t = buildTree(root)
    const shim = join(t.temp, 'vercel-bin', 'vercel')
    const r = run(t)
    expect(existsSync(shim)).toBe(true)
    expect(realpathSync(shim)).toBe(realpathSync(join(t.ws, 'node_modules/vercel/dist/vc.js')))
    expect(r.status).toBe(0)
    const calls = readFileSync(t.log, 'utf-8').trim().split('\n')
    expect(calls.some((c) => c === shim)).toBe(true)
  })

  it('wrong binary: a decoy with the right version but another realpath is refused', () => {
    const t = buildTree(root, { binTarget: 'decoy' })
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: binary-identity')
    expect(readFileSync(t.ghPath, 'utf-8')).toBe('')
  })

  it('GITHUB_PATH holds exactly the shim dir and nothing else', () => {
    const t = buildTree(root)
    expect(run(t).status).toBe(0)
    expect(readFileSync(t.ghPath, 'utf-8')).toBe(join(t.temp, 'vercel-bin') + '\n')
  })

  it('no global fallback: .bin/vercel absent plus a global vercel on PATH still fails', () => {
    const t = buildTree(root, { binTarget: 'none' })
    const globalDir = join(root, 'global-bin')
    mkdirSync(globalDir)
    fakeCli(join(globalDir, 'vercel'), VERSION)
    const r = run(t, globalDir)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('run npm ci')
    expect(readFileSync(t.ghPath, 'utf-8')).toBe('')
  })

  it('canary skip: no smol-toml override prints the skip message and still passes a green tree', () => {
    const t = buildTree(root, { override: null })
    const r = run(t)
    expect(r.status).toBe(0)
    expect(r.out).toContain('smol-toml canary skipped: no override recorded')
    expect(r.out).not.toContain('smol-toml 1.')
  })

  it('canary skip does not hide a binary-identity failure', () => {
    const t = buildTree(root, { override: null, binTarget: 'decoy' })
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: binary-identity')
  })
  // ---- M2: identity must not compare the CLI against itself ----------------
  it('symlinked node_modules/vercel (out-of-tree CLI) fails closed with a named error', () => {
    const t = buildTree(root)
    const evil = join(root, 'evil-vercel')
    mkdirSync(join(evil, 'dist'), { recursive: true })
    writeJson(join(evil, 'package.json'), { name: 'vercel', version: VERSION })
    fakeCli(join(evil, 'dist/vc.js'), VERSION)
    smolToml(join(evil, 'node_modules/smol-toml'), '1.9.0')
    rmSync(join(t.ws, 'node_modules/vercel'), { recursive: true })
    symlinkSync(evil, join(t.ws, 'node_modules/vercel'))
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: binary-identity')
    expect(r.err).toContain('is a symlink')
    expect(readFileSync(t.ghPath, 'utf-8')).toBe('')
  })

  it('symlinked dist/vc.js (file elsewhere) fails closed with a named error', () => {
    const t = buildTree(root)
    const elsewhere = join(root, 'elsewhere-vc.js')
    fakeCli(elsewhere, VERSION)
    rmSync(join(t.ws, 'node_modules/vercel/dist/vc.js'))
    symlinkSync(elsewhere, join(t.ws, 'node_modules/vercel/dist/vc.js'))
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: binary-identity')
    expect(r.err).toContain('is a symlink')
  })

  it('control: the same fixture without either symlink passes (the symlink is the only difference)', () => {
    const t = buildTree(root)
    expect(run(t).status).toBe(0)
  })

  // ---- Lvc: the shim dir also exposes `vc` ---------------------------------
  it('shim dir also links vc, resolving to the lockfile vc.js', () => {
    const t = buildTree(root)
    expect(run(t).status).toBe(0)
    const vc = join(t.temp, 'vercel-bin', 'vc')
    expect(existsSync(vc)).toBe(true)
    expect(realpathSync(vc)).toBe(join(t.ws, 'node_modules/vercel/dist/vc.js'))
  })

  // ---- M3: re-verification and the build-log guard --------------------------
  it('verify-only: passes on a good tree, needs no RUNNER_TEMP/GITHUB_PATH, writes no shim and no PATH', () => {
    const t = buildTree(root)
    const r = run(t, undefined, ['--verify-only'], {
      RUNNER_TEMP: undefined,
      GITHUB_PATH: undefined,
    })
    expect(r.err).toBe('')
    expect(r.status).toBe(0)
    expect(r.out).toContain('(verify-only)')
    expect(existsSync(join(t.temp, 'vercel-bin'))).toBe(false)
    expect(readFileSync(t.ghPath, 'utf-8')).toBe('')
  })

  it('verify-only: a decoy binary is refused', () => {
    const t = buildTree(root, { binTarget: 'decoy' })
    const r = run(t, undefined, ['--verify-only'])
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: binary-identity')
  })

  it('verify-only: catches a CLI that changed after the install step (vercel build ran npm install)', () => {
    const t = buildTree(root)
    expect(run(t).status).toBe(0)
    fakeCli(join(t.ws, 'node_modules/vercel/dist/vc.js'), '60.1.3')
    const r = run(t, undefined, ['--verify-only'])
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: installed-version')
  })

  it('verify-only: a nested vulnerable smol-toml that appeared after install is named', () => {
    const t = buildTree(root)
    expect(run(t).status).toBe(0)
    smolToml(join(t.ws, 'node_modules/vercel/node_modules/smol-toml'), '1.5.2')
    const r = run(t, undefined, ['--verify-only'])
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: smol-toml-canary')
  })

  describe('--check-build-log', () => {
    const logAt = (name: string, text: string) => {
      const p = join(root, name)
      writeFileSync(p, text)
      return p
    }
    it('control: a non-empty clean log passes', () => {
      const t = buildTree(root)
      const r = run(t, undefined, [
        '--check-build-log',
        logAt('clean.log', 'Build Completed in .vercel/output [2s]\n'),
      ])
      expect(r.status).toBe(0)
      expect(r.out).toContain('holds no runtime builder install')
    })
    it('fails and names the line when a builder was installed at build time', () => {
      const t = buildTree(root)
      const log = logAt(
        'evil.log',
        'Running "install" command: `npm install`...\nInstalling Builder: @vercel/node@5.0.0\ndone\n'
      )
      const r = run(t, undefined, ['--check-build-log', log])
      expect(r.status).not.toBe(0)
      expect(r.err).toContain('use-lockfile-vercel: builder-install')
      expect(r.err).toContain('Installing Builder: @vercel/node@5.0.0')
    })
    it('an empty or missing log is NOT EVALUATED, never clean', () => {
      const t = buildTree(root)
      const empty = run(t, undefined, ['--check-build-log', logAt('empty.log', '')])
      expect(empty.status).not.toBe(0)
      expect(empty.err).toContain('use-lockfile-vercel: build-log')
      const missing = run(t, undefined, ['--check-build-log', join(root, 'nope.log')])
      expect(missing.status).not.toBe(0)
      expect(missing.err).toContain('use-lockfile-vercel: build-log')
    })
  })

  it('rejects an unknown argument', () => {
    const r = run(buildTree(root), undefined, ['--bogus'])
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: usage')
  })

  // ---- L2: a relative or unset GITHUB_WORKSPACE fails before any node call ----
  it('relative GITHUB_WORKSPACE: named error and node is never invoked', () => {
    const t = buildTree(root)
    const spyBin = join(root, 'spy-bin')
    mkdirSync(spyBin)
    const spyLog = join(root, 'node-called')
    writeFileSync(join(spyBin, 'node'), `#!/bin/sh\necho called >> '${spyLog}'\nexit 99\n`)
    chmodSync(join(spyBin, 'node'), 0o755)
    const r = run(t, spyBin, [], { GITHUB_WORKSPACE: 'ws' })
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: environment')
    expect(r.err).toContain('must be an absolute path')
    expect(existsSync(spyLog)).toBe(false)
    // presence control: the spy IS reached when the workspace is absolute.
    const ok = run(t, spyBin)
    expect(existsSync(spyLog)).toBe(true)
    expect(ok.status).not.toBe(0)
  })

  it('unset GITHUB_WORKSPACE: named error', () => {
    const r = run(buildTree(root), undefined, [], { GITHUB_WORKSPACE: undefined })
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('GITHUB_WORKSPACE is not set')
  })
})
