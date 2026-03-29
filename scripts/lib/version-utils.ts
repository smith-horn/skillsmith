/**
 * Version Utilities
 * Shared types and functions for release automation scripts.
 */

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = join(__dirname, '..', '..')

// --- Types ---

export interface PackageSpec {
  name: string
  shortName: string
  dir: string
  packageJsonPath: string
  versionConstFile?: string
  versionConstPattern?: RegExp
  versionConstReplacement?: (v: string) => string
  serverJsonPath?: string
}

export interface ChangelogEntry {
  type: string
  scope?: string
  message: string
  hash: string
  pr?: string
  breaking: boolean
}

// --- Package Definitions ---

export const PACKAGE_SPECS: PackageSpec[] = [
  {
    name: '@skillsmith/core',
    shortName: 'core',
    dir: 'packages/core',
    packageJsonPath: 'packages/core/package.json',
    versionConstFile: 'packages/core/src/index.ts',
    versionConstPattern: /export const VERSION = '[^']+'/,
    versionConstReplacement: (v: string) => `export const VERSION = '${v}'`,
  },
  {
    name: '@skillsmith/mcp-server',
    shortName: 'mcp-server',
    dir: 'packages/mcp-server',
    packageJsonPath: 'packages/mcp-server/package.json',
    versionConstFile: 'packages/mcp-server/src/index.ts',
    versionConstPattern: /const PACKAGE_VERSION = '[^']+'/,
    versionConstReplacement: (v: string) => `const PACKAGE_VERSION = '${v}'`,
    serverJsonPath: 'packages/mcp-server/server.json',
  },
  {
    name: '@skillsmith/cli',
    shortName: 'cli',
    dir: 'packages/cli',
    packageJsonPath: 'packages/cli/package.json',
  },
  {
    name: 'skillsmith-vscode',
    shortName: 'vscode',
    dir: 'packages/vscode-extension',
    packageJsonPath: 'packages/vscode-extension/package.json',
  },
]

// Packages that depend on @skillsmith/core (dep gets updated when core bumps)
export const CORE_DEPENDENTS = [
  'packages/mcp-server/package.json',
  'packages/cli/package.json',
  'packages/enterprise/package.json',
]

// --- Version Arithmetic ---

export function incrementVersion(current: string, type: 'patch' | 'minor' | 'major'): string {
  const parts = current.split('.')
  if (parts.length !== 3) {
    throw new Error(`Invalid semver: ${current}`)
  }
  const [major, minor, patch] = parts.map(Number)
  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    throw new Error(`Invalid semver: ${current}`)
  }
  switch (type) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
  }
}

export function isValidSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version)
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

// --- File Readers ---

export function readPackageVersion(relPath: string): string {
  const fullPath = join(ROOT_DIR, relPath)
  const pkg = JSON.parse(readFileSync(fullPath, 'utf-8'))
  return pkg.version
}

export function readVersionConstant(relPath: string, pattern: RegExp): string | null {
  const fullPath = join(ROOT_DIR, relPath)
  const content = readFileSync(fullPath, 'utf-8')
  const match = content.match(pattern)
  if (!match) return null
  // Extract version from the matched string (between quotes)
  const versionMatch = match[0].match(/'([^']+)'/)
  return versionMatch ? versionMatch[1] : null
}

// --- Git / Changelog ---

export function parseConventionalCommit(message: string): ChangelogEntry {
  // Match: type(scope): description (#PR)
  const conventionalMatch = message.match(
    /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+?)(?:\s*\(#(\d+)\))?$/
  )

  if (conventionalMatch) {
    return {
      type: conventionalMatch[1],
      scope: conventionalMatch[2] || undefined,
      breaking: conventionalMatch[3] === '!',
      message: conventionalMatch[4],
      hash: '',
      pr: conventionalMatch[5] || undefined,
    }
  }

  // Non-conventional: treat as "other"
  const prMatch = message.match(/\(#(\d+)\)$/)
  return {
    type: 'other',
    message: message.replace(/\s*\(#\d+\)$/, ''),
    hash: '',
    breaking: false,
    pr: prMatch ? prMatch[1] : undefined,
  }
}

export function getCommitsSince(since: string, packageDir?: string): ChangelogEntry[] {
  const args = ['log', '--oneline', '--format=%H|%s', `${since}..HEAD`]
  if (packageDir) {
    args.push('--', packageDir)
  }

  let output: string
  try {
    output = execFileSync('git', args, {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return []
  }

  if (!output) return []

  return output.split('\n').map((line) => {
    const [hash, ...messageParts] = line.split('|')
    const message = messageParts.join('|')
    const entry = parseConventionalCommit(message)
    entry.hash = hash.slice(0, 7)
    return entry
  })
}

const TYPE_LABELS: Record<string, string> = {
  feat: 'Feature',
  fix: 'Fix',
  perf: 'Performance',
  refactor: 'Refactor',
  docs: 'Docs',
  test: 'Test',
  chore: 'Chore',
  ci: 'CI',
  other: 'Other',
}

export function formatChangelogSection(version: string, entries: ChangelogEntry[]): string {
  // Filter out pure chore/ci/docs commits for changelog
  const meaningful = entries.filter((e) => !['chore', 'ci', 'docs', 'test'].includes(e.type))
  const toFormat = meaningful.length > 0 ? meaningful : entries

  const lines: string[] = [`## v${version}`, '']
  for (const entry of toFormat) {
    const label = TYPE_LABELS[entry.type] || 'Other'
    const pr = entry.pr ? ` (#${entry.pr})` : ''
    lines.push(`- **${label}**: ${entry.message}${pr}`)
  }
  return lines.join('\n')
}
