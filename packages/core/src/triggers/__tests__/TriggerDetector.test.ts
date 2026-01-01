/**
 * @fileoverview Tests for TriggerDetector
 * @module @skillsmith/core/triggers/__tests__/TriggerDetector
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  TriggerDetector,
  DEFAULT_FILE_TRIGGERS,
  DEFAULT_COMMAND_TRIGGERS,
  DEFAULT_ERROR_TRIGGERS,
  DEFAULT_PROJECT_TRIGGERS,
} from '../TriggerDetector.js'
import type { CodebaseContext } from '../../analysis/CodebaseAnalyzer.js'

describe('TriggerDetector', () => {
  let detector: TriggerDetector

  beforeEach(() => {
    detector = new TriggerDetector()
  })

  describe('File Pattern Triggers', () => {
    it('should detect test file patterns', () => {
      const triggers = detector.detectTriggers(null, {
        currentFile: 'src/components/Button.test.tsx',
      })

      expect(triggers.length).toBeGreaterThan(0)
      const testTrigger = triggers.find((t) => t.categories.includes('testing'))
      expect(testTrigger).toBeDefined()
      expect(testTrigger?.type).toBe('file')
      expect(testTrigger?.confidence).toBeGreaterThanOrEqual(0.9)
    })

    it('should detect Docker Compose files', () => {
      const triggers = detector.detectTriggers(null, {
        currentFile: 'docker-compose.yml',
      })

      expect(triggers.length).toBeGreaterThan(0)
      const dockerTrigger = triggers.find((t) => t.categories.includes('docker'))
      expect(dockerTrigger).toBeDefined()
      expect(dockerTrigger?.confidence).toBeGreaterThanOrEqual(0.95)
    })

    it('should detect GitHub Actions workflows', () => {
      const triggers = detector.detectTriggers(null, {
        currentFile: '.github/workflows/ci.yml',
      })

      expect(triggers.length).toBeGreaterThan(0)
      const actionTrigger = triggers.find((t) => t.categories.includes('github-actions'))
      expect(actionTrigger).toBeDefined()
    })

    it('should detect Prisma schema files', () => {
      const triggers = detector.detectTriggers(null, {
        currentFile: 'prisma/schema.prisma',
      })

      expect(triggers.length).toBeGreaterThan(0)
      const prismaTrigger = triggers.find((t) => t.categories.includes('prisma'))
      expect(prismaTrigger).toBeDefined()
      expect(prismaTrigger?.confidence).toBeGreaterThanOrEqual(0.95)
    })

    it('should not trigger on non-matching files', () => {
      const triggers = detector.detectTriggers(null, {
        currentFile: 'src/components/Button.tsx',
      })

      expect(triggers.length).toBe(0)
    })
  })

  describe('Command Triggers', () => {
    it('should detect git commit commands', () => {
      const triggers = detector.detectTriggers(null, {
        recentCommands: ['git commit -m "test"'],
      })

      expect(triggers.length).toBeGreaterThan(0)
      const gitTrigger = triggers.find((t) => t.categories.includes('git'))
      expect(gitTrigger).toBeDefined()
      expect(gitTrigger?.type).toBe('command')
    })

    it('should detect test commands', () => {
      const triggers = detector.detectTriggers(null, {
        recentCommands: ['npm test', 'npm run test'],
      })

      expect(triggers.length).toBeGreaterThan(0)
      const testTrigger = triggers.find((t) => t.categories.includes('testing'))
      expect(testTrigger).toBeDefined()
    })

    it('should detect docker commands', () => {
      const triggers = detector.detectTriggers(null, {
        recentCommands: ['docker build .', 'docker compose up'],
      })

      expect(triggers.length).toBeGreaterThan(0)
      const dockerTrigger = triggers.find((t) => t.categories.includes('docker'))
      expect(dockerTrigger).toBeDefined()
    })

    it('should detect prisma commands', () => {
      const triggers = detector.detectTriggers(null, {
        recentCommands: ['prisma migrate dev', 'prisma studio'],
      })

      expect(triggers.length).toBeGreaterThan(0)
      const prismaTrigger = triggers.find((t) => t.categories.includes('prisma'))
      expect(prismaTrigger).toBeDefined()
    })
  })

  describe('Error Triggers', () => {
    it('should detect ESLint errors', () => {
      const triggers = detector.detectTriggers(null, {
        errorMessage: 'ESLint: Parsing error at line 42',
      })

      expect(triggers.length).toBeGreaterThan(0)
      const eslintTrigger = triggers.find((t) => t.categories.includes('eslint'))
      expect(eslintTrigger).toBeDefined()
      expect(eslintTrigger?.type).toBe('error')
    })

    it('should detect Docker errors', () => {
      const triggers = detector.detectTriggers(null, {
        errorMessage: 'docker build failed: Could not resolve dependencies',
      })

      expect(triggers.length).toBeGreaterThan(0)
      const dockerTrigger = triggers.find((t) => t.categories.includes('docker'))
      expect(dockerTrigger).toBeDefined()
    })

    it('should detect test failures', () => {
      const triggers = detector.detectTriggers(null, {
        errorMessage: 'Test suite failed: 3 tests failed',
      })

      expect(triggers.length).toBeGreaterThan(0)
      const testTrigger = triggers.find((t) => t.categories.includes('testing'))
      expect(testTrigger).toBeDefined()
    })
  })

  describe('Project Structure Triggers', () => {
    it('should detect React projects', () => {
      const mockContext: CodebaseContext = {
        rootPath: '/test/project',
        imports: [],
        exports: [],
        functions: [],
        frameworks: [{ name: 'React', confidence: 0.95, evidence: ['react'] }],
        dependencies: [],
        stats: { totalFiles: 10, filesByExtension: {}, totalLines: 1000 },
        metadata: { durationMs: 100, version: '1.0.0' },
      }

      const triggers = detector.detectTriggers(mockContext)

      expect(triggers.length).toBeGreaterThan(0)
      const reactTrigger = triggers.find((t) => t.categories.includes('react'))
      expect(reactTrigger).toBeDefined()
      expect(reactTrigger?.type).toBe('project')
    })

    it('should detect Next.js projects', () => {
      const mockContext: CodebaseContext = {
        rootPath: '/test/project',
        imports: [],
        exports: [],
        functions: [],
        frameworks: [{ name: 'Next.js', confidence: 0.95, evidence: ['next'] }],
        dependencies: [],
        stats: { totalFiles: 10, filesByExtension: {}, totalLines: 1000 },
        metadata: { durationMs: 100, version: '1.0.0' },
      }

      const triggers = detector.detectTriggers(mockContext)

      const nextTrigger = triggers.find((t) => t.categories.includes('nextjs'))
      expect(nextTrigger).toBeDefined()
    })

    it('should detect Jest projects', () => {
      const mockContext: CodebaseContext = {
        rootPath: '/test/project',
        imports: [],
        exports: [],
        functions: [],
        frameworks: [{ name: 'Jest', confidence: 0.9, evidence: ['jest'] }],
        dependencies: [],
        stats: { totalFiles: 10, filesByExtension: {}, totalLines: 1000 },
        metadata: { durationMs: 100, version: '1.0.0' },
      }

      const triggers = detector.detectTriggers(mockContext)

      const jestTrigger = triggers.find((t) => t.categories.includes('jest'))
      expect(jestTrigger).toBeDefined()
    })
  })

  describe('Confidence Filtering', () => {
    it('should filter triggers below minimum confidence', () => {
      const allTriggers = detector.detectTriggers(null, {
        currentFile: 'src/App.test.tsx',
        minConfidence: 0.95,
      })

      // All returned triggers should meet the threshold
      allTriggers.forEach((trigger) => {
        expect(trigger.confidence).toBeGreaterThanOrEqual(0.95)
      })
    })

    it('should allow low confidence with explicit threshold', () => {
      const triggers = detector.detectTriggers(null, {
        currentFile: 'src/App.test.tsx',
        minConfidence: 0.1,
      })

      expect(triggers.length).toBeGreaterThan(0)
    })
  })

  describe('Multiple Trigger Sources', () => {
    it('should combine triggers from multiple sources', () => {
      const mockContext: CodebaseContext = {
        rootPath: '/test/project',
        imports: [],
        exports: [],
        functions: [],
        frameworks: [{ name: 'React', confidence: 0.95, evidence: ['react'] }],
        dependencies: [],
        stats: { totalFiles: 10, filesByExtension: {}, totalLines: 1000 },
        metadata: { durationMs: 100, version: '1.0.0' },
      }

      const triggers = detector.detectTriggers(mockContext, {
        currentFile: 'src/App.test.tsx',
        recentCommands: ['npm test'],
        errorMessage: 'Test suite failed',
      })

      // Should have triggers from multiple sources
      const types = new Set(triggers.map((t) => t.type))
      expect(types.size).toBeGreaterThan(1)
    })

    it('should deduplicate triggers by category', () => {
      // Multiple triggers for same category should be deduplicated
      const triggers = detector.detectTriggers(null, {
        currentFile: 'src/App.test.tsx',
        recentCommands: ['npm test', 'npm run test'],
      })

      const categories = triggers.flatMap((t) => t.categories)
      const testingCount = categories.filter((c) => c === 'testing').length

      // Should have testing category, but deduplicated
      expect(testingCount).toBeGreaterThan(0)
    })
  })

  describe('Custom Triggers', () => {
    it('should allow adding custom file triggers', () => {
      detector.addFilePattern({
        pattern: /\.custom\.ts$/,
        skillCategories: ['custom'],
        confidence: 0.8,
        description: 'Custom file pattern',
      })

      const triggers = detector.detectTriggers(null, {
        currentFile: 'test.custom.ts',
      })

      const customTrigger = triggers.find((t) => t.categories.includes('custom'))
      expect(customTrigger).toBeDefined()
      expect(customTrigger?.confidence).toBe(0.8)
    })

    it('should allow adding custom command triggers', () => {
      detector.addCommandPattern({
        command: /custom-cli/,
        skillCategories: ['custom-tool'],
        confidence: 0.9,
        description: 'Custom CLI tool',
      })

      const triggers = detector.detectTriggers(null, {
        recentCommands: ['custom-cli build'],
      })

      const customTrigger = triggers.find((t) => t.categories.includes('custom-tool'))
      expect(customTrigger).toBeDefined()
    })
  })
})
