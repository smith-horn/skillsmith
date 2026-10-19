/**
 * SMI-6676 (A1 plan T-A, §3.2): the `acquireOwnedLock` allow-list.
 *
 * Outside the owned-lock modules themselves, only config-atomic-write.ts,
 * security-acceptance.mutate.ts and file-lock.ts may import acquireOwnedLock.
 * This test walks every non-test .ts file under packages/*\/src, detects
 * which ones reference the name, and asserts that set equals the allow-list.
 *
 * "Reference" means a static import or re-export naming it (plain, `type`,
 * aliased, multi-line, or default-plus-braces), a dynamic import destructured
 * to it, `(await import(...)).acquireOwnedLock`, or a declaration of it.
 * owned-lock.ts is the only declaring module, so it is the owned-lock entry.
 * owned-lock.acquire.ts and owned-lock.types.ts neither import nor declare the
 * name, so they cannot appear in the set.
 *
 * Comments and string literals are blanked before matching, so a mention in a
 * comment or a string is not a use. Positive and negative controls run the
 * same detector over in-memory source.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// This file sits in packages/core/tests/unit/config/, so five `..` reach the root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../')

const EXPECTED_IMPORTERS = [
  'packages/core/src/config/config-atomic-write.ts',
  'packages/core/src/config/file-lock.ts',
  'packages/mcp-server/src/audit/security-acceptance.mutate.ts',
  'packages/core/src/config/owned-lock.ts',
].sort()

/**
 * Replaces the contents of comments and string literals with spaces, keeping
 * newlines and quote characters. The output has the same length as the input.
 */
export function blankCommentsAndStrings(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' '
        i++
      }
    } else if (c === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) {
        out += '  '
        i += 2
      }
    } else if (c === '"' || c === "'" || c === '`') {
      out += c
      i++
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') {
          out += '  '
          i += 2
          continue
        }
        // Single and double quoted strings cannot span a newline.
        if (src[i] === '\n' && c !== '`') break
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n && src[i] === c) {
        out += c
        i++
      }
    } else {
      out += c
      i++
    }
  }
  return out
}

// Matches `acquireOwnedLock`, `acquireOwnedLock as x`, and `acquireOwnedLock: x`
// (the rename form used in a destructuring pattern). Rejects longer names such
// as `acquireOwnedLockCore`.
const NAME_ITEM = /^acquireOwnedLock(?:\s*(?::|as)\s*[\w$]+)?$/

function braceListNamesAcquire(body: string): boolean {
  return body.split(',').some((item) => NAME_ITEM.test(item.trim().replace(/^type\s+/, '')))
}

export function usesAcquireOwnedLock(source: string): boolean {
  const code = blankCommentsAndStrings(source)

  // import {…} from / export {…} from, with optional `type` and an optional default binding.
  const staticRe = /\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\b/g
  for (const m of code.matchAll(staticRe)) {
    if (braceListNamesAcquire(m[1])) return true
  }

  // const { acquireOwnedLock } = await import(…)
  const dynamicRe = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\s*\(/g
  for (const m of code.matchAll(dynamicRe)) {
    if (braceListNamesAcquire(m[1])) return true
  }

  // (await import(…)).acquireOwnedLock
  if (/\bimport\s*\([^)]*\)\s*\)?\s*\.\s*acquireOwnedLock\b/.test(code)) return true

  // The declaring module.
  if (/\bexport\s+(?:async\s+)?function\s+acquireOwnedLock\s*\(/.test(code)) return true

  return false
}

function collectSourceFiles(dir: string, out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      collectSourceFiles(full, out)
    } else if (ent.isFile() && ent.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(ent.name)) {
      out.push(full)
    }
  }
}

function listPackageSourceFiles(): string[] {
  const packagesDir = path.join(REPO_ROOT, 'packages')
  const files: string[] = []
  for (const pkg of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const src = path.join(packagesDir, pkg.name, 'src')
    if (fs.existsSync(src)) collectSourceFiles(src, files)
  }
  return files
}

function toRepoRelative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/')
}

describe('acquireOwnedLock allow-list (SMI-6676 T-A)', () => {
  it('detector: positive controls are detected', () => {
    const positives: Array<[string, string]> = [
      ['single-line import', "import { acquireOwnedLock } from './owned-lock.js'"],
      [
        'multi-line import',
        "import {\n  StuckLockError,\n  acquireOwnedLock,\n  type StuckLockReason,\n} from './owned-lock.js'",
      ],
      ['aliased import', "import { acquireOwnedLock as acq } from './owned-lock.js'"],
      ['type-only import', "import type { acquireOwnedLock } from './owned-lock.js'"],
      ['default plus braces', "import Lock, { acquireOwnedLock } from './owned-lock.js'"],
      ['export-from', "export { acquireOwnedLock } from './owned-lock.js'"],
      ['dynamic destructuring', "const { acquireOwnedLock } = await import('./owned-lock.js')"],
      ['member access on dynamic import', "(await import('./owned-lock.js')).acquireOwnedLock(p)"],
      ['declaration', 'export function acquireOwnedLock(target: string): () => void {}'],
    ]
    for (const [label, src] of positives) {
      expect(usesAcquireOwnedLock(src), label).toBe(true)
    }
  })

  it('detector: comment mentions, string literals and longer names are not detected', () => {
    const negatives: Array<[string, string]> = [
      ['line comment', "// import { acquireOwnedLock } from './owned-lock.js'"],
      ['block comment', "/* import { acquireOwnedLock } from './owned-lock.js' */"],
      ['double-quoted string', `const s = "import { acquireOwnedLock } from 'x'"`],
      ['template literal', 'const s = `import { acquireOwnedLock } from "x"`'],
      ['longer identifier', "import { acquireOwnedLockCore } from './owned-lock.acquire.js'"],
      ['unrelated import', "import { acquireOwnedLockDoctor } from './other.js'"],
    ]
    for (const [label, src] of negatives) {
      expect(usesAcquireOwnedLock(src), label).toBe(false)
    }
  })

  it('walk: scans more than 500 files, so an empty or wrong root cannot pass', () => {
    const files = listPackageSourceFiles()
    expect(files.length).toBeGreaterThan(500)
  })

  it('importers equal the allow-list, with the consumers and the owned-lock declaration', () => {
    const importers = listPackageSourceFiles()
      .filter((f) => usesAcquireOwnedLock(fs.readFileSync(f, 'utf8')))
      .map(toRepoRelative)
      .sort()
    expect(importers).toEqual(EXPECTED_IMPORTERS)
  })
})
