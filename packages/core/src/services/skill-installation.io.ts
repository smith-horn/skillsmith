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
import type { ScannerOptions } from '../security/index.js'
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
    // Rollback on failure
    for (const filePath of writtenFiles) {
      await fs.unlink(filePath).catch(() => {})
    }
    await fs.rmdir(installPath).catch(() => {})
    throw writeError
  }
  return { writtenFiles, subagentPath }
}

export async function fetchOptionalInstallFiles(
  installPath: string,
  owner: string,
  repo: string,
  basePath: string,
  branch: string,
  skillId: string,
  scannerOptions: ScannerOptions | null
): Promise<string[]> {
  const optionalFileScanner = scannerOptions ? new SecurityScanner(scannerOptions) : null
  const optionalFiles = ['README.md', 'examples.md', 'config.json']
  const configWarnings: string[] = []
  for (const file of optionalFiles) {
    try {
      const content = await fetchFromGitHub(owner, repo, basePath + file, branch)
      if (optionalFileScanner) {
        const fileScan = optionalFileScanner.scan(skillId + '/' + file, content)
        if (!fileScan.passed) continue
      }
      if (file === 'config.json') {
        const configCheck = validateOptionalConfig(content)
        if (!configCheck.valid) continue // SMI-3870: skip invalid config
        configWarnings.push(...configCheck.warnings)
      }
      await safeWriteFile(path.join(installPath, file), content)
    } catch {
      // Optional files are fine to skip
    }
  }
  return configWarnings
}
