#!/usr/bin/env npx tsx
/**
 * Run MCP E2E Tests
 *
 * Executes MCP server E2E tests and generates reports.
 */

import { spawn } from 'child_process'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// ESM compatibility for __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const ROOT_DIR = join(__dirname, '..', '..')
const RESULTS_DIR = join(ROOT_DIR, 'test-results')
const MCP_TESTS_DIR = join(ROOT_DIR, 'packages', 'mcp-server', 'tests', 'e2e')

async function runTests(): Promise<void> {
  console.log('🧪 Running MCP E2E Tests...\n')

  // Ensure results directory exists
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true })
  }

  const startTime = Date.now()

  // Run vitest with JSON reporter
  const vitestProcess = spawn(
    'npx',
    [
      'vitest',
      'run',
      '--reporter=json',
      '--reporter=junit',
      '--outputFile.json=test-results/mcp-results.json',
      '--outputFile.junit=test-results/mcp-junit.xml',
      MCP_TESTS_DIR,
    ],
    {
      cwd: ROOT_DIR,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SKILLSMITH_E2E: 'true',
      },
    }
  )

  vitestProcess.stdout?.on('data', (data) => {
    process.stdout.write(data)
  })

  vitestProcess.stderr?.on('data', (data) => {
    process.stderr.write(data)
  })

  const exitCode = await new Promise<number>((resolve) => {
    vitestProcess.on('close', (code) => resolve(code ?? 1))
  })

  const duration = Date.now() - startTime

  // Generate summary
  const summary = {
    type: 'mcp',
    timestamp: new Date().toISOString(),
    duration,
    exitCode,
    passed: exitCode === 0,
  }

  writeFileSync(join(RESULTS_DIR, 'mcp-summary.json'), JSON.stringify(summary, null, 2))

  console.log(`\n✅ MCP E2E Tests completed in ${duration}ms`)
  console.log(`Exit code: ${exitCode}`)

  process.exit(exitCode)
}

runTests().catch((error) => {
  console.error('Failed to run MCP E2E tests:', error)
  process.exit(1)
})
