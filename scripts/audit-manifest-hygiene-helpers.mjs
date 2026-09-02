/**
 * Check 65 (SMI-6343 Wave 1) — manifest-hygiene detection helpers.
 *
 * Extracted from audit-standards.mjs so the matching + allowlist logic is unit
 * testable in isolation, following the precedent set by Check 63
 * (audit-export-surface-consumer-helpers.mjs).
 *
 * What it detects: a test file that references a manifest-WRITING symbol
 * without naming its own manifest path. Those symbols all fall back to
 * `path.join(os.homedir(), '.skillsmith', 'manifest.json')` (or the sibling
 * `links/manifest.json` path in fan-out.ts) when no explicit path is
 * supplied, so on a host (non-Docker) vitest run they write into the
 * developer's real manifest — the class of leak SMI-6343 was filed for
 * (`test-skill` and `shutdown-persistence-fixture` rows found in a real
 * user's ~/.skillsmith/manifest.json; residual evidence of a leak that
 * predates ADR-139/SMI-6274 Wave 4's unrelated `manifestPath` wiring for
 * those two specific files, per `scripts/tests/audit-manifest-hygiene.test.ts`'s
 * header for the full timeline).
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Symbols whose default manifest path is `os.homedir()`-derived.
 * `installSkill` and `backfillManifest` are matched as whole words;
 * `ManifestManager` only as a construction (`new ManifestManager`), since a
 * type-only import of the class is not a write.
 *
 * Adversarial-review follow-up (SMI-6343): `SkillInstallationService` /
 * `ManifestManager` are NOT the only homedir-defaulting manifest writers.
 * Three sibling implementations exist, each with the same shape (raw `fs`,
 * `os.homedir()`-derived path, no override parameter) and none of them
 * previously appeared in this list:
 *   - `packages/mcp-server/src/tools/install.helpers.manifest.ts` —
 *     `updateManifestSafely`, `saveManifest`, `acquireManifestLock`
 *   - `packages/cli/src/utils/manifest.ts` — `saveManifest`,
 *     `updateManifestEntry`
 *   - `packages/core/src/install/fan-out.ts` — `saveManifest`, `addLink`,
 *     `removeLinks` (the higher-level API a test actually calls; `addLink`/
 *     `removeLinks` write through `saveManifest()` internally without the
 *     literal string "saveManifest" necessarily appearing in the test file)
 * All four are now runtime-guarded (`assertNotRealUserHome`, exported from
 * `@skillsmith/core`), so this list is defense-in-depth on top of that fix,
 * not the only thing standing between a new test and a repeat leak.
 */
export const MANIFEST_WRITER_PATTERNS = [
  /\bSkillInstallationService\b/,
  /\binstallSkill\b/,
  /\bbackfillManifest\b/,
  /new\s+ManifestManager\b/,
  /\bupdateManifestSafely\b/,
  /\bsaveManifest\b/,
  /\bacquireManifestLock\b/,
  /\bupdateManifestEntry\b/,
  /\baddLink\b/,
  /\bremoveLinks\b/,
]

/**
 * Human-readable labels for `MANIFEST_WRITER_PATTERNS`, in the same order, used
 * to build Check 65's finding message.
 *
 * Kept as a parallel array rather than inlined into the message string because
 * the message ALREADY drifted once: the adversarial-review follow-up grew the
 * pattern list from 4 entries to 10 and left the finding message naming only
 * the original 4, so a test tripped by `saveManifest` would have been told to
 * look for four symbols none of which appear in its file (pr-reviewer PR-12,
 * SMI-6343). `audit-manifest-hygiene.test.ts` asserts the two arrays stay the
 * same length, so the next person to add a pattern cannot repeat that drift.
 */
export const MANIFEST_WRITER_SYMBOLS = [
  'SkillInstallationService',
  'installSkill',
  'backfillManifest',
  'new ManifestManager',
  'updateManifestSafely',
  'saveManifest',
  'acquireManifestLock',
  'updateManifestEntry',
  'addLink',
  'removeLinks',
]

/**
 * Evidence that the file names its own manifest location. Any one exempts.
 *
 * - `manifestPath` — an explicit path passed to the service/manager, in any
 *   of its genuine real-code shapes: a property key or assignment target
 *   (`manifestPath:` / `manifestPath =`), a property access
 *   (`target.manifestPath`, `scopeTarget.manifestPath`), or a bare
 *   identifier used as a call argument (`manifestPath)` / `manifestPath,`).
 *   Adversarial-review follow-up (SMI-6343): the ORIGINAL pattern here was a
 *   bare `\bmanifestPath\b` — a free-floating occurrence anywhere in the file
 *   (a comment, a `// TODO: pass a manifestPath`, an unrelated string)
 *   counted as proof of isolation, which is not evidence of anything. The
 *   first tightening (requiring only a `:`/`=` suffix) went too far the other
 *   way and stopped matching `new ManifestManager(target.manifestPath)` — a
 *   genuine explicit-path construction via property access, caught live by
 *   `packages/core/src/install/workspace-scope.test.ts` going newly (and
 *   wrongly) exposed the moment the tightened pattern shipped. This version
 *   covers all four real syntax shapes while still rejecting the comment
 *   case (nothing in `// TODO: pass a manifestPath here` matches any of
 *   them — "here" starts with neither punctuation nor `.`).
 * - a `$HOME`/`%USERPROFILE%` override — both dot and bracket `process.env`
 *   notation, plus `vi.stubEnv`. Bracket notation is the dominant form in
 *   this repo (`process.env['HOME'] = homeDir`), so a dot-only pattern
 *   silently under-matches by four files.
 * - `createIsolatedManifestPath` — the sanctioned helper
 *   (packages/mcp-server/tests/integration/setup.ts).
 *
 * Deliberately NOT here: `createTestFilesystem`. It hands back an isolated
 * `manifestPath`, but a file that calls it and never wires that path into the
 * writer is still exposed — exempting on the call alone would grant the whole
 * integration suite a free pass.
 *
 * Deliberately REMOVED (adversarial-review follow-up, SMI-6343):
 * `SKILLSMITH_HOME`. `grep -rn "SKILLSMITH_HOME" packages/*\/src
 * packages/*\/tests scripts` returns exactly one hit — this file's own test —
 * no production writer reads it, so crediting it as isolation evidence was
 * false: a test setting it and nothing else is still fully exposed (and, as
 * it happens, still protected only by the global $HOME sandbox, same as
 * every other test).
 */
export const MANIFEST_OVERRIDE_PATTERNS = [
  /\bmanifestPath\s*(?:[:=]|[),.;])|\.manifestPath\b/,
  /process\.env\s*(?:\.\s*(?:HOME|USERPROFILE)\b|\[\s*['"`](?:HOME|USERPROFILE)['"`]\s*\])/,
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
