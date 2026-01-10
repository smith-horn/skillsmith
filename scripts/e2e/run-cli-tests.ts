#!/usr/bin/env npx tsx
/**
 * Run CLI E2E Tests
 *
 * Executes CLI E2E tests and generates reports in multiple formats.
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
const CLI_TESTS_DIR = join(ROOT_DIR, 'packages', 'cli', 'tests', 'e2e')

// TestResult interface reserved for future use
// interface TestResult {
//   name: string;
//   passed: boolean;
//   duration: number;
//   error?: string;
// }

async function runTests(): Promise<void> {
  console.log('🧪 Running CLI E2E Tests...\n')

  // Ensure results directory exists
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true })
  }

  const startTime = Date.now()

  // Run vitest with JSON reporter using E2E-specific config
  // SMI-1315: Use vitest-e2e.config.ts to avoid exclude patterns from main config
  const vitestProcess = spawn(
    'npx',
    [
      'vitest',
      'run',
      '--config=vitest-e2e.config.ts',
      '--reporter=json',
      '--reporter=junit',
      '--outputFile.json=test-results/cli-results.json',
      '--outputFile.junit=test-results/cli-junit.xml',
      CLI_TESTS_DIR,
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
    type: 'cli',
    timestamp: new Date().toISOString(),
    duration,
    exitCode,
    passed: exitCode === 0,
  }

  writeFileSync(join(RESULTS_DIR, 'cli-summary.json'), JSON.stringify(summary, null, 2))

  console.log(`\n✅ CLI E2E Tests completed in ${duration}ms`)
  console.log(`Exit code: ${exitCode}`)

  process.exit(exitCode)
}

runTests().catch((error) => {
  console.error('Failed to run CLI E2E tests:', error)
  process.exit(1)
})
