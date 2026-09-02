/**
 * Check 65 (SMI-6343 Wave 1) — manifest-hygiene detection helpers.
 *
 * Extracted from audit-standards.mjs so the matching + allowlist logic is unit
 * testable in isolation, following the precedent set by Check 63
 * (audit-export-surface-consumer-helpers.mjs).
 *
 * What it detects: a test file that references a manifest-WRITING symbol
 * without naming its own manifest path. Those symbols all fall back to
 * `path.join(os.homedir(), '.skillsmith', 'manifest.json')` when no explicit
 * path is supplied, so on a host (non-Docker) vitest run they write into the
 * developer's real manifest — the exact leak SMI-6343 was filed for
 * (`test-skill` and `shutdown-persistence-fixture` rows found in a real user's
 * ~/.skillsmith/manifest.json).
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Symbols whose default manifest path is `os.homedir()`-derived.
 * `installSkill` and `backfillManifest` are matched as whole words;
 * `ManifestManager` only as a construction (`new ManifestManager`), since a
 * type-only import of the class is not a write.
 */
export const MANIFEST_WRITER_PATTERNS = [
  /\bSkillInstallationService\b/,
  /\binstallSkill\b/,
  /\bbackfillManifest\b/,
  /new\s+ManifestManager\b/,
]

/**
 * Evidence that the file names its own manifest location. Any one exempts.
 *
 * - `manifestPath` — an explicit path passed to the service/manager, or
 *   destructured from `createTestFilesystem()`'s context.
 * - a `$HOME`/`%USERPROFILE%`/`SKILLSMITH_HOME` override — both dot and
 *   bracket `process.env` notation, plus `vi.stubEnv`. Bracket notation is the
 *   dominant form in this repo (`process.env['HOME'] = homeDir`), so a
 *   dot-only pattern silently under-matches by four files.
 * - `createIsolatedManifestPath` — the sanctioned helper
 *   (packages/mcp-server/tests/integration/setup.ts).
 *
 * Deliberately NOT here: `createTestFilesystem`. It hands back an isolated
 * `manifestPath`, but a file that calls it and never wires that path into the
 * writer is still exposed — exempting on the call alone would grant the whole
 * integration suite a free pass.
 */
export const MANIFEST_OVERRIDE_PATTERNS = [
  /\bmanifestPath\b/,
  /process\.env\s*(?:\.\s*(?:HOME|USERPROFILE)\b|\[\s*['"`](?:HOME|USERPROFILE)['"`]\s*\])/,
  /\bSKILLSMITH_HOME\b/,
  /stubEnv\(\s*['"`](?:HOME|USERPROFILE)['"`]/,
  /\bcreateIsolatedManifestPath\b/,
]

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.vercel'])

function walkTestFiles(dir, out) {
  if (!existsSync(dir)) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      walkTestFiles(full, out)
    } else if (ent.isFile() && (ent.name.endsWith('.test.ts') || ent.name.endsWith('.spec.ts'))) {
      out.push(full)
    }
  }
  return out
}

/**
 * Every test location CLAUDE.md declares canonical, scoped to the ones that can
 * reach a manifest writer: `packages/*` /src and /tests, plus the root
 * `tests/` and `scripts/tests/` trees the original scope draft missed.
 * `supabase/functions/**` is out of scope — Deno edge functions have no
 * filesystem manifest.
 */
export function listManifestHygieneTestFiles(cwd = process.cwd()) {
  const roots = []
  const packagesDir = join(cwd, 'packages')
  if (existsSync(packagesDir)) {
    for (const ent of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      roots.push(join(packagesDir, ent.name, 'src'), join(packagesDir, ent.name, 'tests'))
    }
  }
  roots.push(join(cwd, 'tests'), join(cwd, 'scripts', 'tests'))

  const files = []
  for (const root of roots) walkTestFiles(root, files)
  return files.sort()
}

export function referencesManifestWriter(content) {
  return MANIFEST_WRITER_PATTERNS.some((re) => re.test(content))
}

export function hasManifestPathOverride(content) {
  return MANIFEST_OVERRIDE_PATTERNS.some((re) => re.test(content))
}

/**
 * Pure evaluation over already-read files, so the negative test can drive it
 * with synthetic content and never touch disk.
 *
 * @param {{ files: Array<{ path: string, content: string }>, allowlist: Iterable<string> }} input
 * @returns {{ findings: string[], staleAllowlistEntries: string[], scanned: number, matched: number }}
 */
export function evaluateManifestHygiene({ files, allowlist }) {
  const allowed = new Set(allowlist)
  const seenAllowlistPaths = new Set()
  const findings = []
  const staleAllowlistEntries = []
  let matched = 0

  for (const { path: relPath, content } of files) {
    const isWriter = referencesManifestWriter(content)
    if (isWriter) matched++
    const exposed = isWriter && !hasManifestPathOverride(content)

    if (allowed.has(relPath)) {
      seenAllowlistPaths.add(relPath)
      // Mirrors Check 62: an allowlist entry that no longer matches is itself
      // a finding. Either the file was fixed (drain the entry) or it moved,
      // and a silently-stale entry can mask a real future regression at that
      // same path.
      if (!exposed) staleAllowlistEntries.push(relPath)
      continue
    }
    if (exposed) findings.push(relPath)
  }

  for (const entry of allowed) {
    if (!seenAllowlistPaths.has(entry)) staleAllowlistEntries.push(entry)
  }

  return { findings, staleAllowlistEntries, scanned: files.length, matched }
}
