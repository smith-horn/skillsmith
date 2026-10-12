/**
 * SMI-6945 pin for the R4 acceptance on basic-ftp (GHSA-c475-qrg2-pj4r)
 * in .github/dependency-registry.json. It is reached through proxy-agent,
 * pac-proxy-agent and get-uri only for an ftp: PAC URL, so the condition is
 * that no repo-controlled environment configures a proxy: no workflow, Dockerfile,
 * docker-compose file, e2e config, package.json `scripts` value, or shell/JS launch
 * helper (scripts/**\/*.sh, root *.sh, packages/vscode-extension .sh/.js/.mjs/.cjs)
 * sets HTTP_PROXY / HTTPS_PROXY / ALL_PROXY /
 * npm_config_proxy (any case; also npm_config_https_proxy and `npm config set
 * proxy`) or uses a `pac+` URL. NO_PROXY is not a proxy and is not flagged.
 *
 * Scope is the files this repo itself controls; a developer's shell or a CI
 * runner's own environment cannot be pinned from a test.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const PROXY_VAR =
  /(?<![A-Za-z0-9_])(?:https?_proxy|all_proxy|npm_config_(?:https_)?proxy)(?![A-Za-z0-9_])/i
const NPM_CONFIG_SET = /npm\s+config\s+set\s+(?:https-)?proxy\b/i
const PAC_URL = /\bpac\+(?:https?|file|ftp|data):/i

/** Lines of `text` that configure a proxy; `#` comment lines are ignored. */
export function proxyFindings(text: string): string[] {
  return text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*#/.test(line))
    .filter(({ line }) => PROXY_VAR.test(line) || NPM_CONFIG_SET.test(line) || PAC_URL.test(line))
    .map(({ line, n }) => `${n}: ${line.trim()}`)
}

/** The values of a package.json `scripts` object, one per line; unparseable JSON is itself a finding. */
export function scriptValues(packageJson: string): string {
  try {
    const scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts
    return Object.values(scripts ?? {})
      .filter((v): v is string => typeof v === 'string')
      .join('\n')
  } catch {
    return 'package.json is not parseable: HTTPS_PROXY'
  }
}

const WALK_SKIP = new Set([
  'node_modules',
  '.git',
  '.worktrees',
  'dist',
  'out',
  '.vercel',
  'coverage',
])

/** Files under `dir` (recursive, skipping build and dependency trees) whose name matches `re`. */
function walk(dir: string, re: RegExp): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  // Dirent type, not stat: a dangling symlink (the container's /app/.env) must not throw.
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (WALK_SKIP.has(ent.name)) continue
    const p = join(dir, ent.name)
    if (ent.isDirectory()) found.push(...walk(p, re))
    else if (ent.isFile() && re.test(ent.name)) found.push(p)
  }
  return found
}

interface Scan {
  /** Whole-file scans: workflows, Dockerfiles, compose, wdio configs, launch helpers. */
  files: string[]
  /** package.json files, scanned through their `scripts` values only. */
  packageJsons: string[]
  /** The subset of `files` that are shell or JS launch helpers. */
  helpers: string[]
}

function repoControlledFiles(): Scan {
  const files: string[] = []
  const wf = join(REPO_ROOT, '.github/workflows')
  for (const f of readdirSync(wf)) if (/\.ya?ml$/.test(f)) files.push(join(wf, f))
  for (const f of readdirSync(REPO_ROOT)) {
    if (/^Dockerfile/.test(f) || /^docker-compose.*\.ya?ml$/.test(f)) files.push(join(REPO_ROOT, f))
  }
  const pk = join(REPO_ROOT, 'packages')
  for (const p of readdirSync(pk)) {
    const d = join(pk, p)
    for (const f of readdirSync(d)) if (/^Dockerfile/.test(f)) files.push(join(d, f))
  }
  const e2e = join(pk, 'vscode-extension/e2e')
  for (const f of readdirSync(e2e))
    if (/^wdio.*\.conf\.[cm]?[jt]s$/.test(f)) files.push(join(e2e, f))
  const helpers = [
    ...readdirSync(REPO_ROOT)
      .filter((f) => /\.sh$/.test(f))
      .map((f) => join(REPO_ROOT, f)),
    ...walk(join(REPO_ROOT, 'scripts'), /\.sh$/),
    ...walk(join(pk, 'vscode-extension'), /\.(?:sh|[cm]?js)$/),
  ]
  const packageJsons = walk(REPO_ROOT, /^package\.json$/)
  return {
    files: [...files, ...helpers].filter((f) => existsSync(f)),
    packageJsons,
    helpers,
  }
}

describe('R4 pin: no PAC or proxy configuration in repo-controlled environments (SMI-6945)', () => {
  const scan = repoControlledFiles()
  const files = scan.files
  const rel = (f: string) => relative(REPO_ROOT, f)

  it('presence control: the scan covers workflows, the Dockerfile, compose and the e2e config', () => {
    const names = files.map(rel)
    expect(names.filter((n) => n.startsWith('.github/workflows/')).length).toBeGreaterThan(10)
    for (const must of [
      'Dockerfile',
      'docker-compose.yml',
      'packages/vscode-extension/e2e/wdio.conf.ts',
    ]) {
      expect(names).toContain(must)
    }
  })
  it('presence control: package.json scripts and launch helpers are scanned', () => {
    const pkgs = scan.packageJsons.map(rel)
    expect(pkgs).toContain('package.json')
    expect(pkgs).toContain('packages/vscode-extension/package.json')
    expect(pkgs.filter((n) => n.startsWith('packages/')).length).toBeGreaterThanOrEqual(5)
    expect(pkgs.some((n) => n.includes('node_modules'))).toBe(false)
    const helpers = scan.helpers.map(rel)
    expect(helpers.filter((n) => /^scripts\/.*\.sh$/.test(n)).length).toBeGreaterThan(20)
    expect(helpers).toContain('packages/vscode-extension/scripts/validate-vsix.mjs')
    // the root package.json really has script values to scan (not an empty extraction)
    const root = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
    expect(scriptValues(root).split('\n').length).toBeGreaterThan(10)
  })
  it('no scanned file configures a proxy or a pac+ URL', () => {
    const hits = files
      .map((f) => ({ file: rel(f), findings: proxyFindings(readFileSync(f, 'utf8')) }))
      .filter((h) => h.findings.length > 0)
    expect(hits).toEqual([])
  })
  it('no package.json script configures a proxy or a pac+ URL', () => {
    const hits = scan.packageJsons
      .map((f) => ({
        file: rel(f),
        findings: proxyFindings(scriptValues(readFileSync(f, 'utf8'))),
      }))
      .filter((h) => h.findings.length > 0)
    expect(hits).toEqual([])
  })
  it('known-positive: a package.json script setting a pac+ftp proxy is flagged', () => {
    const pkg = JSON.stringify({
      scripts: { e2e: 'HTTPS_PROXY=pac+ftp://host/proxy.pac wdio run x' },
    })
    expect(proxyFindings(scriptValues(pkg)).length).toBeGreaterThan(0)
  })
  it('known-positive: a script that is not the first one, and an unparseable package.json, are flagged', () => {
    const pkg = JSON.stringify({ scripts: { a: 'tsc', b: 'npm config set proxy http://p:1' } })
    expect(proxyFindings(scriptValues(pkg)).length).toBeGreaterThan(0)
    expect(proxyFindings(scriptValues('{ not json')).length).toBeGreaterThan(0)
  })
  it('known-negative: package.json scripts and fields that only mention NO_PROXY or a proxy package pass', () => {
    const pkg = JSON.stringify({
      name: 'api-proxy',
      dependencies: { 'proxy-agent': '1' },
      scripts: { test: 'NO_PROXY=localhost vitest run', dev: 'tsx src/proxy.ts' },
    })
    expect(proxyFindings(scriptValues(pkg))).toEqual([])
  })

  // Known-positive fixtures: the scanner must flag each, in each file's own syntax.
  it.each([
    ['workflow env mapping', 'env:\n  HTTP_PROXY: http://proxy:3128'],
    ['lowercase', 'export https_proxy=http://p:1'],
    ['Dockerfile ENV', 'ENV ALL_PROXY socks5://p:1'],
    ['compose list form', '    - HTTPS_PROXY=http://p:1'],
    ['npm_config_proxy', 'npm_config_proxy=http://p:1'],
    ['npm_config_https_proxy', 'NPM_CONFIG_HTTPS_PROXY: x'],
    ['npm config set', 'run: npm config set proxy http://p:1'],
    ['pac+ URL', 'PROXY_URL=pac+http://host/wpad.dat'],
    ['pac+ ftp PAC', 'x: pac+ftp://host/proxy.pac'],
  ])('known-positive: %s is flagged', (_label, text) => {
    expect(proxyFindings(text).length).toBeGreaterThan(0)
  })
  // Known-negatives: near misses that are not a proxy setting.
  it.each([
    ['NO_PROXY', 'NO_PROXY: localhost'],
    ['a longer name', 'MY_HTTP_PROXY_NOTE: x'],
    ['a comment', '# HTTP_PROXY: documented but not set'],
    ['npm config set registry', 'npm config set registry https://registry.npmjs.org'],
  ])('known-negative: %s is not flagged', (_label, text) => {
    expect(proxyFindings(text)).toEqual([])
  })
})
