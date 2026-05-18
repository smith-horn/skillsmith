/**
 * SMI-4932: Tests for gen-docs-folder-index.mjs.
 *
 * Pure-function tests against temp-dir fixtures — never the live docs/internal/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// @ts-expect-error -- plain ESM module, no .d.ts
import {
  listFolders,
  countMd,
  hasIndex,
  buildRows,
  spliceBlock,
  diffRows,
} from '../gen-docs-folder-index.mjs'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gen-docs-folder-index-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Create `<root>/<name>/` and populate it with the given file names. */
function folder(name: string, files: string[]): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const f of files) writeFileSync(join(dir, f), '')
  return dir
}

describe('countMd', () => {
  it('counts only direct-child *.md files, including index.md', () => {
    const dir = folder('adr', ['index.md', '001.md', '002.md', 'notes.txt'])
    expect(countMd(dir)).toBe(3)
  })

  it('returns 0 for a folder with no *.md files', () => {
    const dir = folder('backups', ['dump.sql', 'image.png'])
    expect(countMd(dir)).toBe(0)
  })

  it('does not recurse into nested subdirectories', () => {
    const dir = folder('parent', ['a.md'])
    mkdirSync(join(dir, 'nested'))
    writeFileSync(join(dir, 'nested', 'b.md'), '')
    expect(countMd(dir)).toBe(1)
  })
})

describe('hasIndex', () => {
  it('is true when index.md exists', () => {
    expect(hasIndex(folder('withindex', ['index.md', 'x.md']))).toBe(true)
  })

  it('is false when index.md is absent', () => {
    expect(hasIndex(folder('noindex', ['x.md']))).toBe(false)
  })
})

describe('listFolders', () => {
  it('returns direct subdirectories sorted, excluding dot-dirs', () => {
    folder('zeta', [])
    folder('alpha', [])
    folder('.hidden', [])
    writeFileSync(join(root, 'loose.md'), '')
    expect(listFolders(root)).toEqual(['alpha', 'zeta'])
  })
})

describe('buildRows', () => {
  it('emits one row per folder, with the ✓ marker only when index.md exists', () => {
    folder('adr', ['index.md', '001.md'])
    folder('bugs', ['report.md'])
    expect(buildRows(root)).toEqual(['| adr | 2 | ✓ |', '| bugs | 1 | |'])
  })

  it('row count equals listFolders count (the <summary>All folders</summary> claim)', () => {
    folder('a', ['x.md'])
    folder('b', [])
    folder('c', ['index.md'])
    expect(buildRows(root)).toHaveLength(listFolders(root).length)
  })
})

const SAMPLE = `# Docs

## Folder Reference

<details>
<summary>All folders (click to expand)</summary>

| Folder | Files | Has Index |
|--------|-------|-----------|
| adr | 5 | ✓ |
| old | 2 | |

</details>

---

**Last updated**: 2026-01-01
`

describe('spliceBlock', () => {
  it('replaces only the data rows, preserving the wrapper and stamp', () => {
    const out = spliceBlock(SAMPLE, ['| adr | 9 | ✓ |'])
    expect(out).toContain('| adr | 9 | ✓ |')
    expect(out).not.toContain('| old | 2 | |')
    expect(out).toContain('<details>')
    expect(out).toContain('<summary>All folders (click to expand)</summary>')
    expect(out).toContain('</details>')
    expect(out).toContain('**Last updated**: 2026-01-01')
  })

  it('is idempotent — splicing the same rows twice yields identical text', () => {
    const rows = ['| adr | 5 | ✓ |', '| old | 2 | |']
    const once = spliceBlock(SAMPLE, rows)
    expect(spliceBlock(once, rows)).toBe(once)
  })

  it('throws (fail-closed) when the table header anchor is absent', () => {
    expect(() => spliceBlock('# Docs\n\nno table here\n', [])).toThrow(/Anchor not found/)
  })

  it('throws (fail-closed) when the separator row is missing', () => {
    const noSep = '# Docs\n\n| Folder | Files | Has Index |\n| adr | 5 | ✓ |\n'
    expect(() => spliceBlock(noSep, [])).toThrow(/Anchor not found/)
  })
})

describe('diffRows', () => {
  it('reports added, removed, and changed folders', () => {
    const before = ['| adr | 5 | ✓ |', '| old | 2 | |']
    const after = ['| adr | 9 | ✓ |', '| new | 1 | |']
    const lines = diffRows(before, after).join('\n')
    expect(lines).toContain('+ | new | 1 | |')
    expect(lines).toContain('| old | 2 | |')
    expect(lines).toContain('- | adr | 5 | ✓ |')
    expect(lines).toContain('+ | adr | 9 | ✓ |')
  })

  it('returns no lines when committed and expected match', () => {
    const rows = ['| adr | 5 | ✓ |']
    expect(diffRows(rows, rows)).toEqual([])
  })
})
