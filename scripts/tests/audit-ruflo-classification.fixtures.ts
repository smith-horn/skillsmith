/**
 * SMI-6744 A5.3: shared in-memory fixtures for the Check 79 twin tests
 * (audit-ruflo-classification.test.ts and audit-ruflo-classification.parser.test.ts).
 * Not a test file: vitest collects only *.test.ts / *.spec.ts.
 */
// @ts-expect-error - .mjs helper has no typings
import {
  RUFLO_CORE_DENY_ENTRIES,
  evaluateRufloClassification,
} from '../audit-ruflo-classification-helpers.mjs'
// @ts-expect-error - .mjs helper has no typings
import { RUFLO_MCP_DENY_ENTRIES } from '../audit-ruflo-mcp-denies-helpers.mjs'

export const P = 'mcp__ruflo__'
export const CORE: string[] = [...RUFLO_CORE_DENY_ENTRIES]
export const WAVE4: string[] = [...RUFLO_MCP_DENY_ENTRIES]
export const SETTINGS = '/fx/settings.json'
export const DOC = '/fx/doc.md'

export interface Row {
  prefix: string
  allowed: string
  blocked: string
}
export interface Fx {
  deny: unknown
  docDeny: unknown
  rows: Row[]
  settingsText?: string
  docFence?: string
  extraFence?: boolean
  strayRow?: string
  unclosedFence?: boolean
  extraTableLines?: string[]
  settingsThrows?: boolean
  docThrows?: boolean
  docPresent?: boolean
  core?: string[]
  mcp?: string[]
}

export function prefixOf(name: string): string {
  if (name.startsWith('managed_agent_')) return 'managed_agent_'
  return /^[a-z0-9-]+_/.exec(name)![0]
}

export function rowsFor(denies: string[]): Row[] {
  const by = new Map<string, string[]>()
  for (const d of denies) {
    const name = d.slice(P.length)
    const pre = prefixOf(name)
    by.set(pre, [...(by.get(pre) ?? []), name.slice(pre.length)])
  }
  return [...by].map(([prefix, sfx]) => ({
    prefix,
    allowed: '`safe`',
    blocked: sfx.map((s) => `\`${s}\``).join(', '),
  }))
}

export function base(): Fx {
  return {
    deny: ['Bash(ls)', ...CORE, ...WAVE4],
    docDeny: [...CORE],
    rows: rowsFor([...CORE, ...WAVE4]),
  }
}

export function render(fx: Fx): Record<string, string> {
  const files: Record<string, string> = {}
  files[SETTINGS] = fx.settingsText ?? JSON.stringify({ permissions: { deny: fx.deny } })
  if (fx.docPresent === false) return files
  const fence = fx.docFence ?? JSON.stringify({ permissions: { deny: fx.docDeny } }, null, 2)
  const table = fx.rows.map((r) => `| \`${r.prefix}*\` | ${r.allowed} | ${r.blocked} |`)
  files[DOC] = [
    '# Doc',
    '```json',
    fence,
    ...(fx.unclosedFence ? [] : ['```']),
    ...(fx.extraFence ? ['```json', '{}', '```'] : []),
    '## Full classification table',
    '| Prefix | Allowed | Blocked |',
    '|---|---|---|',
    ...table,
    '| | | a continuation row, not parsed |',
    ...(fx.extraTableLines ?? []),
    '## Next',
    ...(fx.strayRow ? [fx.strayRow] : []),
    '',
  ].join('\n')
  return files
}

export function run(fx: Fx) {
  const files = render(fx)
  return evaluateRufloClassification({
    settingsPath: SETTINGS,
    docPath: DOC,
    readFile: (p: string) => {
      if (fx.settingsThrows && p === SETTINGS) throw new Error('EACCES settings')
      if (fx.docThrows && p === DOC) throw new Error('EACCES doc')
      if (!(p in files)) throw new Error(`ENOENT ${p}`)
      return files[p]
    },
    exists: (p: string) => p in files,
    ...(fx.core ? { coreEntries: fx.core } : {}),
    ...(fx.mcp ? { mcpEntries: fx.mcp } : {}),
  })
}

export function applied(name: string): void {
  console.log(`applied=${name}`)
}

export function row(fx: Fx, prefix: string): Row {
  return fx.rows.find((r) => r.prefix === prefix)!
}
