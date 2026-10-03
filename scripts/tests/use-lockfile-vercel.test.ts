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

function run(t: Tree, extraPath?: string) {
  const env: Record<string, string> = {
    PATH: `${extraPath ? extraPath + ':' : ''}${process.env.PATH}`,
    HOME: process.env.HOME ?? '/tmp',
    GITHUB_WORKSPACE: t.ws,
    RUNNER_TEMP: t.temp,
    GITHUB_PATH: t.ghPath,
    VC_LOG: t.log,
  }
  const r = spawnSync('bash', [SCRIPT], { env, encoding: 'utf-8' })
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
})
