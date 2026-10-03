/**
 * @fileoverview I/O helpers for SkillInstallationService (GitHub fetch, file writes)
 * @module @skillsmith/core/services/skill-installation.io
 * @see SMI-4745: domain-driven split to stay under the 500-line CI gate
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { SecurityScanner } from '../security/index.js'
import type { ScannerOptions, ScanReport } from '../security/index.js'
import { validateOptionalConfig } from './skill-installation.validate.js'
import {
  BUNDLED_SCAN_FILES,
  classifyBundledFile,
  extractPackageJsonLifecycleScripts,
  isRejectableScan,
} from './skill-installation.policy.js'

// SMI-6529 Wave A0 round 2: writeInstallFiles() + WriteInstallResult moved to
// a sibling module (pure move, no behavior change to it) to keep this file
// under the 500-line CI gate once the M4/M7/M10/L14/L15 fixes landed —
// re-exported here so every existing `from './skill-installation.io.js'`
// import site is unaffected.
export { writeInstallFiles, type WriteInstallResult } from './skill-installation.io.write.js'

export function assertNotEncrypted(content: string, filePath: string): void {
  if (content.startsWith('\x00GITCRYPT')) {
    throw new Error(
      'File "' +
        filePath +
        '" is git-crypt encrypted. The repository uses git-crypt and this file cannot be fetched from GitHub.'
    )
  }
}

/**
 * SMI-5582: per-request timeout for raw.githubusercontent.com fetches.
 *
 * This is THE critical-path GitHub fetch for a registry install: it is reached
 * from `SkillInstallationService.install()` (SKILL.md) and from
 * `fetchAndScanOptionalFiles` (up to 7 optional files), each with a possible
 * `main`→`master` fallback — i.e. up to ~16 sequential network calls per
 * skill. Before SMI-5582 none of them were bounded, so a single hung GitHub
 * socket could stall the caller indefinitely. Since Tier-1 auto-install now
 * runs this chain at server startup, an unbounded fetch here is what would
 * have hung MCP startup. 10s matches the "generous but finite" budget of the
 * other startup network paths (`version-check.ts` uses 3s for a single npm
 * ping; this is a heavier raw-content fetch, hence the larger bound).
 */
const GITHUB_FETCH_TIMEOUT_MS = 10_000

export async function fetchFromGitHub(
  owner: string,
  repo: string,
  filePath: string,
  branch: string = 'main'
): Promise<string> {
  const url =
    'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + filePath
  const response = await fetch(url, { signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) })

  if (!response.ok) {
    if (branch === 'main') {
      const masterUrl =
        'https://raw.githubusercontent.com/' + owner + '/' + repo + '/master/' + filePath
      const masterResponse = await fetch(masterUrl, {
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      })
      if (!masterResponse.ok) {
        throw new Error('Failed to fetch ' + filePath + ': ' + response.status)
      }
      const masterText = await masterResponse.text()
      assertNotEncrypted(masterText, filePath)
      return masterText
    }
    throw new Error('Failed to fetch ' + filePath + ': ' + response.status)
  }

  const text = await response.text()
  assertNotEncrypted(text, filePath)
  return text
}

// SMI-5828: a raw `mtime > installDate` comparison is flaky by construction —
// `installedAt` is captured via `new Date().toISOString()` moments AFTER the
// skill's files are written to disk, so the two timestamps come from
// independent wall-clock reads (write() syscall vs. a later Date.now()) that
// can be skewed by NTP steps, VM/host clock drift (Docker Desktop), or plain
// sub-millisecond scheduling noise under load — none of which reflect a real
// local edit. A small tolerance absorbs that noise while still catching
// genuine post-install modifications, which in practice trail installation
// by seconds/minutes/hours, not milliseconds. This mirrors the standard
// mitigation used by `make`/`rsync`-style mtime comparisons.
const MODIFICATION_DETECTION_TOLERANCE_MS = 2000

export async function checkForModifications(
  skillPath: string,
  installedAt: string
): Promise<boolean> {
  try {
    const installDate = new Date(installedAt)
    const files = await fs.readdir(skillPath, { withFileTypes: true })

    for (const file of files) {
      if (file.isFile()) {
        const filePath = path.join(skillPath, file.name)
        const stats = await fs.stat(filePath)
        if (stats.mtime.getTime() - installDate.getTime() > MODIFICATION_DETECTION_TOLERANCE_MS) {
          return true
        }
      }
    }
    return false
  } catch {
    return false
  }
}

export interface OptionalInstallFilesResult {
  /** Validation warnings from config.json (surfaced as install tips). */
  configWarnings: string[]
  /**
   * SMI-5359 Gap-1: non-doc optional files whose security scan failed.
   * A non-empty list MUST reject the install BEFORE any file is written.
   */
  failedScans: Array<{ file: string; report: ScanReport }>
  /** Validated optional files to write only AFTER the install gate passes. */
  filesToWrite: Array<{ filename: string; content: string }>
}

/**
 * SMI-5359 Gap-1 / SMI-5422 Phase 1: fetch + scan the optional install files
 * WITHOUT writing them. The caller runs this BEFORE writeInstallFiles, rejects
 * on any `failedScans`, and only then writes `filesToWrite` (so a malicious
 * optional file can never leave a partially-installed skill on disk).
 *
 * Per-file policy (see skill-installation.policy.ts for the authoritative spec):
 *   doc          – scan failure is a silent skip (FP control H6).
 *   config       – hard-reject on scan failure (pre-existing behaviour).
 *   structured   – hard-reject on scan failure, all trust tiers.
 *   package-json – KEY-LEVEL: only lifecycle-hook script values are scanned.
 *                  A package.json with no lifecycle hooks is never rejected.
 *
 * A fetch/404 error is always a silent skip (NOT a scan failure).
 *
 * Phase 3 follow-up: directory-glob scanning (e.g. scripts/*.sh) is out of
 * scope here — fetchFromGitHub fetches by exact path only.
 */
export async function fetchAndScanOptionalFiles(
  owner: string,
  repo: string,
  basePath: string,
  branch: string,
  skillId: string,
  scannerOptions: ScannerOptions | null
): Promise<OptionalInstallFilesResult> {
  const optionalFileScanner = scannerOptions ? new SecurityScanner(scannerOptions) : null
  const configWarnings: string[] = []
  const failedScans: Array<{ file: string; report: ScanReport }> = []
  const filesToWrite: Array<{ filename: string; content: string }> = []
  for (const file of BUNDLED_SCAN_FILES) {
    let content: string
    try {
      content = await fetchFromGitHub(owner, repo, basePath + file, branch)
    } catch {
      // Optional file absent / fetch failed — silent skip (NOT a scan failure).
      continue
    }
    if (optionalFileScanner) {
      const fileClass = classifyBundledFile(file)
      // Determine the text to scan. For package-json, only lifecycle hook values;
      // for everything else, the full file content.
      let textToScan: string | null
      if (fileClass === 'package-json') {
        const lifecycle = extractPackageJsonLifecycleScripts(content)
        // Empty string means no install-time hooks — nothing risky to scan.
        textToScan = lifecycle.length > 0 ? lifecycle : null
      } else {
        textToScan = content
      }
      if (textToScan !== null) {
        const fileScan = optionalFileScanner.scan(skillId + '/' + file, textToScan)
        // Hard-reject classes also reject on a lone code_execution / obfuscated_
        // directive finding (medium severity), which `passed` alone would miss —
        // remote-fetch-execute / concealed directives have no place in a hook
        // or config file (SMI-5422 Phase 1; isRejectableScan is FP-safe).
        if (isRejectableScan(fileScan)) {
          // H6 FP control: prose docs quote attack strings — never hard-reject.
          if (fileClass === 'doc') continue
          // config, structured, and package-json all hard-reject on failure.
          failedScans.push({ file, report: fileScan })
          continue
        }
      }
    }
    if (file === 'config.json') {
      const configCheck = validateOptionalConfig(content)
      if (!configCheck.valid) continue // SMI-3870: skip invalid config
      configWarnings.push(...configCheck.warnings)
    }
    filesToWrite.push({ filename: file, content })
  }
  return { configWarnings, failedScans, filesToWrite }
}
