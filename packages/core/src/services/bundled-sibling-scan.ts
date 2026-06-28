/**
 * @fileoverview Bundled-sibling security scan for the local rescan path (SMI-5422 Phase 2).
 * @module @skillsmith/core/services/bundled-sibling-scan
 *
 * Walks an installed skill's bundle directory and scans its sibling bundled
 * files (`.mcp.json`, `.claude/settings*.json`, `package.json` lifecycle hooks,
 * `config.json`, `scripts/*.sh` + top-level `*.sh`) so `skill_rescan` can
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
 * structured files are NOT detected. `.js`/`.py`/`.mjs`/`.ts` payload files and
 * nested/non-`scripts/` `.sh` are a Phase-3 follow-up (recursive bundle walk).
 * COUNT-CAP DECOY-PADDING (FN): the fixed bundled files are cap-exempt, but the
 * `.sh` glob is capped — an author can name the malicious script to sort last
 * and pad `scripts/` with cap-many benign decoys so it lands in `droppedForCount`
 * and is never scanned. This is surfaced (never a silent drop) but not blocked;
 * a cumulative-resource bound is a Phase-3 follow-up.
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

/** Max `.sh` glob files scanned per skill (fixed bundled files are exempt). */
export const MAX_SIBLING_SH_FILES = 50
/** Per-file byte ceiling; larger siblings are skipped (recorded, never silent). */
export const MAX_SIBLING_FILE_BYTES = 512 * 1024

/** Tunable caps for {@link scanLocalBundleSiblings}. */
export interface BundledSiblingScanOptions {
  /** Override {@link MAX_SIBLING_SH_FILES}. */
  maxShFiles?: number
  /** Override {@link MAX_SIBLING_FILE_BYTES}. */
  maxBytesPerFile?: number
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
  /** `.sh` files beyond the count cap — surfaced, never silently dropped. */
  droppedForCount: string[]
  /** Files skipped for exceeding the byte cap. */
  skippedOversize: string[]
  /** Symlink siblings resolving outside the skill dir (SMI-4287 guard). */
  skippedSymlinkEscape: string[]
}

/** A finding is a quarantine driver only if it is a direct execution threat. */
function isExecutionThreat(finding: SecurityFinding): boolean {
  return finding.type === 'code_execution' || finding.type === 'obfuscated_directive'
}

/**
 * Collect `*.sh` candidates: top-level then `scripts/`, regular files only
 * (symlinked scripts are not followed by the glob — Phase 3). Sorted so the cap
 * and `droppedForCount` are reproducible rather than dependent on readdir order.
 * NOTE: sorting does NOT defeat decoy-padding — an author can name the malicious
 * file to sort last; that residual FN is documented in the module header and the
 * dropped names are always surfaced in `droppedForCount` (no silent drop).
 */
async function collectShFiles(skillDir: string): Promise<string[]> {
  const out: string[] = []
  const top = await safeFs.readdir(skillDir)
  if (top.ok) {
    for (const e of top.value) {
      if (e.isFile() && e.name.endsWith('.sh')) out.push(e.name)
    }
  }
  const scripts = await safeFs.readdir(join(skillDir, 'scripts'))
  if (scripts.ok) {
    for (const e of scripts.value) {
      if (e.isFile() && e.name.endsWith('.sh')) out.push(join('scripts', e.name))
    }
  }
  return out.sort()
}

/**
 * Scan a skill bundle's sibling files and return the structured result.
 *
 * Fixed {@link BUNDLED_SCAN_FILES} are always scanned (exempt from the count
 * cap, so a decoy-padding attack on `scripts/` cannot push the primary hook /
 * postinstall surface out of the scan window). The `.sh` glob is capped and
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
  const maxShFiles = opts.maxShFiles ?? MAX_SIBLING_SH_FILES
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

  const shFiles = await collectShFiles(skillDir)
  result.droppedForCount = shFiles.slice(maxShFiles)
  // Fixed files first (cap-exempt), then the capped, sorted .sh glob.
  const candidates = [...BUNDLED_SCAN_FILES, ...shFiles.slice(0, maxShFiles)]

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

    const report: ScanReport = scanner.scan(`${skillDir}/${rel}`, textToScan)
    result.scannedFiles.push(rel)

    // Fresh objects (no mutation of the report's findings array) tagged with the file.
    const tagged = report.findings.map((f) => ({ ...f, location: rel }))
    result.findings.push(...tagged)

    const drivers = tagged.filter(isExecutionThreat)
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
