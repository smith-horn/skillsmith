/**
 * SMI-7112 (S1.5): no workflow may reference a `secrets.*_PROD` secret -- none of
 * them exist in this repo, so a reference silently evaluates to an empty string
 * (autochain run 38014337978 logged `SUPABASE_URL_PROD: ` and concluded success).
 *
 * The scan enumerates EVERY .github/workflows/*.yml and *.yaml, asserts that
 * list and the scan itself are non-vacuous, and names every offending file:line.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows')

const PROD_SECRET = /secrets\.[A-Za-z0-9_]+_PROD\b|secrets\[\s*['"][A-Za-z0-9_]+_PROD['"]\s*\]/
const ANY_SECRET = /secrets\.[A-Za-z0-9_]+|secrets\[\s*['"][A-Za-z0-9_]+['"]\s*\]/

const files = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort()

/** Lines that are not whole-line YAML comments, with 1-based numbers. */
function codeLines(file: string): Array<{ n: number; text: string }> {
  return readFileSync(join(WORKFLOW_DIR, file), 'utf8')
    .split('\n')
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => !text.trimStart().startsWith('#'))
}

describe('workflow secret references', () => {
  it('CONTROL: the workflow list is non-empty and the scan sees real secrets. references', () => {
    expect(files.length).toBeGreaterThan(0)
    const scanned = files.flatMap((f) => codeLines(f).filter(({ text }) => ANY_SECRET.test(text)))
    expect(scanned.length).toBeGreaterThan(0)
  })

  it('no workflow references secrets.*_PROD (every offending file:line is listed)', () => {
    const offenders: string[] = []
    for (const f of files) {
      for (const { n, text } of codeLines(f)) {
        if (PROD_SECRET.test(text)) offenders.push(`${f}:${n}: ${text.trim()}`)
      }
    }
    expect(offenders, `nonexistent _PROD secret referenced:\n${offenders.join('\n')}`).toEqual([])
  })
})
