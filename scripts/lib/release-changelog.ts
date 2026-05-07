/**
 * Changelog helpers extracted from prepare-release.ts (SMI-4783).
 */

import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import { ROOT_DIR } from './version-utils.js'

export function findLastVersionBumpCommit(): string {
  try {
    const output = execFileSync('git', ['log', '--oneline', '--format=%H %s', '-50'], {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()

    for (const line of output.split('\n')) {
      const [hash, ...rest] = line.split(' ')
      const msg = rest.join(' ')
      if (
        msg.startsWith('chore(release):') ||
        msg.startsWith('chore: bump version') ||
        /^chore:.*bump.*\d+\.\d+\.\d+/.test(msg)
      ) {
        return hash
      }
    }
    return 'HEAD~20'
  } catch {
    return 'HEAD~20'
  }
}

export function prependToChangelog(relPath: string, section: string): void {
  const fullPath = join(ROOT_DIR, relPath)
  let content: string
  if (existsSync(fullPath)) {
    content = readFileSync(fullPath, 'utf-8')
  } else {
    content = `# Changelog\n\nAll notable changes to this package are documented here.\n`
  }

  // Insert after the header (first line starting with #)
  const headerEnd = content.indexOf('\n## ')
  if (headerEnd !== -1) {
    content = content.slice(0, headerEnd) + '\n' + section + '\n' + content.slice(headerEnd)
  } else {
    content = content.trimEnd() + '\n\n' + section + '\n'
  }

  writeFileSync(fullPath, content)
}
