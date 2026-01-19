/**
 * SMI-600: CodebaseAnalyzer Tests
 * Tests for codebase analysis functionality
 *
 * @see ADR-010: Codebase Analysis Scope
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { CodebaseAnalyzer } from '../src/analysis/index.js'

describe('CodebaseAnalyzer', () => {
  let analyzer: CodebaseAnalyzer
  let tempDir: string

  beforeEach(() => {
    analyzer = new CodebaseAnalyzer()
    // Create temp directory for test fixtures
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-test-'))
  })

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /**
   * Helper to create test files
   */
  function createTestFile(relativePath: string, content: string): void {
    const fullPath = path.join(tempDir, relativePath)
    const dir = path.dirname(fullPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(fullPath, content)
  }

  describe('basic analysis', () => {
    it('should analyze an empty directory', async () => {
      const context = await analyzer.analyze(tempDir)

      expect(context.rootPath).toBe(tempDir)
      expect(context.stats.totalFiles).toBe(0)
      expect(context.imports).toHaveLength(0)
      expect(context.exports).toHaveLength(0)
      expect(context.frameworks).toHaveLength(0)
    })

    it('should throw for non-existent directory', async () => {
      await expect(analyzer.analyze('/nonexistent/path')).rejects.toThrow('Directory not found')
    })

    it('should count files by extension', async () => {
      createTestFile('file1.ts', 'export const a = 1;')
      createTestFile('file2.ts', 'export const b = 2;')
      createTestFile('file3.js', 'export const c = 3;')
      createTestFile('file4.tsx', 'export const App = () => <div />;')

      const context = await analyzer.analyze(tempDir)

      expect(context.stats.totalFiles).toBe(4)
      expect(context.stats.filesByExtension['.ts']).toBe(2)
      expect(context.stats.filesByExtension['.js']).toBe(1)
      expect(context.stats.filesByExtension['.tsx']).toBe(1)
    })

    it('should count total lines', async () => {
      createTestFile(
        'multi-line.ts',
        `line 1
line 2
line 3
line 4
line 5`
      )

      const context = await analyzer.analyze(tempDir)

      expect(context.stats.totalLines).toBe(5)
    })

    it('should track analysis duration', async () => {
      createTestFile('file.ts', 'export const x = 1;')

      const context = await analyzer.analyze(tempDir)

      expect(context.metadata.durationMs).toBeGreaterThanOrEqual(0)
      expect(context.metadata.version).toBe('1.0.0')
    })
  })

  describe('import extraction', () => {
    it('should extract default imports', async () => {
      createTestFile(
        'imports.ts',
        `import React from 'react';
import express from 'express';`
      )

      const context = await analyzer.analyze(tempDir)

      expect(context.imports).toHaveLength(2)
      expect(context.imports[0]).toMatchObject({
        module: 'react',
        defaultImport: 'React',
        namedImports: [],
      })
      expect(context.imports[1]).toMatchObject({
        module: 'express',
        defaultImport: 'express',
      })
    })

    it('should extract named imports', async () => {
      createTestFile('named.ts', `import { useState, useEffect, useCallback } from 'react';`)

      const context = await analyzer.analyze(tempDir)

      expect(context.imports).toHaveLength(1)
      expect(context.imports[0].namedImports).toEqual(['useState', 'useEffect', 'useCallback'])
    })

    it('should extract namespace imports', async () => {
      createTestFile('namespace.ts', `import * as path from 'path';`)

      const context = await analyzer.analyze(tempDir)

      expect(context.imports).toHaveLength(1)
      expect(context.imports[0].namespaceImport).toBe('path')
    })

    it('should detect type-only imports', async () => {
      createTestFile('types.ts', `import type { Request, Response } from 'express';`)

      const context = await analyzer.analyze(tempDir)

      expect(context.imports).toHaveLength(1)
      expect(context.imports[0].isTypeOnly).toBe(true)
    })

    it('should handle mixed import styles', async () => {
      createTestFile('mixed.ts', `import React, { useState, useEffect } from 'react';`)

      const context = await analyzer.analyze(tempDir)

      expect(context.imports).toHaveLength(1)
      expect(context.imports[0].defaultImport).toBe('React')
      expect(context.imports[0].namedImports).toEqual(['useState', 'useEffect'])
    })
  })

  describe('export extraction', () => {
    it('should extract function exports', async () => {
      createTestFile(
        'functions.ts',
        `export function hello() {}
export async function fetchData() {}`
      )

      const context = await analyzer.analyze(tempDir)

      const funcExports = context.exports.filter((e) => e.kind === 'function')
      expect(funcExports).toHaveLength(2)
    })

    it('should extract class exports', async () => {
      createTestFile(
        'classes.ts',
        `export class MyService {}
export default class DefaultService {}`
      )

      const context = await analyzer.analyze(tempDir)

      const classExports = context.exports.filter((e) => e.kind === 'class')
      expect(classExports.length).toBeGreaterThanOrEqual(1)
    })

    it('should extract interface exports', async () => {
      createTestFile(
        'interfaces.ts',
        `export interface User {
  id: string;
  name: string;
}`
      )

      const context = await analyzer.analyze(tempDir)

      const interfaceExports = context.exports.filter((e) => e.kind === 'interface')
      expect(interfaceExports).toHaveLength(1)
      expect(interfaceExports[0].name).toBe('User')
    })

    it('should extract type exports', async () => {
      createTestFile('types.ts', `export type Status = 'active' | 'inactive';`)

      const context = await analyzer.analyze(tempDir)

      const typeExports = context.exports.filter((e) => e.kind === 'type')
      expect(typeExports).toHaveLength(1)
      expect(typeExports[0].name).toBe('Status')
    })
  })

  describe('function extraction', () => {
    it('should extract function declarations', async () => {
      createTestFile(
        'funcs.ts',
        `export function add(a: number, b: number) {
  return a + b;
}

function privateFunc() {}

export async function fetchUser(id: string) {
  return { id };
}`
      )

      const context = await analyzer.analyze(tempDir)

      expect(context.functions.length).toBeGreaterThanOrEqual(2)

      const addFunc = context.functions.find((f) => f.name === 'add')
      expect(addFunc).toBeDefined()
      expect(addFunc?.parameterCount).toBe(2)
      expect(addFunc?.isAsync).toBe(false)
      expect(addFunc?.isExported).toBe(true)

      const fetchFunc = context.functions.find((f) => f.name === 'fetchUser')
      expect(fetchFunc).toBeDefined()
      expect(fetchFunc?.isAsync).toBe(true)
    })

    it('should extract arrow functions', async () => {
      createTestFile(
        'arrows.ts',
        `export const multiply = (a: number, b: number) => a * b;
export const asyncFetch = async (url: string) => fetch(url);`
      )

      const context = await analyzer.analyze(tempDir)

      const multiplyFunc = context.functions.find((f) => f.name === 'multiply')
      expect(multiplyFunc).toBeDefined()
      expect(multiplyFunc?.parameterCount).toBe(2)

      const asyncFunc = context.functions.find((f) => f.name === 'asyncFetch')
      expect(asyncFunc).toBeDefined()
      expect(asyncFunc?.isAsync).toBe(true)
    })

    it('should track line numbers', async () => {
      createTestFile(
        'lines.ts',
        `// Comment
export function first() {}

export function second() {}`
      )

      const context = await analyzer.analyze(tempDir)

      const first = context.functions.find((f) => f.name === 'first')
      const second = context.functions.find((f) => f.name === 'second')

      expect(first?.line).toBe(2)
      expect(second?.line).toBe(4)
    })
  })

  describe('framework detection', () => {
    it('should detect React', async () => {
      createTestFile(
        'package.json',
        JSON.stringify({
          dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
        })
      )
      createTestFile(
        'App.tsx',
        `import React from 'react';
export const App = () => <div>Hello</div>;`
      )

      const context = await analyzer.analyze(tempDir)

      const react = context.frameworks.find((f) => f.name === 'React')
      expect(react).toBeDefined()
      expect(react?.confidence).toBeGreaterThan(0)
      expect(react?.evidence.length).toBeGreaterThan(0)
    })

    it('should detect Next.js', async () => {
      createTestFile(
        'package.json',
        JSON.stringify({
          dependencies: { next: '^14.0.0', react: '^18.0.0' },
        })
      )
      createTestFile(
        'page.tsx',
        `import { useRouter } from 'next/router';
export default function Page() { return <div />; }`
      )

      const context = await analyzer.analyze(tempDir)

      const nextjs = context.frameworks.find((f) => f.name === 'Next.js')
      expect(nextjs).toBeDefined()
    })

    it('should detect Express', async () => {
      createTestFile(
        'package.json',
        JSON.stringify({
          dependencies: { express: '^4.18.0' },
        })
      )
      createTestFile(
        'server.ts',
        `import express from 'express';
const app = express();`
      )

      const context = await analyzer.analyze(tempDir)

      const expressFramework = context.frameworks.find((f) => f.name === 'Express')
      expect(expressFramework).toBeDefined()
    })

    it('should detect Vitest', async () => {
      createTestFile(
        'package.json',
        JSON.stringify({
          devDependencies: { vitest: '^1.0.0' },
        })
      )
      createTestFile(
        'test.ts',
        `import { describe, it, expect } from 'vitest';
describe('test', () => { it('works', () => expect(true).toBe(true)); });`
      )

      const context = await analyzer.analyze(tempDir)

      const vitest = context.frameworks.find((f) => f.name === 'Vitest')
      expect(vitest).toBeDefined()
    })

    it('should detect multiple frameworks', async () => {
      createTestFile(
        'package.json',
        JSON.stringify({
          dependencies: {
            react: '^18.0.0',
            express: '^4.18.0',
            '@prisma/client': '^5.0.0',
          },
          devDependencies: {
            vitest: '^1.0.0',
          },
        })
      )

      const context = await analyzer.analyze(tempDir)

      expect(context.frameworks.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('dependency reading', () => {
    it('should read production dependencies', async () => {
      createTestFile(
        'package.json',
        JSON.stringify({
          dependencies: {
            lodash: '^4.17.0',
            axios: '^1.0.0',
          },
        })
      )

      const context = await analyzer.analyze(tempDir)

      expect(context.dependencies).toHaveLength(2)
      expect(context.dependencies.every((d) => !d.isDev)).toBe(true)
    })

    it('should read dev dependencies when enabled', async () => {
      createTestFile(
        'package.json',
        JSON.stringify({
          dependencies: { lodash: '^4.17.0' },
          devDependencies: { vitest: '^1.0.0' },
        })
      )

      const context = await analyzer.analyze(tempDir, { includeDevDeps: true })

      const devDeps = context.dependencies.filter((d) => d.isDev)
      expect(devDeps.length).toBeGreaterThan(0)
    })

    it('should skip dev dependencies when disabled', async () => {
      createTestFile(
        'package.json',
        JSON.stringify({
          dependencies: { lodash: '^4.17.0' },
          devDependencies: { vitest: '^1.0.0' },
        })
      )

      const context = await analyzer.analyze(tempDir, { includeDevDeps: false })

      const devDeps = context.dependencies.filter((d) => d.isDev)
      expect(devDeps).toHaveLength(0)
    })

    it('should handle missing package.json', async () => {
      createTestFile('index.ts', 'export const x = 1;')
      // No package.json

      const context = await analyzer.analyze(tempDir)

      expect(context.dependencies).toHaveLength(0)
    })
  })

  describe('options', () => {
    it('should respect maxFiles option', async () => {
      // Create 10 files
      for (let i = 0; i < 10; i++) {
        createTestFile(`file${i}.ts`, `export const x${i} = ${i};`)
      }

      const context = await analyzer.analyze(tempDir, { maxFiles: 3 })

      expect(context.stats.totalFiles).toBe(3)
    })

    it('should exclude specified directories', async () => {
      createTestFile('src/app.ts', 'export const app = 1;')
      createTestFile('tests/test.ts', 'export const test = 1;')
      createTestFile('build/out.ts', 'export const out = 1;')

      const context = await analyzer.analyze(tempDir, {
        excludeDirs: ['tests', 'build'],
      })

      expect(context.stats.totalFiles).toBe(1)
    })

    it('should exclude node_modules by default', async () => {
      createTestFile('src/app.ts', 'export const app = 1;')
      createTestFile('node_modules/pkg/index.ts', 'export const pkg = 1;')

      const context = await analyzer.analyze(tempDir)

      expect(context.stats.totalFiles).toBe(1)
    })
  })

  describe('getSummary', () => {
    it('should generate a summary string', async () => {
      createTestFile(
        'package.json',
        JSON.stringify({
          dependencies: { react: '^18.0.0', express: '^4.0.0' },
        })
      )
      createTestFile('app.tsx', `import React from 'react';`)

      const context = await analyzer.analyze(tempDir)
      const summary = analyzer.getSummary(context)

      expect(summary).toContain('React')
      expect(summary).toContain('Files:')
    })
  })

  describe('edge cases', () => {
    it('should handle files with syntax errors gracefully', async () => {
      createTestFile('valid.ts', 'export const x = 1;')
      createTestFile('invalid.ts', 'export const { = broken')

      // Should not throw
      const context = await analyzer.analyze(tempDir)

      expect(context.stats.totalFiles).toBe(2)
    })

    it('should handle empty files', async () => {
      createTestFile('empty.ts', '')

      const context = await analyzer.analyze(tempDir)

      expect(context.stats.totalFiles).toBe(1)
    })

    it('should handle files with only comments', async () => {
      createTestFile(
        'comments.ts',
        `// This is a comment
/* Multi-line
   comment */`
      )

      const context = await analyzer.analyze(tempDir)

      expect(context.imports).toHaveLength(0)
      expect(context.exports).toHaveLength(0)
    })
  })
})
