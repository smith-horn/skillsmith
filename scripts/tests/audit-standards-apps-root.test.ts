/**
 * SMI-5603: Check 2 (Type Safety — no 'any') and Check 3 (File Length — max
 * 500 lines) now scan BOTH `packages/` and `apps/` (e.g. `apps/api-proxy`).
 * Previously both checks were hardcoded to
 * `getFilesRecursive('packages', ['.ts', '.tsx'])`, so `apps/` received zero
 * standards coverage — a long or `any`-typed file under `apps/` would never
 * be flagged.
 *
 * `getFilesRecursive()` and the Check 2/3 bodies are defined inline in
 * scripts/audit-standards.mjs and are not exported — the script runs its
 * full check suite as a side effect of being imported/executed (it also
 * calls `parseArgs()` against `process.argv` at module load time), so it
 * cannot be safely imported directly from a test process. Following the
 * existing convention for testing non-exported in-script logic (see the
 * `NON_SOURCE_PREFIXES` re-implementation in audit-standards.test.ts), this
 * file re-implements the small file-walker plus the Check 2/3 predicates
 * verbatim and exercises them against real fixture directories built with
 * `makeFixtureTempDir`. Keep the re-implementation in sync with
 * scripts/audit-standards.mjs (`getFilesRecursive`, `TYPE_SAFETY_AND_LENGTH_ROOTS`,
 * and the Check 2 / Check 3 bodies).
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { makeFixtureTempDir } from './_lib/git-fixture-env.js'

// Verbatim mirror of getFilesRecursive() in scripts/audit-standards.mjs.
function getFilesRecursive(dir: string, extensions: string[]): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files

  const items = readdirSync(dir)
  for (const item of items) {
    const fullPath = join(dir, item)
    if (item === 'node_modules' || item === 'dist' || item === '.git') continue

    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...getFilesRecursive(fullPath, extensions))
    } else if (extensions.some((ext) => item.endsWith(ext))) {
      files.push(fullPath)
    }
  }
  return files
}

// Mirror of TYPE_SAFETY_AND_LENGTH_ROOTS in scripts/audit-standards.mjs.
const TYPE_SAFETY_AND_LENGTH_ROOTS = ['packages', 'apps']

// Mirror of the Check 2 body (the 'any' detector), parameterised on a repo
// root so the test can point it at a fixture directory instead of cwd.
function findAnyTypedFiles(repoRoot: string): string[] {
  const sourceFiles = TYPE_SAFETY_AND_LENGTH_ROOTS.flatMap((root) =>
    getFilesRecursive(join(repoRoot, root), ['.ts', '.tsx'])
  ).filter((f) => !f.includes('.test.') && !f.includes('.d.ts'))

  const filesWithAny = new Set<string>()
  for (const file of sourceFiles) {
    const content = readFileSync(file, 'utf8')
    for (const line of content.split('\n')) {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue
      if (line.match(/:\s*any[^a-zA-Z]|<any>|as\s+any/)) {
        filesWithAny.add(file)
      }
    }
  }
  return [...filesWithAny]
}

// Mirror of the Check 3 body (the file-length detector).
function findLongFiles(repoRoot: string): string[] {
  const sourceFiles = TYPE_SAFETY_AND_LENGTH_ROOTS.flatMap((root) =>
    getFilesRecursive(join(repoRoot, root), ['.ts', '.tsx'])
  ).filter((f) => !f.includes('.test.'))

  const longFiles: string[] = []
  for (const file of sourceFiles) {
    const content = readFileSync(file, 'utf8')
    if (content.split('\n').length > 500) longFiles.push(file)
  }
  return longFiles
}

function longFileBody(lines = 501): string {
  return Array.from({ length: lines }, (_, i) => `// line ${i}`).join('\n')
}

describe('audit-standards Check 2/3: apps/ root coverage (SMI-5603)', () => {
  let tmpRoot: string | null = null

  afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
    tmpRoot = null
  })

  it('flags an any-typed file under apps/ (previously invisible to Check 2)', () => {
    tmpRoot = makeFixtureTempDir('audit-standards-apps-root')
    const appDir = join(tmpRoot, 'apps', 'api-proxy', 'api')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'bad.ts'), `export function f(x: any) {\n  return x as any\n}\n`)

    const flagged = findAnyTypedFiles(tmpRoot)
    expect(flagged).toContain(join(appDir, 'bad.ts'))
  })

  it('flags a >500-line file under apps/ (previously invisible to Check 3)', () => {
    tmpRoot = makeFixtureTempDir('audit-standards-apps-root')
    const appDir = join(tmpRoot, 'apps', 'api-proxy', 'api')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'long.ts'), longFileBody())

    const flagged = findLongFiles(tmpRoot)
    expect(flagged).toContain(join(appDir, 'long.ts'))
  })

  it('does NOT flag a compliant apps/ file (no false positive)', () => {
    tmpRoot = makeFixtureTempDir('audit-standards-apps-root')
    const appDir = join(tmpRoot, 'apps', 'api-proxy', 'api')
    mkdirSync(appDir, { recursive: true })
    // Mirrors the real apps/api-proxy/api/health.ts shape: short, no `any`.
    writeFileSync(
      join(appDir, 'health.ts'),
      `export default function handler(req: unknown, res: { status: (n: number) => void }) {\n` +
        `  res.status(200)\n}\n`
    )

    expect(findAnyTypedFiles(tmpRoot)).not.toContain(join(appDir, 'health.ts'))
    expect(findLongFiles(tmpRoot)).not.toContain(join(appDir, 'health.ts'))
  })

  it('regression: packages/-rooted any-typed and long files are still flagged unchanged', () => {
    tmpRoot = makeFixtureTempDir('audit-standards-apps-root')
    const pkgDir = join(tmpRoot, 'packages', 'core', 'src')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'bad.ts'), `const x: any = 1\n`)
    writeFileSync(join(pkgDir, 'long.ts'), longFileBody())
    writeFileSync(join(pkgDir, 'good.ts'), `export const ok = 1\n`)

    const anyFlagged = findAnyTypedFiles(tmpRoot)
    const longFlagged = findLongFiles(tmpRoot)

    expect(anyFlagged).toContain(join(pkgDir, 'bad.ts'))
    expect(anyFlagged).not.toContain(join(pkgDir, 'good.ts'))
    expect(longFlagged).toContain(join(pkgDir, 'long.ts'))
    expect(longFlagged).not.toContain(join(pkgDir, 'good.ts'))
  })

  it('regression: a repo with only packages/ (no apps/ dir) behaves exactly as before', () => {
    tmpRoot = makeFixtureTempDir('audit-standards-apps-root')
    const pkgDir = join(tmpRoot, 'packages', 'core', 'src')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'good.ts'), `export const ok = 1\n`)
    // No apps/ directory created at all — getFilesRecursive must no-op on it.

    expect(findAnyTypedFiles(tmpRoot)).toEqual([])
    expect(findLongFiles(tmpRoot)).toEqual([])
  })

  it('combines findings from both roots in a single pass (mixed packages/ + apps/ tree)', () => {
    tmpRoot = makeFixtureTempDir('audit-standards-apps-root')
    const pkgDir = join(tmpRoot, 'packages', 'core', 'src')
    const appDir = join(tmpRoot, 'apps', 'api-proxy', 'api')
    mkdirSync(pkgDir, { recursive: true })
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(pkgDir, 'bad.ts'), `const x: any = 1\n`)
    writeFileSync(join(appDir, 'bad.ts'), `const y: any = 2\n`)

    const flagged = findAnyTypedFiles(tmpRoot)
    expect(flagged).toContain(join(pkgDir, 'bad.ts'))
    expect(flagged).toContain(join(appDir, 'bad.ts'))
    expect(flagged.length).toBe(2)
  })
})
