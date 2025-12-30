/**
 * SMI-756: Integration tests for analyze MCP tool
 * Tests codebase analysis with real filesystem
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createTestFilesystem, type TestFilesystemContext } from './setup.js'
import { executeAnalyze, formatAnalysisResults } from '../../src/tools/analyze.js'

describe('Analyze Tool Integration', () => {
  let ctx: TestFilesystemContext

  beforeEach(async () => {
    ctx = await createTestFilesystem()
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  /**
   * Helper to create test project files
   */
  async function createTestProject(files: Record<string, string>): Promise<string> {
    const projectDir = path.join(ctx.tempDir, 'test-project')
    await fs.mkdir(projectDir, { recursive: true })

    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(projectDir, filePath)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, content)
    }

    return projectDir
  }

  describe('executeAnalyze', () => {
    it('should analyze a TypeScript project', async () => {
      const projectDir = await createTestProject({
        'package.json': JSON.stringify({
          name: 'test-project',
          dependencies: {
            react: '^18.0.0',
            typescript: '^5.0.0',
          },
        }),
        'src/index.ts': `
import React from 'react';
import { useState } from 'react';

export function App() {
  const [count, setCount] = useState(0);
  return <div>{count}</div>;
}
`,
        'src/utils.ts': `
export function add(a: number, b: number): number {
  return a + b;
}

export const multiply = (a: number, b: number) => a * b;
`,
      })

      const result = await executeAnalyze({
        path: projectDir,
      })

      expect(result.stats.total_files).toBeGreaterThan(0)
      expect(result.stats.file_types['.ts']).toBeGreaterThan(0)
      expect(result.imports.length).toBeGreaterThan(0)
      expect(result.imports).toContain('react')
    })

    it('should detect React framework', async () => {
      const projectDir = await createTestProject({
        'package.json': JSON.stringify({
          dependencies: {
            react: '^18.0.0',
            'react-dom': '^18.0.0',
          },
        }),
        'App.tsx': `
import React from 'react';
export const App = () => <div>Hello</div>;
`,
      })

      const result = await executeAnalyze({
        path: projectDir,
      })

      const reactFramework = result.frameworks.find((f) => f.name === 'React')
      expect(reactFramework).toBeDefined()
      expect(reactFramework?.confidence).toBeGreaterThan(0)
    })

    it('should detect Express framework', async () => {
      const projectDir = await createTestProject({
        'package.json': JSON.stringify({
          dependencies: {
            express: '^4.18.0',
          },
        }),
        'server.ts': `
import express from 'express';
const app = express();
app.get('/', (req, res) => res.send('Hello'));
`,
      })

      const result = await executeAnalyze({
        path: projectDir,
      })

      const expressFramework = result.frameworks.find((f) => f.name === 'Express')
      expect(expressFramework).toBeDefined()
    })

    it('should detect Vitest framework', async () => {
      const projectDir = await createTestProject({
        'package.json': JSON.stringify({
          devDependencies: {
            vitest: '^1.0.0',
          },
        }),
        'test.ts': `
import { describe, it, expect } from 'vitest';
describe('test', () => {
  it('works', () => expect(true).toBe(true));
});
`,
      })

      const result = await executeAnalyze({
        path: projectDir,
        include_dev_deps: true,
      })

      const vitestFramework = result.frameworks.find((f) => f.name === 'Vitest')
      expect(vitestFramework).toBeDefined()
    })

    it('should extract dependencies', async () => {
      const projectDir = await createTestProject({
        'package.json': JSON.stringify({
          dependencies: {
            lodash: '^4.17.0',
            axios: '^1.0.0',
          },
          devDependencies: {
            typescript: '^5.0.0',
          },
        }),
        'index.ts': 'export const x = 1;',
      })

      const result = await executeAnalyze({
        path: projectDir,
        include_dev_deps: true,
      })

      expect(result.dependencies.length).toBeGreaterThan(0)
      const prodDeps = result.dependencies.filter((d) => !d.is_dev)
      const devDeps = result.dependencies.filter((d) => d.is_dev)

      expect(prodDeps.some((d) => d.name === 'lodash')).toBe(true)
      expect(devDeps.some((d) => d.name === 'typescript')).toBe(true)
    })

    it('should respect max_files option', async () => {
      const files: Record<string, string> = {}
      for (let i = 0; i < 20; i++) {
        files[`file${i}.ts`] = `export const x${i} = ${i};`
      }

      const projectDir = await createTestProject(files)

      const result = await executeAnalyze({
        path: projectDir,
        max_files: 5,
      })

      expect(result.stats.total_files).toBe(5)
    })

    it('should exclude specified directories', async () => {
      const projectDir = await createTestProject({
        'src/app.ts': 'export const app = 1;',
        'tests/test.ts': 'export const test = 1;',
        'build/out.ts': 'export const out = 1;',
      })

      const result = await executeAnalyze({
        path: projectDir,
        exclude_dirs: ['tests', 'build'],
      })

      expect(result.stats.total_files).toBe(1)
    })

    it('should generate summary', async () => {
      const projectDir = await createTestProject({
        'package.json': JSON.stringify({
          dependencies: { react: '^18.0.0' },
        }),
        'app.tsx': `import React from 'react';`,
      })

      const result = await executeAnalyze({
        path: projectDir,
      })

      expect(result.summary).toBeDefined()
      expect(result.summary.length).toBeGreaterThan(0)
    })

    it('should track timing information', async () => {
      const projectDir = await createTestProject({
        'index.ts': 'export const x = 1;',
      })

      const result = await executeAnalyze({
        path: projectDir,
      })

      expect(result.timing.duration_ms).toBeGreaterThanOrEqual(0)
    })

    it('should handle empty directory', async () => {
      const emptyDir = path.join(ctx.tempDir, 'empty-project')
      await fs.mkdir(emptyDir, { recursive: true })

      const result = await executeAnalyze({
        path: emptyDir,
      })

      expect(result.stats.total_files).toBe(0)
      expect(result.imports).toHaveLength(0)
      expect(result.frameworks).toHaveLength(0)
    })

    it('should throw for non-existent path', async () => {
      await expect(
        executeAnalyze({
          path: '/non/existent/path',
        })
      ).rejects.toThrow()
    })
  })

  describe('formatAnalysisResults', () => {
    it('should format analysis for terminal display', async () => {
      const projectDir = await createTestProject({
        'package.json': JSON.stringify({
          dependencies: { react: '^18.0.0' },
        }),
        'app.tsx': `import React from 'react';`,
      })

      const result = await executeAnalyze({
        path: projectDir,
      })

      const formatted = formatAnalysisResults(result)

      expect(formatted).toContain('Codebase Analysis')
      expect(formatted).toContain('Files:')
      expect(formatted).toContain('Duration:')
    })

    it('should display frameworks', async () => {
      const projectDir = await createTestProject({
        'package.json': JSON.stringify({
          dependencies: { react: '^18.0.0' },
        }),
        'app.tsx': `import React from 'react';`,
      })

      const result = await executeAnalyze({
        path: projectDir,
      })

      const formatted = formatAnalysisResults(result)

      if (result.frameworks.length > 0) {
        expect(formatted).toContain('Frameworks detected')
      }
    })
  })
})
