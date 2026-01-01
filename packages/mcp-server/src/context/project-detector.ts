/**
 * @fileoverview Project Context Detection for Skill Suggestions
 * @module @skillsmith/mcp-server/context/project-detector
 * @see SMI-912: Project context detection for skill suggestions
 *
 * Analyzes the user's project to detect technologies, frameworks, and tools
 * in use to provide contextual skill recommendations.
 *
 * @example
 * // Detect project context for the current working directory
 * const context = detectProjectContext();
 *
 * // Detect project context for a specific path
 * const context = detectProjectContext('/path/to/project');
 *
 * // Use context for skill suggestions
 * if (context.hasDocker) {
 *   suggestSkill('docker');
 * }
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Detected project context for skill recommendations
 */
export interface ProjectContext {
  /** Whether project uses Docker (Dockerfile or docker-compose) */
  hasDocker: boolean
  /** Whether project is connected to Linear (detected from git config) */
  hasLinear: boolean
  /** Whether project is hosted on GitHub */
  hasGitHub: boolean
  /** Detected test framework (jest, vitest, mocha) */
  testFramework: 'jest' | 'vitest' | 'mocha' | null
  /** Detected API framework (express, fastapi, nextjs) */
  apiFramework: 'express' | 'fastapi' | 'nextjs' | null
  /** Whether project uses native modules (better-sqlite3, sharp, etc.) */
  hasNativeModules: boolean
  /** Detected primary language */
  language: 'typescript' | 'javascript' | 'python' | null
}

/**
 * Detect complete project context from filesystem analysis
 *
 * @param projectPath - Path to the project directory (defaults to cwd)
 * @returns Detected project context
 *
 * @example
 * const context = detectProjectContext('/path/to/project');
 * console.log(context.hasDocker); // true/false
 */
export function detectProjectContext(projectPath: string = process.cwd()): ProjectContext {
  return {
    hasDocker: detectDocker(projectPath),
    hasLinear: detectLinear(projectPath),
    hasGitHub: detectGitHub(projectPath),
    testFramework: detectTestFramework(projectPath),
    apiFramework: detectApiFramework(projectPath),
    hasNativeModules: detectNativeModules(projectPath),
    language: detectLanguage(projectPath),
  }
}

/**
 * Detect Docker usage in project
 *
 * Checks for:
 * - Dockerfile
 * - docker-compose.yml
 * - docker-compose.yaml
 *
 * @param path - Project path to check
 * @returns True if Docker is detected
 */
export function detectDocker(path: string): boolean {
  return (
    existsSync(join(path, 'Dockerfile')) ||
    existsSync(join(path, 'docker-compose.yml')) ||
    existsSync(join(path, 'docker-compose.yaml'))
  )
}

/**
 * Detect Linear integration from git remote config
 *
 * Checks if any git remote references linear.app
 *
 * @param path - Project path to check
 * @returns True if Linear integration is detected
 */
export function detectLinear(path: string): boolean {
  const gitConfig = join(path, '.git', 'config')
  if (!existsSync(gitConfig)) return false

  try {
    const content = readFileSync(gitConfig, 'utf-8')
    return content.includes('linear.app')
  } catch {
    return false
  }
}

/**
 * Detect GitHub hosting from git remote config
 *
 * Checks if any git remote references github.com
 *
 * @param path - Project path to check
 * @returns True if GitHub hosting is detected
 */
export function detectGitHub(path: string): boolean {
  const gitConfig = join(path, '.git', 'config')
  if (!existsSync(gitConfig)) return false

  try {
    const content = readFileSync(gitConfig, 'utf-8')
    return content.includes('github.com')
  } catch {
    return false
  }
}

/**
 * Detect test framework from package.json dependencies
 *
 * Checks for: vitest, jest, mocha (in priority order)
 *
 * @param path - Project path to check
 * @returns Detected test framework or null
 */
export function detectTestFramework(path: string): 'jest' | 'vitest' | 'mocha' | null {
  const pkgPath = join(path, 'package.json')
  if (!existsSync(pkgPath)) return null

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }

    // Check in priority order (vitest is preferred over jest)
    if (deps['vitest']) return 'vitest'
    if (deps['jest']) return 'jest'
    if (deps['mocha']) return 'mocha'
  } catch {
    // JSON parse error or file read error
    return null
  }

  return null
}

/**
 * Detect API framework from package.json or requirements.txt
 *
 * Checks for: next (Next.js), express (Express), fastapi (FastAPI)
 *
 * @param path - Project path to check
 * @returns Detected API framework or null
 */
export function detectApiFramework(path: string): 'express' | 'fastapi' | 'nextjs' | null {
  // Check Node.js frameworks first
  const pkgPath = join(path, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }

      // Check in priority order (Next.js is a more specific framework)
      if (deps['next']) return 'nextjs'
      if (deps['express']) return 'express'
    } catch {
      // JSON parse error
    }
  }

  // Check for FastAPI (Python)
  const requirementsPath = join(path, 'requirements.txt')
  if (existsSync(requirementsPath)) {
    try {
      const content = readFileSync(requirementsPath, 'utf-8')
      if (content.toLowerCase().includes('fastapi')) return 'fastapi'
    } catch {
      // File read error
    }
  }

  // Also check pyproject.toml for modern Python projects
  const pyprojectPath = join(path, 'pyproject.toml')
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, 'utf-8')
      if (content.toLowerCase().includes('fastapi')) return 'fastapi'
    } catch {
      // File read error
    }
  }

  return null
}

/**
 * Known native Node.js modules that require compilation
 */
const NATIVE_MODULES = [
  'better-sqlite3',
  'sharp',
  'canvas',
  'bcrypt',
  'onnxruntime-node',
  'node-gyp',
  'node-sass',
  'sqlite3',
  'fsevents',
  'bufferutil',
  'utf-8-validate',
]

/**
 * Detect native module usage in package.json
 *
 * Checks for modules known to require native compilation:
 * better-sqlite3, sharp, canvas, bcrypt, onnxruntime-node, etc.
 *
 * @param path - Project path to check
 * @returns True if native modules are detected
 */
export function detectNativeModules(path: string): boolean {
  const pkgPath = join(path, 'package.json')
  if (!existsSync(pkgPath)) return false

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }

    return NATIVE_MODULES.some((mod) => mod in deps)
  } catch {
    return false
  }
}

/**
 * Detect primary programming language from project structure
 *
 * Detection order:
 * 1. TypeScript (tsconfig.json)
 * 2. JavaScript (package.json without tsconfig)
 * 3. Python (requirements.txt or pyproject.toml)
 *
 * @param path - Project path to check
 * @returns Detected language or null
 */
export function detectLanguage(path: string): 'typescript' | 'javascript' | 'python' | null {
  // TypeScript takes priority
  if (existsSync(join(path, 'tsconfig.json'))) return 'typescript'

  // JavaScript (has package.json but no tsconfig)
  if (existsSync(join(path, 'package.json'))) return 'javascript'

  // Python
  if (existsSync(join(path, 'requirements.txt')) || existsSync(join(path, 'pyproject.toml'))) {
    return 'python'
  }

  return null
}

/**
 * Get suggested skills based on project context
 *
 * @param context - Detected project context
 * @returns Array of suggested skill IDs
 *
 * @example
 * const context = detectProjectContext();
 * const suggestions = getSuggestedSkills(context);
 * // ['docker', 'github-actions', 'jest-helper']
 */
export function getSuggestedSkills(context: ProjectContext): string[] {
  const suggestions: string[] = []

  if (context.hasDocker) {
    suggestions.push('docker')
  }

  if (context.hasGitHub) {
    suggestions.push('github-actions')
    suggestions.push('github-pr')
  }

  if (context.hasLinear) {
    suggestions.push('linear')
  }

  if (context.testFramework === 'jest') {
    suggestions.push('jest-helper')
  } else if (context.testFramework === 'vitest') {
    suggestions.push('vitest-helper')
  } else if (context.testFramework === 'mocha') {
    suggestions.push('mocha-helper')
  }

  if (context.apiFramework === 'nextjs') {
    suggestions.push('nextjs')
  } else if (context.apiFramework === 'express') {
    suggestions.push('express')
  } else if (context.apiFramework === 'fastapi') {
    suggestions.push('fastapi')
  }

  if (context.hasNativeModules) {
    suggestions.push('native-modules')
  }

  if (context.language === 'typescript') {
    suggestions.push('typescript')
  } else if (context.language === 'python') {
    suggestions.push('python')
  }

  return suggestions
}
