/**
 * @fileoverview Scan policy for bundled optional files in the skill install path.
 * @module @skillsmith/core/services/skill-installation.policy
 * @see SMI-5422 Phase 1: widen the bundled-file scan corpus
 *
 * Kept in its own module so io.ts and mcp-server/validate.ts can share the
 * policy without coupling to the full install service. The three exports —
 * BUNDLED_SCAN_FILES, classifyBundledFile, extractPackageJsonLifecycleScripts —
 * are the contract; everything else is implementation detail.
 */

/**
 * Per-file scan policy classes for bundled optional install files.
 *
 *   doc          - Routine prose docs that routinely quote attack strings as
 *                  examples (FP control H6). A scan failure is a SILENT SKIP —
 *                  never a hard reject.
 *   config       - Pre-existing skill config (config.json). Hard-reject on scan
 *                  failure (pre-existing behaviour, no change in Phase 1).
 *   structured   - Execution-environment files (.mcp.json, .claude/settings*).
 *                  Hard-reject on scan failure, uniform across ALL trust tiers.
 *   package-json - Only lifecycle-hook script VALUES are scanned, not the whole
 *                  file. Hard-reject if that extracted text fails. A package.json
 *                  with only test/lint scripts or dep ranges is never rejected.
 */
export type BundledFileClass = 'doc' | 'config' | 'structured' | 'package-json'

/**
 * Widened fixed-name file list for the install corpus (SMI-5422 Phase 1).
 *
 * The install path fetches each file by exact path via fetchFromGitHub — there
 * is NO directory globbing. Files like scripts/*.sh are OUT of scope for Phase 1
 * and are noted as a Phase 3 follow-up (directory-glob scanning).
 */
export const BUNDLED_SCAN_FILES = [
  'README.md',
  'examples.md',
  'config.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp.json',
  'package.json',
] as const

/** Union type of every file name in the bundled scan corpus. */
export type BundledScanFile = (typeof BUNDLED_SCAN_FILES)[number]

/**
 * Filename-to-class map for O(1) lookup.
 *
 * Design note: any name in BUNDLED_SCAN_FILES that lacks an entry here
 * will fall through to the 'structured' default in classifyBundledFile —
 * intentionally conservative so a future addition is hard-reject by default
 * rather than silently skipped.
 */
const FILE_CLASS_MAP: Record<string, BundledFileClass> = {
  'README.md': 'doc',
  'examples.md': 'doc',
  'config.json': 'config',
  '.claude/settings.json': 'structured',
  '.claude/settings.local.json': 'structured',
  '.mcp.json': 'structured',
  'package.json': 'package-json',
}

/**
 * Return the scan-policy class for a bundled optional file.
 *
 * Unknown names fall back to 'structured' (hard-reject) so that a file added
 * to BUNDLED_SCAN_FILES without a corresponding FILE_CLASS_MAP entry defaults
 * to the conservative posture rather than silently skipped.
 */
export function classifyBundledFile(filename: string): BundledFileClass {
  return FILE_CLASS_MAP[filename] ?? 'structured'
}

/**
 * npm lifecycle hook keys that run automatically during `npm install`.
 *
 * We scan ONLY the VALUES of these keys — not the whole package.json —
 * to avoid false positives from dependency names, semver ranges, and HTTP
 * URLs in other script fields (test, lint, format, etc.).
 */
const PKG_LIFECYCLE_KEYS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'postpublish',
] as const

/**
 * Extract lifecycle-hook script values from raw package.json content.
 *
 * Returns a newline-joined string of all present lifecycle hook values, or ''
 * when the file is malformed JSON or contains no lifecycle keys at all.
 *
 * An empty return means "no install-time execution risk" — the caller should
 * write the file without scanning it. A package.json with only `scripts.test`,
 * `scripts.lint`, dependency version ranges, or metadata fields will always
 * produce '' here and is NEVER rejected.
 *
 * On JSON parse error: returns '' (silent skip). It is not the scanner's job
 * to reject a malformed package.json — the npm toolchain handles that. A
 * corrupt or non-JSON file simply contributes no risky text to scan.
 */
export function extractPackageJsonLifecycleScripts(content: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return ''
  }
  if (typeof parsed !== 'object' || parsed === null) return ''

  const scripts = (parsed as Record<string, unknown>).scripts
  if (typeof scripts !== 'object' || scripts === null) return ''

  const values: string[] = []
  for (const key of PKG_LIFECYCLE_KEYS) {
    const val = (scripts as Record<string, unknown>)[key]
    if (typeof val === 'string' && val.length > 0) {
      values.push(val)
    }
  }
  return values.join('\n')
}

/**
 * SMI-5422 Phase 1: should a hard-reject-class file (config/structured/package-
 * json) reject given its scan report?
 *
 * Rejects when the scan fails the standard gate (a high/critical finding OR
 * score ≥ threshold) OR contains ANY `code_execution` / `obfuscated_directive`
 * finding regardless of severity. Those two top-tier categories mean "remote
 * fetch-and-execute" / "concealed directive". A lone such match scores only
 * MEDIUM under the scanner's deliberate SKILL.md prose-FP-avoidance model — but
 * inside a config / hook / lifecycle file there is no documentation-context
 * excuse, so it must reject (this is the CVE-2025-59536 hook-execution threat).
 *
 * FP-safe: legit build commands (tsc, vitest, node-gyp rebuild, `rm -rf` of a
 * cache dir) and the canonical `.mcp.json` shape (`{command:"node",args:[…]}`)
 * do NOT match `code_execution` — it requires curl|wget piped to a shell with a
 * real URL/domain target — so normal lifecycle scripts and server specs pass.
 *
 * KNOWN DETECTION GAPS (inherited from the scanner patterns, tracked in SMI-5424
 * — these are scanner-pattern + edge-twin changes, out of scope for Phase 1's
 * install plumbing): `&&`/`;`-chained or redirect-then-exec download+execute
 * (`curl URL -o /tmp/s && bash /tmp/s`), `npx --yes <pkg>`, `fish`/`bun`/`deno`
 * interpreter sinks, and JSON `\uXXXX`-escaped commands inside raw-scanned
 * STRUCTURED files (.mcp.json / .claude/settings.json are scanned as raw text;
 * package.json lifecycle values are JSON-parsed first, so they are escape-safe).
 * Phase 1 catches what the scanner patterns detect across MORE files; it does
 * not change the patterns.
 *
 * Typed structurally (not against ScanReport) to keep this policy module free of
 * the scanner type graph.
 */
export function isRejectableScan(report: {
  passed: boolean
  findings: ReadonlyArray<{ type: string }>
}): boolean {
  if (!report.passed) return true
  return report.findings.some(
    (f) => f.type === 'code_execution' || f.type === 'obfuscated_directive'
  )
}
