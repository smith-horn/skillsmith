/**
 * SMI-6945 pin for the R4 acceptances on @fastify/static, fastify and file-type
 * (.github/dependency-registry.json). Their vulnerable code runs only on the
 * VS Code Web path of wdio-vscode-service. That is reached when a capability
 * carries `wdio:vscodeOptions` with a `browserName` other than 'vscode'
 * (node_modules/wdio-vscode-service/dist/launcher.js: `if (cap.browserName ===
 * 'vscode') { desktop } else { _setupVSCodeWeb }`); `serverOptions` is the web
 * server option (its README: "Define options when testing VSCode web
 * extensions", types.d.ts ServerOptions). So the condition pinned here is:
 * every wdio config under packages/vscode-extension sets browserName to the
 * literal 'vscode' on every capability and carries no web-mode option.
 *
 * Assumption: the web options are `serverOptions` (the only one the types
 * declare) plus any key spelled isWeb / vscode-web / vscodeWeb. A config that
 * builds browserName dynamically (not a string literal) cannot be proven
 * desktop-only statically, so it is reported as a failure, not skipped.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const EXT_ROOT = join(REPO_ROOT, 'packages/vscode-extension')
const WDIO_CONF = /^wdio[^/]*\.conf\.[cm]?[jt]s$/
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'out'])

function findWdioConfigs(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) found.push(...findWdioConfigs(p))
    else if (WDIO_CONF.test(name)) found.push(p)
  }
  return found
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

/** Reasons a wdio config source could put VS Code into web mode; [] means desktop-only. */
export function webModeProblems(source: string): string[] {
  const src = stripComments(source)
  const problems: string[] = []
  const names = [...src.matchAll(/\bbrowserName\s*:\s*([^,}\n]+)/g)].map((m) => m[1].trim())
  if (names.length === 0) problems.push('no browserName is set')
  for (const n of names) {
    if (!/^'vscode'$|^"vscode"$|^`vscode`$/.test(n)) {
      problems.push(`browserName ${n} is not the literal 'vscode'`)
    }
  }
  for (const key of ['serverOptions', 'isWeb', 'vscode-web', 'vscodeWeb']) {
    if (new RegExp(`['"\`]?${key}['"\`]?\\s*:`).test(src)) {
      problems.push(`web option ${key} is set`)
    }
  }
  return problems
}

describe('R4 pin: wdio-vscode-service runs desktop VS Code only (SMI-6945)', () => {
  const configs = findWdioConfigs(EXT_ROOT)

  it('presence control: the glob finds the real e2e config', () => {
    expect(configs.map((c) => relative(EXT_ROOT, c))).toContain('e2e/wdio.conf.ts')
  })
  it('every real wdio config is desktop-only', () => {
    for (const c of configs) {
      expect({
        file: relative(REPO_ROOT, c),
        problems: webModeProblems(readFileSync(c, 'utf8')),
      }).toEqual({
        file: relative(REPO_ROOT, c),
        problems: [],
      })
    }
  })

  // Known-positive and known-negative fixtures: the scanner must tell them apart.
  it('control: a desktop capability passes', () => {
    expect(
      webModeProblems(`capabilities: [{ browserName: 'vscode', 'wdio:vscodeOptions': {} }]`)
    ).toEqual([])
  })
  it('a chrome capability (the web trigger) is flagged', () => {
    expect(webModeProblems(`capabilities: [{ browserName: 'chrome' }]`).join()).toMatch(
      /browserName 'chrome'/
    )
  })
  it('a non-literal browserName is flagged, not assumed safe', () => {
    expect(webModeProblems(`capabilities: [{ browserName: process.env.B }]`).join()).toMatch(
      /not the literal/
    )
  })
  it('a second capability that is not vscode is flagged even if the first is vscode', () => {
    const src = `capabilities: [{ browserName: 'vscode' }, { browserName: 'chrome' }]`
    expect(webModeProblems(src).join()).toMatch(/'chrome'/)
  })
  it.each(['serverOptions: { hostname: "x", port: 1 }', "'vscode-web': true", 'isWeb: true'])(
    'web option %s is flagged',
    (opt) => {
      expect(webModeProblems(`{ browserName: 'vscode', ${opt} }`).join()).toMatch(/web option/)
    }
  )
  it('a config with no browserName is flagged', () => {
    expect(webModeProblems(`export const config = {}`).join()).toMatch(/no browserName/)
  })
  it('a comment that mentions the web option does not count, and a commented-out chrome does not hide a real one', () => {
    expect(webModeProblems(`// serverOptions: x\n{ browserName: 'vscode' }`)).toEqual([])
    expect(webModeProblems(`// browserName: 'vscode'\n{ browserName: 'chrome' }`).join()).toMatch(
      /'chrome'/
    )
  })
})
