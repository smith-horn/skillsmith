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
 * Rule (static, deliberately strict): in each wdio config the only mention of
 * `capabilities` is `capabilities: [ {...}, {...} ]` and every element is a
 * LITERAL object. Inside a capability object there is no spread, computed key,
 * shorthand or method (each could smuggle a browserName in from elsewhere), and
 * the object has its own depth-1 `browserName` whose value is the literal 'vscode'.
 * No name imported from a local module (./ or ../) may be referenced anywhere
 * inside the capabilities value. Plain local consts and node builtins (path,
 * process.execPath) are allowed as option VALUES: they cannot change browserName,
 * because browserName must itself be the literal. Anything that cannot be proven
 * this way is a failure, not a skip.
 *
 * Assumption: the web options are `serverOptions` (the only one the types
 * declare) plus any key spelled isWeb / vscode-web / vscodeWeb. A config that
 * builds its capabilities outside this literal shape fails and must be reviewed.
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

const QUOTES = new Set(["'", '"', '`'])
const OPEN = '[{('
const CLOSE = ']})'

/** Index of the closing quote of the string literal opening at `i`. */
function skipString(src: string, i: number): number {
  const q = src[i]
  let j = i + 1
  while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1
  return j
}

/** Index just past the bracket group opening at `start`; -1 if unbalanced. */
function matchGroup(src: string, start: number): number {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (QUOTES.has(c)) i = skipString(src, i)
    else if (OPEN.includes(c)) depth++
    else if (CLOSE.includes(c) && --depth === 0) return i + 1
  }
  return -1
}

/** Depth-1 comma-separated entries of the group whose opening bracket is group[0]. */
function topLevelEntries(group: string): string[] {
  const inner = group.slice(1, -1)
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (QUOTES.has(c)) i = skipString(inner, i)
    else if (OPEN.includes(c)) depth++
    else if (CLOSE.includes(c)) depth--
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(from, i))
      from = i + 1
    }
  }
  parts.push(inner.slice(from))
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

/** Names bound by `import ... from './x'` or `'../x'` (not packages or node: builtins). */
function localImportNames(src: string): string[] {
  const names: string[] = []
  for (const m of src.matchAll(/import\s+([^;'"]*?)\s+from\s+['"](\.{1,2}\/[^'"]*)['"]/g)) {
    for (const n of m[1].replace(/[{}*]/g, ' ').split(/[\s,]+/)) {
      if (/^[A-Za-z_$][\w$]*$/.test(n) && n !== 'as' && n !== 'type') names.push(n)
    }
  }
  return names
}

function capabilityProblems(value: string, src: string): string[] {
  const problems: string[] = []
  const elements = topLevelEntries(value)
  if (elements.length === 0) problems.push('capabilities array is empty')
  for (const el of elements) {
    if (!el.startsWith('{') || matchGroup(el, 0) !== el.length) {
      problems.push(`capability ${el.slice(0, 40)} is not a literal object`)
      continue
    }
    const entries = topLevelEntries(el)
    for (const e of entries) {
      if (e.startsWith('...')) problems.push(`capability contains a spread (${e.slice(0, 40)})`)
      else if (e.startsWith('[')) problems.push(`capability has a computed key (${e.slice(0, 40)})`)
      else if (!/^(['"`]?)[\w:.$-]+\1\s*:/.test(e)) {
        problems.push(`capability entry ${e.slice(0, 40)} is not a plain key: value`)
      }
    }
    const names = entries.filter((e) => /^(['"`]?)browserName\1\s*:/.test(e))
    if (names.length !== 1) problems.push(`capability has ${names.length} browserName entries`)
    for (const n of names) {
      const v = n.slice(n.indexOf(':') + 1).trim()
      if (!/^'vscode'$|^"vscode"$|^`vscode`$/.test(v)) {
        problems.push(`browserName ${v} is not the literal 'vscode'`)
      }
    }
  }
  for (const name of localImportNames(src)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`).test(value)) {
      problems.push(`capabilities reference the locally imported name ${name}`)
    }
  }
  return problems
}

/** Reasons a wdio config source could put VS Code into web mode; [] means desktop-only. */
export function webModeProblems(source: string): string[] {
  const src = stripComments(source)
  const problems: string[] = []
  const uses = [...src.matchAll(/\bcapabilities\b/g)]
  const literal = [...src.matchAll(/\bcapabilities\s*:\s*(?=\[)/g)]
  if (uses.length === 0) problems.push('no capabilities are set')
  else if (uses.length !== 1 || literal.length !== 1) {
    problems.push('capabilities value is not a single `capabilities: [ ... ]` literal array')
  } else {
    const start = literal[0].index! + literal[0][0].length
    const end = matchGroup(src, start)
    if (end === -1) problems.push('capabilities array is not balanced')
    else problems.push(...capabilityProblems(src.slice(start, end), src))
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
  it('control: local consts and builtins as option VALUES pass', () => {
    const src = `import path from 'node:path'
const P = path.resolve('x')
capabilities: [{ browserName: 'vscode', 'wdio:vscodeOptions': { extensionPath: P, nested: [1, { a: "}" }] } }]`
    expect(webModeProblems(src)).toEqual([])
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
      expect(webModeProblems(`capabilities: [{ browserName: 'vscode', ${opt} }]`).join()).toMatch(
        /web option/
      )
    }
  )
  it('a config with no capabilities is flagged', () => {
    expect(webModeProblems(`export const config = {}`).join()).toMatch(/no capabilities/)
  })
  it('a comment that mentions the web option does not count, and a commented-out chrome does not hide a real one', () => {
    expect(
      webModeProblems(`// serverOptions: x\ncapabilities: [{ browserName: 'vscode' }]`)
    ).toEqual([])
    expect(
      webModeProblems(`// browserName: 'vscode'\ncapabilities: [{ browserName: 'chrome' }]`).join()
    ).toMatch(/'chrome'/)
  })

  // SMI-6949 round 4: capabilities merged in from elsewhere are never scanned, so they fail.
  it('a spread inside a capability object is flagged', () => {
    const src = `import { webCaps } from './caps'\ncapabilities: [{ ...webCaps }]`
    expect(webModeProblems(src).join()).toMatch(/spread/)
  })
  it('a spread that follows a literal vscode browserName is still flagged (it can override it)', () => {
    const src = `const w = {}\ncapabilities: [{ browserName: 'vscode', ...w }]`
    expect(webModeProblems(src).join()).toMatch(/spread/)
  })
  it('capabilities set to an imported identifier is flagged', () => {
    const src = `import { helperCaps } from './caps'\nexport const config = { capabilities: helperCaps }`
    expect(webModeProblems(src).join()).toMatch(/capabilities value is not/)
  })
  it('capabilities assigned outside a literal array is flagged', () => {
    const src = `capabilities: [{ browserName: 'vscode' }]\nconfig.capabilities = other`
    expect(webModeProblems(src).join()).toMatch(/capabilities value is not/)
  })
  it('a capabilities array containing an identifier is flagged', () => {
    const src = `import { webCap } from './caps'\ncapabilities: [{ browserName: 'vscode' }, webCap]`
    expect(webModeProblems(src).join()).toMatch(/is not a literal object/)
  })
  it('a locally imported name referenced inside capabilities is flagged', () => {
    const src = `import { webOpts } from './opts'\ncapabilities: [{ browserName: 'vscode', 'wdio:vscodeOptions': webOpts }]`
    expect(webModeProblems(src).join()).toMatch(/locally imported name webOpts/)
  })
  it('a computed key inside a capability is flagged', () => {
    const src = `capabilities: [{ browserName: 'vscode', [k]: 'chrome' }]`
    expect(webModeProblems(src).join()).toMatch(/computed key/)
  })
  it('a capability with no own browserName (only a nested one) is flagged', () => {
    const src = `capabilities: [{ 'wdio:vscodeOptions': { browserName: 'vscode' } }]`
    expect(webModeProblems(src).join()).toMatch(/0 browserName entries/)
  })
})
