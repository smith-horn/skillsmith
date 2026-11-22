/**
 * SMI-6531 (A1 step 8-i-a-1): the park-result path is the only way a product
 * caller reaches the park. The production modules (core, cli, mcp-server;
 * test files excluded) that import `parkTreeIndexed` are exactly
 * `core/src/services/park-report.ts`, so every park goes through a reporter
 * and no caller can skip the space warning (A1 plan §3.5, T-PW1).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PACKAGES = path.resolve(__dirname, '../../../..')
const ROOTS = ['core/src', 'cli/src', 'mcp-server/src'].map((r) => path.join(PACKAGES, r))
const IMPORTS =
  /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\bparkTreeIndexed\b[^}]*\}\s*from\s*['"][^'"]+['"]/

function productionFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== '__tests__') out.push(...productionFiles(p))
    } else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

describe('the park-result boundary', () => {
  it('the only production importer of parkTreeIndexed is park-report.ts', () => {
    const files = ROOTS.flatMap(productionFiles)
    // A walk that found nothing would pass the equality below vacuously.
    expect(files.length).toBeGreaterThan(100)
    const importers = files
      .filter((f) => IMPORTS.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(PACKAGES, f))
    expect(importers).toEqual([path.join('core', 'src', 'services', 'park-report.ts')])
  })

  it('the pattern matches the import forms it must catch, and not a mention in prose', () => {
    expect(IMPORTS.test("import { parkTreeIndexed } from '../install/park-call.js'")).toBe(true)
    expect(IMPORTS.test("import {\n  a,\n  parkTreeIndexed,\n} from './x.js'")).toBe(true)
    expect(IMPORTS.test("export { parkTreeIndexed } from './park-call.js'")).toBe(true)
    expect(IMPORTS.test(' * `parkTreeIndexed(ST, opId, …)` through the reporter')).toBe(false)
  })
})
