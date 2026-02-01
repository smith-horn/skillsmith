#!/usr/bin/env npx tsx
/**
 * Smoke Test for Published Packages
 * SMI-2230: Verifies published package works correctly after npm publish
 *
 * Usage:
 *   npx tsx scripts/smoke-test-published.ts @skillsmith/mcp-server
 *   npx tsx scripts/smoke-test-published.ts @skillsmith/core 0.4.9
 *   npx tsx scripts/smoke-test-published.ts @skillsmith/mcp-server --json
 */

import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

interface TestResult {
  name: string
  passed: boolean
  duration: number
  error?: string
}

interface SmokeTestResult {
  package: string
  version: string
  tests: TestResult[]
  passed: boolean
  totalDuration: number
}

async function runTest(name: string, fn: () => void | Promise<void>): Promise<TestResult> {
  const start = Date.now()
  try {
    await fn()
    return { name, passed: true, duration: Date.now() - start }
  } catch (e) {
    return {
      name,
      passed: false,
      duration: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export async function smokeTestPackage(
  packageName: string,
  version: string = 'latest'
): Promise<SmokeTestResult> {
  const tests: TestResult[] = []
  const tempDir = mkdtempSync(join(tmpdir(), 'smoke-test-'))
  const startTime = Date.now()

  try {
    // Initialize package.json for temp directory
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'smoke-test', type: 'module' }, null, 2)
    )

    // Test 1: Package installs successfully
    tests.push(
      await runTest('install', () => {
        execSync(`npm install ${packageName}@${version}`, {
          cwd: tempDir,
          stdio: 'pipe',
          timeout: 120000,
        })
      })
    )

    // If install failed, skip remaining tests
    if (!tests[0].passed) {
      return {
        package: packageName,
        version,
        tests,
        passed: false,
        totalDuration: Date.now() - startTime,
      }
    }

    // Package-specific tests
    if (packageName === '@skillsmith/mcp-server') {
      // Test 2: CLI --version works
      tests.push(
        await runTest('version-check', () => {
          execSync(`npx -y ${packageName}@${version} --version`, {
            stdio: 'pipe',
            timeout: 30000,
          })
        })
      )

      // Test 3: MCP server can initialize
      tests.push(
        await runTest('mcp-init', () => {
          const testScript = `
            import('@skillsmith/mcp-server').then(mod => {
              console.log('MCP server module loaded');
              process.exit(0);
            }).catch(err => {
              console.error(err);
              process.exit(1);
            });
          `
          writeFileSync(join(tempDir, 'test-init.mjs'), testScript)
          execSync('node test-init.mjs', {
            cwd: tempDir,
            stdio: 'pipe',
            timeout: 30000,
          })
        })
      )
    }

    if (packageName === '@skillsmith/core') {
      // Test 2: Core exports resolve
      tests.push(
        await runTest('exports-sync', () => {
          const testScript = `
            const core = await import('${packageName}');
            const required = ['createDatabaseSync', 'openDatabase', 'SkillRepository'];
            const missing = required.filter(fn => typeof core[fn] !== 'function');
            if (missing.length > 0) {
              throw new Error('Missing exports: ' + missing.join(', '));
            }
            console.log('Sync exports OK');
          `
          writeFileSync(join(tempDir, 'test-exports.mjs'), testScript)
          execSync('node test-exports.mjs', {
            cwd: tempDir,
            stdio: 'pipe',
            timeout: 10000,
          })
        })
      )

      // Test 3: Async database functions
      tests.push(
        await runTest('exports-async', () => {
          const testScript = `
            const core = await import('${packageName}');
            const asyncFns = ['openDatabaseAsync', 'createDatabaseAsync'];
            const missing = asyncFns.filter(fn => typeof core[fn] !== 'function');
            if (missing.length > 0) {
              throw new Error('Missing async exports: ' + missing.join(', '));
            }
            console.log('Async exports OK');
          `
          writeFileSync(join(tempDir, 'test-async.mjs'), testScript)
          execSync('node test-async.mjs', {
            cwd: tempDir,
            stdio: 'pipe',
            timeout: 10000,
          })
        })
      )
    }

    if (packageName === '@skillsmith/cli') {
      // Test 2: CLI --help works
      tests.push(
        await runTest('cli-help', () => {
          execSync(`npx -y ${packageName}@${version} --help`, {
            stdio: 'pipe',
            timeout: 30000,
          })
        })
      )
    }

    return {
      package: packageName,
      version,
      tests,
      passed: tests.every((t) => t.passed),
      totalDuration: Date.now() - startTime,
    }
  } finally {
    // Cleanup temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}

function printResult(result: SmokeTestResult, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║                     Smoke Test Results                        ║')
  console.log('╠══════════════════════════════════════════════════════════════╣')
  console.log(`║  Package: ${result.package.padEnd(48)} ║`)
  console.log(`║  Version: ${result.version.padEnd(48)} ║`)
  console.log(`║  Status:  ${(result.passed ? 'PASSED' : 'FAILED').padEnd(48)} ║`)
  console.log('╠══════════════════════════════════════════════════════════════╣')

  result.tests.forEach((t) => {
    const icon = t.passed ? '✓' : '✗'
    const duration = `${t.duration}ms`
    console.log(`║  ${icon} ${t.name.padEnd(20)} ${duration.padStart(8)}                       ║`)
    if (t.error) {
      const shortError = t.error.slice(0, 45)
      console.log(`║    └─ ${shortError.padEnd(52)} ║`)
    }
  })

  console.log('╠══════════════════════════════════════════════════════════════╣')
  console.log(`║  Total Duration: ${(result.totalDuration + 'ms').padEnd(41)} ║`)
  console.log('╚══════════════════════════════════════════════════════════════╝')
}

// CLI entry point
if (process.argv[1]?.includes('smoke-test-published')) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'))
  const jsonOutput = flags.includes('--json')

  const pkg = args[0]
  const version = args[1] || 'latest'

  if (!pkg) {
    console.error('Usage: smoke-test-published.ts <package> [version] [--json]')
    console.error('Example: smoke-test-published.ts @skillsmith/mcp-server')
    process.exit(1)
  }

  smokeTestPackage(pkg, version).then((result) => {
    printResult(result, jsonOutput)
    process.exit(result.passed ? 0 : 1)
  })
}
