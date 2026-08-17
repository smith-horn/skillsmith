/**
 * @fileoverview Bundled-sibling security scan for the local rescan path (SMI-5422 Phase 2).
 * @module @skillsmith/core/services/bundled-sibling-scan
 *
 * Walks an installed skill's bundle directory and scans its sibling bundled
 * files (`.mcp.json`, `.claude/settings*.json`, `package.json` lifecycle hooks,
 * `config.json`, and executable-code files under `scripts/`/`src/`/`bin/`
 * plus the skill's top level) so `skill_rescan` can
 * quarantine a skill whose MALICIOUS sibling — not its `SKILL.md` — carries the
 * threat (CVE-2025-59536 hook execution, `curl|bash` postinstall, a
 * remote-fetch-execute install script).
 *
 * This is the local-FS rescan analogue of the Phase-1 install/validate helpers —
 * NOT a duplicate. The three callers intentionally differ:
 *   - install:  `skill-installation.io.ts` `fetchAndScanOptionalFiles` (fetch-by-path, no glob)
 *   - validate: mcp-server `validate-bundled-scan.ts` `scanBundledSiblings` (returns ValidationError[])
 *   - rescan (this): directory walk + symlink-safe reads + structured result.
 *
 * DELIBERATE FP-SAFE DIVERGENCE (Phase 2 review B1, verified empirically):
 * install/validate reject via `isRejectableScan` (= `!report.passed` OR a
 * `code_execution`/`obfuscated_directive` finding). The `!report.passed` clause
 * fires on ANY high/critical finding, and sibling files are non-markdown so they
 * get NO documentation-context downgrade — so routine, benign script idioms fire
 * at full severity and would quarantine a working skill:
 *   `chmod 755 ./bin/cli`     => privilege_escalation:critical => !passed
 *   `cp .env.example .env`    => sensitive_path:high           => !passed
 *   `source .env` / `export X=$1` / `cat ~/.ssh/...` => sensitive_path:high
 * For an ALREADY-INSTALLED skill that false positive hides a working skill from
 * local search. So this module drives the quarantine decision SOLELY from
 * `code_execution`/`obfuscated_directive` presence (still catches `curl|bash`).
 * The root cause — privilege_escalation/sensitive_path over-firing in
 * non-markdown execution contexts (which is the SAME latent FP on the install
 * path) — is tracked in SMI-5424; once those patterns are narrowed at the
 * source, all three callers can safely share the broader criterion.
 *
 * INHERITED DETECTION GAPS (FN, tracked SMI-5424): bare-interpreter hook
 * payloads (`node evil.js`, `python evil.py`, `bun`/`deno`), `&&`/`;`-chained
 * fetch-then-exec, `npx`, and JSON `\uXXXX`-escaped commands inside raw-scanned
 * structured files are NOT detected.
 *
 * SMI-6033 Wave 2 (Gap 8) CLOSED PART OF THE PHASE-3 TODO: the glob is no
 * longer `.sh`-only and no longer `scripts/`-only. It now covers every
 * {@link EXECUTABLE_CODE_EXTENSIONS} file at the skill's top level and as a
 * DIRECT child of `scripts/`, `src/` or `bin/` — the same SCOPE, RANKING and
 * COUNT cap the indexer applies registry-side (`scripts/indexer/
 * skill-processor.security.tree.ts`'s `MAX_EXTENDED_SIBLING_FILES = 20`), so
 * a skill scanned locally and the same skill scanned in the registry select
 * the same candidate FILES. The per-file BYTE cap is deliberately NOT
 * unified: {@link MAX_SIBLING_FILE_BYTES} (512 KB) here vs the indexer's
 * `MAX_SIBLING_CONTENT_BYTES` (256 KB, `skill-processor.security.ts`) — a
 * pre-existing divergence this wave did not introduce and did not reconcile
 * (adversarial review, 2026-08-16). A file between 256 KB and 512 KB is
 * therefore scanned locally but `size_cap`-dropped registry-side; harmless
 * (fail-open, surfaced via `scan_coverage_incomplete`/`skippedOversize`, never
 * silent) but worth knowing before assuming the two verdicts always agree.
 * Still deliberately shallow: a fully recursive bundle walk remains out of
 * scope.
 *
 * COUNT-CAP DECOY-PADDING (FN): the fixed bundled files are cap-exempt, but the
 * executable-code glob is capped — an author can name the malicious script to
 * rank last and pad the scanned directories with cap-many benign decoys so it
 * lands in `droppedForCount` and is never scanned. Wave 2's four-tier ranking
 * (SKILL.md-referenced, then entry-point-named, then shallow, then
 * lexicographic) raises the bar — to land past the cap the payload must also
 * be unreferenced from SKILL.md and not entry-point-named, which cuts against
 * it actually being executed — but does not close the gap. Surfaced (never a
 * silent drop), not blocked; a cumulative-resource bound is a follow-up.
 *
 * config.json IS scanned here (only doc-class siblings are skipped), whereas the
 * Phase-1 validate helper (validate-bundled-scan.ts) also skips `config` — rescan
 * is the deliberately stricter superset because it is a quarantine path.
 */

import { join } from 'path'
import type { SecurityFinding, ScanReport } from '../security/scanner/types.js'
// Type-only import: the caller injects a constructed SecurityScanner so this
// module never pulls the @skillsmith/core barrel (which transitively loads
// better-sqlite3) at runtime — keeping it unit-testable without native deps.
import type { SecurityScanner } from '../security/index.js'
import { safeFs, resolveSafeRealpath } from '../sources/LocalFilesystemAdapter.helpers.js'
import {
  BUNDLED_SCAN_FILES,
  classifyBundledFile,
  extractPackageJsonLifecycleScripts,
} from './skill-installation.policy.js'

/**
 * Operational-code extensions scanned by the glob (SMI-6033 Wave 2, Gap 8).
 *
 * Deliberately duplicated from `scripts/indexer/skill-processor.security.tree.ts`
 * rather than shared: that module lives in the Node/Deno indexer trees, which
 * cannot import `@skillsmith/core` (git-crypt boundary + Deno bundling — see
 * that file's twin header). `parity.test.ts` pins the two lists equal, so the
 * duplication cannot drift silently.
 */
export const EXECUTABLE_CODE_EXTENSIONS = [
  '.sh',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.rb',
  '.php',
  '.ps1',
  '.pl',
] as const

/** Directories globbed for operational code, relative to the skill directory. */
export const EXTENDED_SCAN_DIRS = ['scripts', 'src', 'bin'] as const

/** Basenames (extension-stripped, lowercased) that rank as entry points (tier 2). */
export const ENTRY_POINT_BASENAMES = new Set([
  'install',
  'setup',
  'main',
  'index',
  'run',
  'postinstall',
])

/**
 * Max globbed operational-code files scanned per skill (fixed bundled files
 * are exempt).
 *
 * SMI-6033 Wave 2 (Gap 8): narrowed from the previous `.sh`-only cap of 50 to
 * 20, matching `MAX_EXTENDED_SIBLING_FILES` on the indexer side. Intentional
 * behaviour change: the glob now covers ten extensions across four directories
 * instead of one extension across two, so an uncapped-at-50 policy would fetch
 * and scan far more per skill than before. 20 ranked files is the plan's
 * chosen budget on BOTH surfaces, and keeping the two equal is what makes the
 * local and registry verdicts comparable.
 */
export const MAX_EXTENDED_SIBLING_FILES = 20
/** Per-file byte ceiling; larger siblings are skipped (recorded, never silent). */
export const MAX_SIBLING_FILE_BYTES = 512 * 1024

/** Tunable caps for {@link scanLocalBundleSiblings}. */
export interface BundledSiblingScanOptions {
  /** Override {@link MAX_EXTENDED_SIBLING_FILES}. */
  maxExtendedFiles?: number
  /** Override {@link MAX_SIBLING_FILE_BYTES}. */
  maxBytesPerFile?: number
  /**
   * The skill's own `SKILL.md` text, used only for the tier-1 ranking check
   * ("is this file referenced by path from SKILL.md?"). Omitted, tier 1 simply
   * never matches and ranking falls through to tiers 2-4 — never an error.
   */
  primaryContent?: string
}

/**
 * Result of scanning a skill bundle's sibling files. All path fields are
 * relative to the skill directory. `findings` is the full (display) set;
 * `rejectableFindings`/`rejectableFiles` are the quarantine-driving subset.
 */
export interface BundledSiblingScanResult {
  /** All non-doc sibling findings, each tagged with `location = relPath`. */
  findings: SecurityFinding[]
  /** True when any sibling carries a `code_execution`/`obfuscated_directive`. */
  rejectable: boolean
  /** The execution-threat findings that drive quarantine. */
  rejectableFindings: SecurityFinding[]
  /** Relative paths that drove rejection. */
  rejectableFiles: string[]
  /** Relative paths actually scanned. */
  scannedFiles: string[]
  /**
   * Max riskScore across REJECTING sibling reports only (display only; rejection
   * is type-driven so this can be below the threshold). Non-rejecting siblings
   * (e.g. a benign `chmod` that scores high) are excluded so they cannot
   * mis-attribute a quarantine's surfaced score.
   */
  maxSiblingRiskScore: number
  /** Executable-code files beyond the count cap — surfaced, never silently dropped. */
  droppedForCount: string[]
  /** Files skipped for exceeding the byte cap. */
  skippedOversize: string[]
  /** Symlink siblings resolving outside the skill dir (SMI-4287 guard). */
  skippedSymlinkEscape: string[]
}

/**
 * A finding is a quarantine driver only if it is a direct execution threat.
 *
 * SMI-6033 Wave 2 (Gap 8) fix (adversarial review finding, 2026-08-16): for a
 * file from the NEW extended (`scripts/`/`src/`/`bin/`/top-level executable
 * code) surface, `code_execution` only drives rejection at `critical`
 * severity — a bare `medium` code_execution finding (the severity
 * `scanCodeExecution` assigns a lone `curl | bash` by design) must NOT
 * standalone-quarantine an install script that uses the same idiom as
 * rustup/Homebrew/nvm/bun. The original fixed `BUNDLED_SCAN_FILES` keep the
 * unchanged, severity-agnostic rule — those are config/doc formats where a
 * literal `curl | bash` string is inherently anomalous, not a real installer.
 * `obfuscated_directive` remains rejectable at any severity on BOTH surfaces
 * — it is delta-gated against a real decode step and has no legitimate
 * installer-script shape.
 */
function isExecutionThreat(finding: SecurityFinding, isExtended: boolean): boolean {
  if (finding.type === 'obfuscated_directive') return true
  if (finding.type !== 'code_execution') return false
  return isExtended ? finding.severity === 'critical' : true
}

/** True when `path`'s final extension is in {@link EXECUTABLE_CODE_EXTENSIONS}. */
function hasExecutableCodeExtension(path: string): boolean {
  const lower = path.toLowerCase()
  return (EXECUTABLE_CODE_EXTENSIONS as readonly string[]).some((ext) => lower.endsWith(ext))
}

/** Lowercased basename with its final extension removed (`Setup.SH` -> `setup`). */
function entryPointKey(path: string): string {
  const base = (path.split('/').pop() ?? path).toLowerCase()
  const dotIdx = base.lastIndexOf('.')
  return dotIdx > 0 ? base.slice(0, dotIdx) : base
}

/**
 * SMI-6033 Wave 2 (Gap 8): rank operational-code candidates so the count cap
 * keeps the files most likely to actually be executed.
 *
 * Four tiers, in order: (1) referenced literally by path from `SKILL.md`,
 * (2) entry-point basename, (3) shallower path first, (4) lexicographic.
 *
 * DETERMINISM is a required property, not incidental: the same candidate set
 * must always produce the same order. Tier 4 is a TOTAL order over unique
 * relative paths, so the result never depends on `Array.prototype.sort` being
 * stable; and the compare uses raw `<`/`>` rather than `localeCompare`, whose
 * collation is ICU/locale dependent. This mirrors the identical comparator in
 * the indexer's `enumerateExtendedSiblingTargets`, so the two surfaces select
 * the same files in the same order from the same bundle.
 *
 * NOTE: ranking does NOT defeat decoy-padding — see the module header. The
 * dropped names are always surfaced in `droppedForCount` (no silent drop).
 */
export function rankExecutableCodeFiles(
  relPaths: readonly string[],
  primaryContent: string
): string[] {
  return [...relPaths].sort((a, b) => {
    const aRef = primaryContent.includes(a)
    const bRef = primaryContent.includes(b)
    if (aRef !== bRef) return aRef ? -1 : 1
    const aEntry = ENTRY_POINT_BASENAMES.has(entryPointKey(a))
    const bEntry = ENTRY_POINT_BASENAMES.has(entryPointKey(b))
    if (aEntry !== bEntry) return aEntry ? -1 : 1
    const aDepth = a.split('/').length
    const bDepth = b.split('/').length
    if (aDepth !== bDepth) return aDepth - bDepth
    if (a === b) return 0
    return a < b ? -1 : 1
  })
}

/**
 * Collect executable-code candidates: the skill's top level, then direct
 * children of `scripts/`, `src/` and `bin/` — regular files only (symlinked
 * scripts are not followed by the glob). Ranked by
 * {@link rankExecutableCodeFiles} so the cap and `droppedForCount` are
 * reproducible rather than dependent on readdir order.
 */
async function collectExecutableCodeFiles(
  skillDir: string,
  primaryContent: string
): Promise<string[]> {
  const out: string[] = []
  const top = await safeFs.readdir(skillDir)
  if (top.ok) {
    for (const e of top.value) {
      if (e.isFile() && hasExecutableCodeExtension(e.name)) out.push(e.name)
    }
  }
  for (const sub of EXTENDED_SCAN_DIRS) {
    const entries = await safeFs.readdir(join(skillDir, sub))
    if (!entries.ok) continue
    for (const e of entries.value) {
      if (e.isFile() && hasExecutableCodeExtension(e.name)) out.push(`${sub}/${e.name}`)
    }
  }
  return rankExecutableCodeFiles(out, primaryContent)
}

/**
 * Scan a skill bundle's sibling files and return the structured result.
 *
 * Fixed {@link BUNDLED_SCAN_FILES} are always scanned (exempt from the count
 * cap, so a decoy-padding attack on `scripts/` cannot push the primary hook /
 * postinstall surface out of the scan window). The executable-code glob is
 * ranked then capped, and
 * any overflow is reported in `droppedForCount`.
 *
 * Doc-class siblings (`README.md`, `examples.md`) are intentionally NOT scanned:
 * prose routinely quotes attack strings, so they can never drive a quarantine
 * (Phase-1 H6 control). Every read is symlink-safe via `resolveSafeRealpath`
 * (containment to `skillDir`, SMI-4287) and reads the resolved realpath.
 *
 * @param skillDir absolute path to the installed skill's bundle directory
 * @param scanner  a constructed SecurityScanner (injected to keep this module DB-free)
 * @param opts     optional caps
 */
export async function scanLocalBundleSiblings(
  skillDir: string,
  scanner: SecurityScanner,
  opts: BundledSiblingScanOptions = {}
): Promise<BundledSiblingScanResult> {
  const maxExtendedFiles = opts.maxExtendedFiles ?? MAX_EXTENDED_SIBLING_FILES
  const maxBytes = opts.maxBytesPerFile ?? MAX_SIBLING_FILE_BYTES

  const result: BundledSiblingScanResult = {
    findings: [],
    rejectable: false,
    rejectableFindings: [],
    rejectableFiles: [],
    scannedFiles: [],
    maxSiblingRiskScore: 0,
    droppedForCount: [],
    skippedOversize: [],
    skippedSymlinkEscape: [],
  }

  const codeFiles = await collectExecutableCodeFiles(skillDir, opts.primaryContent ?? '')
  result.droppedForCount = codeFiles.slice(maxExtendedFiles)
  const extendedCandidates = codeFiles.slice(0, maxExtendedFiles)
  // Fixed files first (cap-exempt), then the capped, ranked executable-code glob.
  const candidates = [...BUNDLED_SCAN_FILES, ...extendedCandidates]
  // SMI-6033 Wave 2 (Gap 8) fix: which candidates came from the new extended
  // surface, so isExecutionThreat can apply its narrower rule to them without
  // touching BUNDLED_SCAN_FILES's unchanged behavior at all.
  const extendedCandidateSet = new Set<string>(extendedCandidates)

  for (const rel of candidates) {
    const fileClass = classifyBundledFile(rel)
    if (fileClass === 'doc') continue // prose quotes attack strings (H6) — never scanned

    const abs = join(skillDir, rel)
    const resolved = await resolveSafeRealpath(abs, skillDir, {})
    if (!resolved.ok) {
      // not-found = sibling absent (silent skip). symlink-escape = SMI-4287 guard.
      // loop/permission/io = unreadable; skip (the file contributes no signal).
      if (resolved.error.code === 'symlink-escape') result.skippedSymlinkEscape.push(rel)
      continue
    }
    const realPath = resolved.value

    const st = await safeFs.stat(realPath)
    if (!st.ok) continue
    if (st.value.size > maxBytes) {
      result.skippedOversize.push(rel)
      continue
    }

    const read = await safeFs.readFile(realPath)
    if (!read.ok) continue

    let textToScan: string = read.value
    if (fileClass === 'package-json') {
      const lifecycle = extractPackageJsonLifecycleScripts(read.value)
      if (lifecycle.length === 0) continue // no install-time hooks — nothing risky
      textToScan = lifecycle
    }

    // SMI-6033 Wave 2 (Gap 8) fix: extended candidates are real source files,
    // not markdown — see SecurityScanner.scan()'s own header for why the
    // markdown-only indented-code-block heuristic must be disabled for them.
    // BUNDLED_SCAN_FILES keep the default (isMarkdown=true) unchanged.
    const report: ScanReport = scanner.scan(
      `${skillDir}/${rel}`,
      textToScan,
      false,
      !extendedCandidateSet.has(rel)
    )
    result.scannedFiles.push(rel)

    // Fresh objects (no mutation of the report's findings array) tagged with the file.
    const tagged = report.findings.map((f) => ({ ...f, location: rel }))
    result.findings.push(...tagged)

    const drivers = tagged.filter((f) => isExecutionThreat(f, extendedCandidateSet.has(rel)))
    if (drivers.length > 0) {
      result.rejectable = true
      result.rejectableFindings.push(...drivers)
      result.rejectableFiles.push(rel)
      // Only a REJECTING sibling contributes to the surfaced score, so a benign
      // high-scoring sibling cannot mis-attribute the quarantine's riskScore.
      result.maxSiblingRiskScore = Math.max(result.maxSiblingRiskScore, report.riskScore)
    }
  }

  return result
}
