/**
 * @fileoverview I/O helpers for SkillInstallationService (GitHub fetch, file writes)
 * @module @skillsmith/core/services/skill-installation.io
 * @see SMI-4745: domain-driven split to stay under the 500-line CI gate
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { safeWriteFile } from '../utils/safe-fs.js'
import { SecurityScanner } from '../security/index.js'
import type { ScannerOptions, ScanReport } from '../security/index.js'
import { validateOptionalConfig } from './skill-installation.validate.js'

export function assertNotEncrypted(content: string, filePath: string): void {
  if (content.startsWith('\x00GITCRYPT')) {
    throw new Error(
      'File "' +
        filePath +
        '" is git-crypt encrypted. The repository uses git-crypt and this file cannot be fetched from GitHub.'
    )
  }
}

export async function fetchFromGitHub(
  owner: string,
  repo: string,
  filePath: string,
  branch: string = 'main'
): Promise<string> {
  const url =
    'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + filePath
  const response = await fetch(url)

  if (!response.ok) {
    if (branch === 'main') {
      const masterUrl =
        'https://raw.githubusercontent.com/' + owner + '/' + repo + '/master/' + filePath
      const masterResponse = await fetch(masterUrl)
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
        if (stats.mtime > installDate) {
          return true
        }
      }
    }
    return false
  } catch {
    return false
  }
}

export interface WriteInstallResult {
  writtenFiles: string[]
  subagentPath?: string
}

export async function writeInstallFiles(
  installPath: string,
  skillsDir: string,
  skillName: string,
  finalSkillContent: string,
  subSkillFiles: Array<{ filename: string; content: string }>,
  subagentContent: string | undefined
): Promise<WriteInstallResult> {
  const writtenFiles: string[] = []
  let subagentPath: string | undefined
  try {
    await fs.mkdir(installPath, { recursive: true })
    // SMI-4692: realpath both sides — macOS /var/folders symlinks to /private/var/folders.
    const realInstallPath = await fs.realpath(installPath)
    const expectedPrefix = await fs.realpath(skillsDir).catch(() => path.resolve(skillsDir))
    if (
      !realInstallPath.startsWith(expectedPrefix + path.sep) &&
      realInstallPath !== expectedPrefix
    ) {
      throw new Error('Install path escapes skills directory: ' + installPath)
    }

    const mainSkillPath = path.join(installPath, 'SKILL.md')
    await safeWriteFile(mainSkillPath, finalSkillContent)
    writtenFiles.push(mainSkillPath)
    // Write sub-skills in parallel
    if (subSkillFiles.length > 0) {
      await Promise.all(
        subSkillFiles.map(async (subSkill) => {
          const subPath = path.join(installPath, subSkill.filename)
          await safeWriteFile(subPath, subSkill.content)
          writtenFiles.push(subPath)
        })
      )
    }
    // Write companion subagent if generated
    if (subagentContent) {
      const agentsDir = path.join(os.homedir(), '.claude', 'agents')
      await fs.mkdir(agentsDir, { recursive: true })
      subagentPath = path.join(agentsDir, skillName + '-specialist.md')
      await safeWriteFile(subagentPath, subagentContent)
      writtenFiles.push(subagentPath)
    }
  } catch (writeError) {
    // Rollback on failure. Unlink tracked files first (subagentPath lives OUTSIDE
    // installPath, under ~/.claude/agents). Then recursively remove installPath so
    // an untracked orphan from a mid-batch Promise.all write can't survive — the
    // escape guard above proved installPath is inside skillsDir, so this is safe.
    for (const filePath of writtenFiles) {
      await fs.unlink(filePath).catch(() => {})
    }
    await fs.rm(installPath, { recursive: true, force: true }).catch(() => {})
    throw writeError
  }
  return { writtenFiles, subagentPath }
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
 * Prose-documentation optional files: they routinely quote attack strings as
 * examples, so a scan failure on these is skipped (FP control, H6) rather than
 * rejecting the install. Non-doc optional files (config.json) DO hard-reject.
 */
const DOC_OPTIONAL_FILES = new Set(['README.md', 'examples.md'])

/**
 * SMI-5359 Gap-1: fetch + scan the optional install files WITHOUT writing them.
 * The caller runs this BEFORE writeInstallFiles, rejects on any `failedScans`,
 * and only then writes `filesToWrite` (so a malicious optional file can never
 * leave a partially-installed skill on disk). A fetch/404 error is a silent
 * skip (NOT a scan failure); a config.json that fails scanning IS a rejection.
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
  const optionalFiles = ['README.md', 'examples.md', 'config.json']
  const configWarnings: string[] = []
  const failedScans: Array<{ file: string; report: ScanReport }> = []
  const filesToWrite: Array<{ filename: string; content: string }> = []
  for (const file of optionalFiles) {
    let content: string
    try {
      content = await fetchFromGitHub(owner, repo, basePath + file, branch)
    } catch {
      // Optional file absent / fetch failed — fine to skip (NOT a scan failure).
      continue
    }
    if (optionalFileScanner) {
      const fileScan = optionalFileScanner.scan(skillId + '/' + file, content)
      if (!fileScan.passed) {
        // H6: prose docs quote attack strings — skip, never reject the install.
        if (DOC_OPTIONAL_FILES.has(file)) continue
        failedScans.push({ file, report: fileScan })
        continue
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
