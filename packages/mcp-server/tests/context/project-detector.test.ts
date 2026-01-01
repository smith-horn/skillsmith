/**
 * Unit tests for SMI-912: Project context detection for skill suggestions
 * Tests all project detection functions comprehensively
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  detectProjectContext,
  detectDocker,
  detectLinear,
  detectGitHub,
  detectTestFramework,
  detectApiFramework,
  detectNativeModules,
  detectLanguage,
  getSuggestedSkills,
  type ProjectContext,
} from '../../src/context/project-detector.js'

// Create a unique temp directory for testing
const TEST_TEMP_DIR = path.join(os.tmpdir(), 'skillsmith-context-test-' + Date.now())

/**
 * Create a mock project directory structure
 */
function createMockProject(options: {
  dockerfile?: boolean
  dockerCompose?: 'yml' | 'yaml' | boolean
  gitConfig?: string
  packageJson?: Record<string, unknown>
  tsconfig?: boolean
  requirements?: string
  pyproject?: string
}): string {
  const projectDir = path.join(TEST_TEMP_DIR, 'project-' + Date.now())
  fs.mkdirSync(projectDir, { recursive: true })

  if (options.dockerfile) {
    fs.writeFileSync(path.join(projectDir, 'Dockerfile'), 'FROM node:20')
  }

  if (options.dockerCompose) {
    const ext = options.dockerCompose === 'yaml' ? 'yaml' : 'yml'
    fs.writeFileSync(path.join(projectDir, `docker-compose.${ext}`), 'version: "3"')
  }

  if (options.gitConfig) {
    const gitDir = path.join(projectDir, '.git')
    fs.mkdirSync(gitDir, { recursive: true })
    fs.writeFileSync(path.join(gitDir, 'config'), options.gitConfig)
  }

  if (options.packageJson) {
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify(options.packageJson, null, 2))
  }

  if (options.tsconfig) {
    fs.writeFileSync(
      path.join(projectDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true } }, null, 2)
    )
  }

  if (options.requirements) {
    fs.writeFileSync(path.join(projectDir, 'requirements.txt'), options.requirements)
  }

  if (options.pyproject) {
    fs.writeFileSync(path.join(projectDir, 'pyproject.toml'), options.pyproject)
  }

  return projectDir
}

/**
 * Clean up test directories
 */
function cleanupTestDir(): void {
  if (fs.existsSync(TEST_TEMP_DIR)) {
    fs.rmSync(TEST_TEMP_DIR, { recursive: true, force: true })
  }
}

describe('project-detector', () => {
  beforeEach(() => {
    cleanupTestDir()
    fs.mkdirSync(TEST_TEMP_DIR, { recursive: true })
  })

  afterEach(() => {
    cleanupTestDir()
  })

  describe('detectDocker', () => {
    it('should detect Dockerfile', () => {
      const projectDir = createMockProject({ dockerfile: true })
      expect(detectDocker(projectDir)).toBe(true)
    })

    it('should detect docker-compose.yml', () => {
      const projectDir = createMockProject({ dockerCompose: 'yml' })
      expect(detectDocker(projectDir)).toBe(true)
    })

    it('should detect docker-compose.yaml', () => {
      const projectDir = createMockProject({ dockerCompose: 'yaml' })
      expect(detectDocker(projectDir)).toBe(true)
    })

    it('should return false when no Docker files exist', () => {
      const projectDir = createMockProject({})
      expect(detectDocker(projectDir)).toBe(false)
    })

    it('should return false for non-existent directory', () => {
      expect(detectDocker('/non/existent/path')).toBe(false)
    })
  })

  describe('detectLinear', () => {
    it('should detect Linear integration from git config', () => {
      const projectDir = createMockProject({
        gitConfig: `[core]
  repositoryformatversion = 0
[remote "origin"]
  url = https://linear.app/myorg/project-123
  fetch = +refs/heads/*:refs/remotes/origin/*`,
      })
      expect(detectLinear(projectDir)).toBe(true)
    })

    it('should return false when no git config exists', () => {
      const projectDir = createMockProject({})
      expect(detectLinear(projectDir)).toBe(false)
    })

    it('should return false when git config has no linear.app', () => {
      const projectDir = createMockProject({
        gitConfig: `[core]
  repositoryformatversion = 0
[remote "origin"]
  url = https://github.com/user/repo.git`,
      })
      expect(detectLinear(projectDir)).toBe(false)
    })

    it('should return false for non-existent directory', () => {
      expect(detectLinear('/non/existent/path')).toBe(false)
    })
  })

  describe('detectGitHub', () => {
    it('should detect GitHub hosting from git config', () => {
      const projectDir = createMockProject({
        gitConfig: `[core]
  repositoryformatversion = 0
[remote "origin"]
  url = https://github.com/user/repo.git
  fetch = +refs/heads/*:refs/remotes/origin/*`,
      })
      expect(detectGitHub(projectDir)).toBe(true)
    })

    it('should detect GitHub SSH URLs', () => {
      const projectDir = createMockProject({
        gitConfig: `[remote "origin"]
  url = git@github.com:user/repo.git`,
      })
      expect(detectGitHub(projectDir)).toBe(true)
    })

    it('should return false when no git config exists', () => {
      const projectDir = createMockProject({})
      expect(detectGitHub(projectDir)).toBe(false)
    })

    it('should return false when git config has no github.com', () => {
      const projectDir = createMockProject({
        gitConfig: `[remote "origin"]
  url = https://gitlab.com/user/repo.git`,
      })
      expect(detectGitHub(projectDir)).toBe(false)
    })

    it('should return false for non-existent directory', () => {
      expect(detectGitHub('/non/existent/path')).toBe(false)
    })
  })

  describe('detectTestFramework', () => {
    it('should detect vitest from devDependencies', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'test-project',
          devDependencies: { vitest: '^1.0.0' },
        },
      })
      expect(detectTestFramework(projectDir)).toBe('vitest')
    })

    it('should detect jest from dependencies', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'test-project',
          dependencies: { jest: '^29.0.0' },
        },
      })
      expect(detectTestFramework(projectDir)).toBe('jest')
    })

    it('should detect mocha from devDependencies', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'test-project',
          devDependencies: { mocha: '^10.0.0' },
        },
      })
      expect(detectTestFramework(projectDir)).toBe('mocha')
    })

    it('should prefer vitest over jest when both exist', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'test-project',
          devDependencies: { vitest: '^1.0.0', jest: '^29.0.0' },
        },
      })
      expect(detectTestFramework(projectDir)).toBe('vitest')
    })

    it('should return null when no package.json exists', () => {
      const projectDir = createMockProject({})
      expect(detectTestFramework(projectDir)).toBeNull()
    })

    it('should return null when no test framework is found', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'test-project',
          dependencies: { express: '^4.0.0' },
        },
      })
      expect(detectTestFramework(projectDir)).toBeNull()
    })

    it('should handle invalid JSON gracefully', () => {
      const projectDir = path.join(TEST_TEMP_DIR, 'invalid-json')
      fs.mkdirSync(projectDir, { recursive: true })
      fs.writeFileSync(path.join(projectDir, 'package.json'), '{ invalid json }')
      expect(detectTestFramework(projectDir)).toBeNull()
    })
  })

  describe('detectApiFramework', () => {
    it('should detect nextjs from dependencies', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'next-app',
          dependencies: { next: '^14.0.0', react: '^18.0.0' },
        },
      })
      expect(detectApiFramework(projectDir)).toBe('nextjs')
    })

    it('should detect express from dependencies', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'express-app',
          dependencies: { express: '^4.18.0' },
        },
      })
      expect(detectApiFramework(projectDir)).toBe('express')
    })

    it('should prefer nextjs over express when both exist', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'full-stack',
          dependencies: { next: '^14.0.0', express: '^4.18.0' },
        },
      })
      expect(detectApiFramework(projectDir)).toBe('nextjs')
    })

    it('should detect fastapi from requirements.txt', () => {
      const projectDir = createMockProject({
        requirements: `fastapi==0.104.0
uvicorn==0.24.0
pydantic==2.5.0`,
      })
      expect(detectApiFramework(projectDir)).toBe('fastapi')
    })

    it('should detect fastapi from pyproject.toml', () => {
      const projectDir = createMockProject({
        pyproject: `[project]
name = "my-api"
dependencies = [
    "fastapi>=0.104.0",
    "uvicorn>=0.24.0",
]`,
      })
      expect(detectApiFramework(projectDir)).toBe('fastapi')
    })

    it('should return null when no API framework is found', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'cli-app',
          dependencies: { commander: '^11.0.0' },
        },
      })
      expect(detectApiFramework(projectDir)).toBeNull()
    })

    it('should return null for empty directory', () => {
      const projectDir = createMockProject({})
      expect(detectApiFramework(projectDir)).toBeNull()
    })
  })

  describe('detectNativeModules', () => {
    it('should detect better-sqlite3', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'native-app',
          dependencies: { 'better-sqlite3': '^9.0.0' },
        },
      })
      expect(detectNativeModules(projectDir)).toBe(true)
    })

    it('should detect sharp in devDependencies', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'image-app',
          devDependencies: { sharp: '^0.33.0' },
        },
      })
      expect(detectNativeModules(projectDir)).toBe(true)
    })

    it('should detect onnxruntime-node', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'ml-app',
          dependencies: { 'onnxruntime-node': '^1.16.0' },
        },
      })
      expect(detectNativeModules(projectDir)).toBe(true)
    })

    it('should detect bcrypt', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'auth-app',
          dependencies: { bcrypt: '^5.1.0' },
        },
      })
      expect(detectNativeModules(projectDir)).toBe(true)
    })

    it('should detect canvas', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'graphics-app',
          dependencies: { canvas: '^2.11.0' },
        },
      })
      expect(detectNativeModules(projectDir)).toBe(true)
    })

    it('should return false when no native modules exist', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'pure-js-app',
          dependencies: { express: '^4.18.0', lodash: '^4.17.0' },
        },
      })
      expect(detectNativeModules(projectDir)).toBe(false)
    })

    it('should return false when no package.json exists', () => {
      const projectDir = createMockProject({})
      expect(detectNativeModules(projectDir)).toBe(false)
    })
  })

  describe('detectLanguage', () => {
    it('should detect TypeScript from tsconfig.json', () => {
      const projectDir = createMockProject({
        tsconfig: true,
        packageJson: { name: 'ts-app' },
      })
      expect(detectLanguage(projectDir)).toBe('typescript')
    })

    it('should detect JavaScript from package.json (no tsconfig)', () => {
      const projectDir = createMockProject({
        packageJson: { name: 'js-app' },
      })
      expect(detectLanguage(projectDir)).toBe('javascript')
    })

    it('should detect Python from requirements.txt', () => {
      const projectDir = createMockProject({
        requirements: 'flask==2.3.0\nrequests==2.31.0',
      })
      expect(detectLanguage(projectDir)).toBe('python')
    })

    it('should detect Python from pyproject.toml', () => {
      const projectDir = createMockProject({
        pyproject: '[project]\nname = "my-python-app"',
      })
      expect(detectLanguage(projectDir)).toBe('python')
    })

    it('should prefer TypeScript over JavaScript', () => {
      const projectDir = createMockProject({
        tsconfig: true,
        packageJson: { name: 'ts-app' },
      })
      expect(detectLanguage(projectDir)).toBe('typescript')
    })

    it('should return null for empty directory', () => {
      const projectDir = createMockProject({})
      expect(detectLanguage(projectDir)).toBeNull()
    })
  })

  describe('detectProjectContext', () => {
    it('should detect full project context', () => {
      const projectDir = createMockProject({
        dockerfile: true,
        gitConfig: `[remote "origin"]
  url = https://github.com/user/repo.git`,
        packageJson: {
          name: 'full-stack-app',
          dependencies: {
            next: '^14.0.0',
            'better-sqlite3': '^9.0.0',
          },
          devDependencies: {
            vitest: '^1.0.0',
          },
        },
        tsconfig: true,
      })

      const context = detectProjectContext(projectDir)

      expect(context.hasDocker).toBe(true)
      expect(context.hasGitHub).toBe(true)
      expect(context.hasLinear).toBe(false)
      expect(context.testFramework).toBe('vitest')
      expect(context.apiFramework).toBe('nextjs')
      expect(context.hasNativeModules).toBe(true)
      expect(context.language).toBe('typescript')
    })

    it('should handle minimal project', () => {
      const projectDir = createMockProject({
        packageJson: { name: 'minimal-app' },
      })

      const context = detectProjectContext(projectDir)

      expect(context.hasDocker).toBe(false)
      expect(context.hasGitHub).toBe(false)
      expect(context.hasLinear).toBe(false)
      expect(context.testFramework).toBeNull()
      expect(context.apiFramework).toBeNull()
      expect(context.hasNativeModules).toBe(false)
      expect(context.language).toBe('javascript')
    })

    it('should handle empty directory', () => {
      const projectDir = createMockProject({})

      const context = detectProjectContext(projectDir)

      expect(context.hasDocker).toBe(false)
      expect(context.hasGitHub).toBe(false)
      expect(context.hasLinear).toBe(false)
      expect(context.testFramework).toBeNull()
      expect(context.apiFramework).toBeNull()
      expect(context.hasNativeModules).toBe(false)
      expect(context.language).toBeNull()
    })

    it('should detect Python FastAPI project', () => {
      const projectDir = createMockProject({
        dockerfile: true,
        requirements: `fastapi==0.104.0
uvicorn==0.24.0
pydantic==2.5.0`,
        gitConfig: `[remote "origin"]
  url = https://github.com/user/api.git`,
      })

      const context = detectProjectContext(projectDir)

      expect(context.hasDocker).toBe(true)
      expect(context.hasGitHub).toBe(true)
      expect(context.apiFramework).toBe('fastapi')
      expect(context.language).toBe('python')
    })
  })

  describe('getSuggestedSkills', () => {
    it('should suggest docker skill for Docker projects', () => {
      const context: ProjectContext = {
        hasDocker: true,
        hasLinear: false,
        hasGitHub: false,
        testFramework: null,
        apiFramework: null,
        hasNativeModules: false,
        language: null,
      }

      const suggestions = getSuggestedSkills(context)
      expect(suggestions).toContain('docker')
    })

    it('should suggest github skills for GitHub projects', () => {
      const context: ProjectContext = {
        hasDocker: false,
        hasLinear: false,
        hasGitHub: true,
        testFramework: null,
        apiFramework: null,
        hasNativeModules: false,
        language: null,
      }

      const suggestions = getSuggestedSkills(context)
      expect(suggestions).toContain('github-actions')
      expect(suggestions).toContain('github-pr')
    })

    it('should suggest linear skill for Linear-integrated projects', () => {
      const context: ProjectContext = {
        hasDocker: false,
        hasLinear: true,
        hasGitHub: false,
        testFramework: null,
        apiFramework: null,
        hasNativeModules: false,
        language: null,
      }

      const suggestions = getSuggestedSkills(context)
      expect(suggestions).toContain('linear')
    })

    it('should suggest jest-helper for Jest projects', () => {
      const context: ProjectContext = {
        hasDocker: false,
        hasLinear: false,
        hasGitHub: false,
        testFramework: 'jest',
        apiFramework: null,
        hasNativeModules: false,
        language: null,
      }

      const suggestions = getSuggestedSkills(context)
      expect(suggestions).toContain('jest-helper')
    })

    it('should suggest vitest-helper for Vitest projects', () => {
      const context: ProjectContext = {
        hasDocker: false,
        hasLinear: false,
        hasGitHub: false,
        testFramework: 'vitest',
        apiFramework: null,
        hasNativeModules: false,
        language: null,
      }

      const suggestions = getSuggestedSkills(context)
      expect(suggestions).toContain('vitest-helper')
    })

    it('should suggest mocha-helper for Mocha projects', () => {
      const context: ProjectContext = {
        hasDocker: false,
        hasLinear: false,
        hasGitHub: false,
        testFramework: 'mocha',
        apiFramework: null,
        hasNativeModules: false,
        language: null,
      }

      const suggestions = getSuggestedSkills(context)
      expect(suggestions).toContain('mocha-helper')
    })

    it('should suggest nextjs skill for Next.js projects', () => {
      const context: ProjectContext = {
        hasDocker: false,
        hasLinear: false,
        hasGitHub: false,
        testFramework: null,
        apiFramework: 'nextjs',
        hasNativeModules: false,
        language: null,
      }

      const suggestions = getSuggestedSkills(context)
      expect(suggestions).toContain('nextjs')
    })

    it('should suggest express skill for Express projects', () => {
      const context: ProjectContext = {
        hasDocker: false,
        hasLinear: false,
        hasGitHub: false,
        testFramework: null,
        apiFramework: 'express',
        hasNativeModules: false,
        language: null,
      }

      const suggestions = getSuggestedSkills(context)
      expect(suggestions).toContain('express')
    })

    it('should suggest fastapi skill for FastAPI projects', () => {
      const context: ProjectContext = {
        hasDocker: false,
        hasLinear: false,
        hasGitHub: false,
        testFramework: null,
        apiFramework: 'fastapi',
        hasNativeModules: false,
        language: null,
      }

      const suggestions = getSuggestedSkills(context)
      expect(suggestions).toContain('fastapi')
    })

    it('should suggest native-modules skill for projects with native modules', () => {
      const context: ProjectContext = {
        hasDocker: false,
        hasLinear: false,
        hasGitHub: false,
        testFramework: null,
        apiFramework: null,
        hasNativeModules: true,
        language: null,
      }

      const suggestions = getSuggestedSkills(context)
      expect(suggestions).toContain('native-modules')
    })

    it('should suggest typescript skill for TypeScript projects', () => {
      const context: ProjectContext = {
        hasDocker: false,
        hasLinear: false,
        hasGitHub: false,
        testFramework: null,
        apiFramework: null,
        hasNativeModules: false,
        language: 'typescript',
      }

      const suggestions = getSuggestedSkills(context)
      expect(suggestions).toContain('typescript')
    })

    it('should suggest python skill for Python projects', () => {
      const context: ProjectContext = {
        hasDocker: false,
        hasLinear: false,
        hasGitHub: false,
        testFramework: null,
        apiFramework: null,
        hasNativeModules: false,
        language: 'python',
      }

      const suggestions = getSuggestedSkills(context)
      expect(suggestions).toContain('python')
    })

    it('should return multiple suggestions for complex projects', () => {
      const context: ProjectContext = {
        hasDocker: true,
        hasLinear: false,
        hasGitHub: true,
        testFramework: 'vitest',
        apiFramework: 'nextjs',
        hasNativeModules: true,
        language: 'typescript',
      }

      const suggestions = getSuggestedSkills(context)

      expect(suggestions).toContain('docker')
      expect(suggestions).toContain('github-actions')
      expect(suggestions).toContain('github-pr')
      expect(suggestions).toContain('vitest-helper')
      expect(suggestions).toContain('nextjs')
      expect(suggestions).toContain('native-modules')
      expect(suggestions).toContain('typescript')
    })

    it('should return empty array for empty context', () => {
      const context: ProjectContext = {
        hasDocker: false,
        hasLinear: false,
        hasGitHub: false,
        testFramework: null,
        apiFramework: null,
        hasNativeModules: false,
        language: null,
      }

      const suggestions = getSuggestedSkills(context)
      expect(suggestions).toEqual([])
    })
  })

  describe('edge cases', () => {
    it('should handle read-only file systems gracefully', () => {
      // Non-existent paths should return default values, not throw
      const context = detectProjectContext('/this/path/does/not/exist')

      expect(context.hasDocker).toBe(false)
      expect(context.hasGitHub).toBe(false)
      expect(context.language).toBeNull()
    })

    it('should handle corrupted package.json', () => {
      const projectDir = path.join(TEST_TEMP_DIR, 'corrupt-json')
      fs.mkdirSync(projectDir, { recursive: true })
      fs.writeFileSync(path.join(projectDir, 'package.json'), '{ "name": incomplete')

      expect(detectTestFramework(projectDir)).toBeNull()
      expect(detectApiFramework(projectDir)).toBeNull()
      expect(detectNativeModules(projectDir)).toBe(false)
    })

    it('should handle package.json with null dependencies', () => {
      const projectDir = createMockProject({
        packageJson: {
          name: 'null-deps',
          dependencies: null,
        },
      })

      // Should not throw
      expect(detectTestFramework(projectDir)).toBeNull()
    })

    it('should handle empty git config file', () => {
      const projectDir = createMockProject({
        gitConfig: '',
      })

      expect(detectGitHub(projectDir)).toBe(false)
      expect(detectLinear(projectDir)).toBe(false)
    })

    it('should handle case-insensitive fastapi detection', () => {
      const projectDir = createMockProject({
        requirements: 'FastAPI==0.104.0\nUvicorn==0.24.0',
      })

      expect(detectApiFramework(projectDir)).toBe('fastapi')
    })
  })
})
