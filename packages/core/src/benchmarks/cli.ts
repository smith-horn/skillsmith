#!/usr/bin/env npx tsx
/**
 * SMI-632: Benchmark CLI
 *
 * Usage:
 *   npx tsx src/benchmarks/cli.ts
 *   npx tsx src/benchmarks/cli.ts --suite search
 *   npx tsx src/benchmarks/cli.ts --suite index
 *   npx tsx src/benchmarks/cli.ts --json
 *   npx tsx src/benchmarks/cli.ts --compare baseline.json
 */

import { runAllBenchmarks, type CLIOptions } from './index.js'

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2)
  const options: CLIOptions = {}

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--suite':
      case '-s': {
        const suite = args[++i]
        if (suite === 'search' || suite === 'index') {
          options.suite = suite
        } else {
          console.error(`Invalid suite: ${suite}. Use 'search' or 'index'.`)
          process.exit(1)
        }
        break
      }
      case '--json':
        options.output = 'json'
        break
      case '--compare':
      case '-c':
        options.compare = args[++i]
        break
      case '--iterations':
      case '-n': {
        const n = parseInt(args[++i], 10)
        if (isNaN(n) || n <= 0) {
          console.error(`Invalid iterations: must be a positive number`)
          process.exit(1)
        }
        options.iterations = n
        break
      }
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
    }
  }

  return options
}

function printHelp(): void {
  console.log(`
SMI-632: Skillsmith Performance Benchmarks

Usage:
  npx tsx src/benchmarks/cli.ts [options]

Options:
  --suite, -s <name>     Run specific suite (search, index)
  --json                 Output results as JSON
  --compare, -c <file>   Compare with baseline JSON file
  --iterations, -n <num> Override iteration count
  --help, -h             Show this help message

Performance Targets:
  p50: < 100ms
  p95: < 300ms
  p99: < 500ms

Examples:
  npx tsx src/benchmarks/cli.ts                  # Run all benchmarks
  npx tsx src/benchmarks/cli.ts --suite search   # Run search benchmarks only
  npx tsx src/benchmarks/cli.ts --json           # Output as JSON
  npx tsx src/benchmarks/cli.ts --compare b.json # Compare with baseline
`)
}

async function main(): Promise<void> {
  const options = parseArgs()

  console.log('╔═══════════════════════════════════════════════════════════════╗')
  console.log('║         SMI-632: Skillsmith Performance Benchmarks            ║')
  console.log('╠═══════════════════════════════════════════════════════════════╣')
  console.log('║  Targets: p50 < 100ms | p95 < 300ms | p99 < 500ms             ║')
  console.log('╚═══════════════════════════════════════════════════════════════╝')
  console.log('')

  try {
    await runAllBenchmarks(options)
    console.log('\n✓ Benchmark run complete')
  } catch (error) {
    console.error('\n✗ Benchmark failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

main()
