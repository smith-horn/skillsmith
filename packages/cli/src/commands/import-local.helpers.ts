/**
 * @fileoverview Helpers for `skillsmith import-local` (SMI-4665)
 *
 * Pulled out of `import-local.ts` to keep the action handler under the
 * 500-line standard and isolate filesystem I/O for unit testing.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, resolve, dirname, basename, sep, relative } from 'node:path'
import matter from 'gray-matter'
import type { LocalSkillRecord } from './import-local.types.js'

const SKILL_FILENAME = 'SKILL.md'
const MAX_DEPTH = 8

/**
 * Compute the deterministic local-skill id from a canonical absolute path.
 * Re-running `import-local` on the same directory produces the same id, so
 * the row upserts in place rather than duplicating.
 */
export function localSkillId(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 32)
}

/**
 * Walk `rootDir` and yield every `SKILL.md` file path. Symlinks are followed
 * via `fs.realpath`, but any link whose realpath escapes `rootDir` is skipped
 * (see SMI-4287 — LocalFilesystemAdapter convention).
 *
 * Returns an array of canonical absolute paths.
 */
export async function walkSkillFiles(
  rootDir: string
): Promise<{ files: string[]; skipped: Array<{ path: string; reason: string }> }> {
  const canonicalRoot = await fs.realpath(rootDir).catch(() => resolve(rootDir))
  const files: string[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  const visited = new Set<string>()

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const entryPath = join(dir, entry.name)

      if (entry.isSymbolicLink()) {
        let realPath: string
        try {
          realPath = await fs.realpath(entryPath)
        } catch {
          continue
        }
        // Refuse symlinks whose target escapes the canonical root. Same
        // policy as LocalFilesystemAdapter (SMI-4287). Authors who need to
        // import skills outside `~/.claude/skills/` can pass an explicit
        // path or `--client agents` instead.
        const rel = relative(canonicalRoot, realPath)
        if (rel.startsWith('..') || rel === '..' || rel.startsWith(`..${sep}`)) {
          skipped.push({ path: entryPath, reason: 'symlink-escapes-root' })
          continue
        }
        if (visited.has(realPath)) continue
        visited.add(realPath)
        const stat = await fs.stat(realPath).catch(() => null)
        if (stat?.isDirectory()) {
          await walk(realPath, depth + 1)
        } else if (stat?.isFile() && basename(realPath) === SKILL_FILENAME) {
          files.push(realPath)
        }
        continue
      }

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        await walk(entryPath, depth + 1)
      } else if (entry.isFile() && entry.name === SKILL_FILENAME) {
        try {
          const real = await fs.realpath(entryPath)
          files.push(real)
        } catch {
          files.push(entryPath)
        }
      }
    }
  }

  await walk(canonicalRoot, 0)
  return { files, skipped }
}

/**
 * Parse the YAML frontmatter of a SKILL.md file. Returns a partial record;
 * malformed frontmatter is reported via the `error` field rather than thrown
 * so a single broken file does not abort the whole import.
 */
export async function parseSkillFile(filePath: string): Promise<LocalSkillRecord> {
  const id = localSkillId(filePath)
  const fallbackName = basename(dirname(filePath))

  let content: string
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    return {
      id,
      path: filePath,
      name: fallbackName,
      description: null,
      triggers: [],
      tags: [],
      error: `read-failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  let parsed: ReturnType<typeof matter>
  try {
    parsed = matter(content)
  } catch (error) {
    return {
      id,
      path: filePath,
      name: fallbackName,
      description: null,
      triggers: [],
      tags: [],
      error: `frontmatter-parse-failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const data = (parsed.data ?? {}) as Record<string, unknown>
  const name =
    typeof data['name'] === 'string' && data['name'].length > 0
      ? (data['name'] as string)
      : fallbackName

  let description: string | null = null
  if (typeof data['description'] === 'string') {
    description = data['description']
  } else {
    // Fall back to the first non-blank, non-heading paragraph in the body.
    for (const line of parsed.content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('#')) continue
      description = trimmed
      break
    }
  }

  const triggers = toStringArray(data['triggers'])
  const tags = toStringArray(data['tags'])

  return { id, path: filePath, name, description, triggers, tags }
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}
