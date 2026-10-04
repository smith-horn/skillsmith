/**
 * SMI-6944: shared fake-tree fixture for scripts/ci/use-lockfile-vercel.sh tests.
 *
 * GITHUB_WORKSPACE, RUNNER_TEMP, GITHUB_PATH and GITHUB_OUTPUT are set per run (no
 * seam in the script). The fake `vercel` CLI logs the path it was invoked by, so
 * tests can prove the version check ran THROUGH the shim. The fake lockfile gives
 * the CLI a real closure: `node_modules/vercel` requires a hoisted `smol-toml` and
 * a hoisted `@vercel/build-utils`, so the content digest covers files outside
 * `node_modules/vercel` too. `@vercel/build-utils` declares an optional peer
 * (`encoding`) the lockfile does not resolve.
 *
 * @see docs/internal/implementation/smi-6944-vercel-cli-from-lockfile.md
 */
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

export const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'ci',
  'use-lockfile-vercel.sh'
)
export const VERSION = '52.2.0'
export const BUILD_UTILS_JS = 'node_modules/@vercel/build-utils/dist/index.js'

export interface Tree {
  root: string
  ws: string
  temp: string
  ghPath: string
  ghOutput: string
  log: string
}

export function writeJson(path: string, obj: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(obj))
}

export function fakeCli(path: string, version: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `#!/usr/bin/env node\nrequire('fs').appendFileSync(process.env.VC_LOG, process.argv[1] + '\\n')\nconsole.log('${version}')\n// end of fake CLI\n`
  )
  chmodSync(path, 0o755)
}

export function smolToml(dir: string, version: string) {
  writeJson(join(dir, 'package.json'), { name: 'smol-toml', version, main: 'index.js' })
  writeFileSync(join(dir, 'index.js'), '')
}

export interface Opts {
  override?: string | null
  nested?: string | null
  hoisted?: string
  lockVersion?: string
  pinned?: string
  installed?: string
  binTarget?: 'vc' | 'decoy' | 'none'
}

export function buildTree(root: string, o: Opts = {}): Tree {
  const ws = join(root, 'ws')
  const temp = join(root, 'temp')
  mkdirSync(temp, { recursive: true })
  const overrides = o.override === null ? {} : { 'smol-toml': o.override ?? '^1.8.0' }
  writeJson(join(ws, 'package.json'), {
    devDependencies: { vercel: o.pinned ?? VERSION },
    overrides,
  })
  const hoisted = o.hoisted ?? '1.9.0'
  const packages: Record<string, unknown> = {
    'node_modules/vercel': {
      version: o.lockVersion ?? VERSION,
      dependencies: { 'smol-toml': '1.5.2', '@vercel/build-utils': '13.20.0' },
    },
    'node_modules/smol-toml': { version: hoisted },
    // An optional peer the lockfile does not resolve, like node-fetch's `encoding`
    // in the real closure: the digest must record it and refuse a planted copy.
    'node_modules/@vercel/build-utils': {
      version: '13.20.0',
      peerDependencies: { encoding: '^0.1.0' },
      peerDependenciesMeta: { encoding: { optional: true } },
    },
  }
  if (o.nested) packages['node_modules/vercel/node_modules/smol-toml'] = { version: o.nested }
  writeJson(join(ws, 'package-lock.json'), { lockfileVersion: 3, packages })
  writeJson(join(ws, 'node_modules/vercel/package.json'), { name: 'vercel', version: VERSION })
  fakeCli(join(ws, 'node_modules/vercel/dist/vc.js'), o.installed ?? VERSION)
  writeJson(join(ws, 'node_modules/@vercel/build-utils/package.json'), {
    name: '@vercel/build-utils',
    version: '13.20.0',
  })
  mkdirSync(join(ws, dirname(BUILD_UTILS_JS)), { recursive: true })
  writeFileSync(join(ws, BUILD_UTILS_JS), 'module.exports = { ok: true }\n')
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
  smolToml(join(ws, 'node_modules/smol-toml'), hoisted)
  if (o.nested) smolToml(join(ws, 'node_modules/vercel/node_modules/smol-toml'), o.nested)
  const ghPath = join(root, 'github_path')
  writeFileSync(ghPath, '')
  const ghOutput = join(root, 'github_output')
  writeFileSync(ghOutput, '')
  return { root, ws, temp, ghPath, ghOutput, log: join(root, 'vc.log') }
}

export function run(
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
    GITHUB_OUTPUT: t.ghOutput,
    VC_LOG: t.log,
  }
  for (const [k, v] of Object.entries(envOverride)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  const r = spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf-8' })
  return { status: r.status, out: r.stdout, err: r.stderr }
}

/** The `digest=` value(s) an install-mode run appended to the given GITHUB_OUTPUT file. */
export function outputDigests(file: string): string[] {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.startsWith('digest='))
    .map((l) => l.slice('digest='.length))
}

/** Install mode on a green tree; returns the digest the step published. */
export function install(t: Tree): string {
  const r = run(t)
  if (r.status !== 0) throw new Error(`install mode failed: ${r.err}`)
  const d = outputDigests(t.ghOutput)
  if (d.length !== 1) throw new Error(`expected one digest output, got ${d.length}`)
  return d[0]
}

/** Verify mode with the given expected digest passed the way the workflow passes it. */
export function verify(
  t: Tree,
  digest: string | undefined,
  extra: Record<string, string | undefined> = {}
) {
  return run(t, undefined, ['--verify-only'], {
    VERCEL_CLI_DIGEST: digest,
    GITHUB_PATH: undefined,
    GITHUB_OUTPUT: undefined,
    ...extra,
  })
}
