#!/usr/bin/env npx tsx
/**
 * Dependency Graph Analyzer for Coordinated Publishing
 * SMI-2230: Detects unpublished workspace dependencies and determines publish order
 *
 * Usage:
 *   npx tsx scripts/analyze-publish-deps.ts                  # Analyze all packages
 *   npx tsx scripts/analyze-publish-deps.ts --package=@skillsmith/mcp-server  # Specific package
 *   npx tsx scripts/analyze-publish-deps.ts --json           # JSON output for CI
 */

import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = join(__dirname, '..')

interface PackageInfo {
  name: string
  path: string
  version: string
  localVersion: string
  publishedVersion: string | null
  workspaceDeps: string[]
  hasUnpublishedChanges: boolean
  canPublish: boolean
  blockReason?: string
}

interface PublishPlan {
  order: string[]
  packages: PackageInfo[]
  blockers: string[]
  ready: boolean
}

const WORKSPACE_PACKAGES: { name: string; path: string }[] = [
  { name: '@skillsmith/core', path: 'packages/core' },
  { name: '@skillsmith/mcp-server', path: 'packages/mcp-server' },
  { name: '@skillsmith/cli', path: 'packages/cli' },
]

function getPublishedVersion(name: string): string | null {
  try {
    const result = execSync(`npm view ${name} version 2>/dev/null`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return result.trim()
  } catch {
    return null // Not published yet
  }
}

function getLocalVersion(pkgPath: string): string {
  const pkgJsonPath = join(ROOT_DIR, pkgPath, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
  return pkg.version
}

function getWorkspaceDeps(pkgPath: string): string[] {
  const pkgJsonPath = join(ROOT_DIR, pkgPath, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
  const deps = { ...pkg.dependencies, ...pkg.peerDependencies }

  return Object.entries(deps)
    .filter(([, v]) => {
      const val = v as string
      // Match workspace: protocol or local file references
      return val.startsWith('workspace:') || val.startsWith('file:')
    })
    .map(([k]) => k)
}

function topologicalSort(packages: PackageInfo[]): string[] {
  const visited = new Set<string>()
  const result: string[] = []
  const pkgMap = new Map(packages.map((p) => [p.name, p]))

  function visit(name: string): void {
    if (visited.has(name)) return
    visited.add(name)
    const pkg = pkgMap.get(name)
    if (pkg) {
      // Visit dependencies first
      pkg.workspaceDeps.forEach((dep) => {
        if (pkgMap.has(dep)) {
          visit(dep)
        }
      })
      result.push(name)
    }
  }

  packages.forEach((p) => visit(p.name))
  return result
}

function detectCircularDeps(packages: PackageInfo[]): string[] {
  const pkgMap = new Map(packages.map((p) => [p.name, p]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const cycles: string[] = []

  function dfs(name: string, path: string[]): void {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      const cycleStart = path.indexOf(name)
      cycles.push(path.slice(cycleStart).join(' → ') + ' → ' + name)
      return
    }

    visiting.add(name)
    path.push(name)

    const pkg = pkgMap.get(name)
    if (pkg) {
      pkg.workspaceDeps.forEach((dep) => {
        if (pkgMap.has(dep)) {
          dfs(dep, [...path])
        }
      })
    }

    visiting.delete(name)
    visited.add(name)
  }

  packages.forEach((p) => dfs(p.name, []))
  return cycles
}

export function analyzePublishDeps(targetPackage?: string): PublishPlan {
  // Gather info for all workspace packages
  const packages: PackageInfo[] = WORKSPACE_PACKAGES.filter(({ path }) =>
    existsSync(join(ROOT_DIR, path, 'package.json'))
  ).map(({ name, path }) => {
    const localVersion = getLocalVersion(path)
    const publishedVersion = getPublishedVersion(name)
    const workspaceDeps = getWorkspaceDeps(path)

    return {
      name,
      path,
      version: localVersion,
      localVersion,
      publishedVersion,
      workspaceDeps,
      hasUnpublishedChanges: localVersion !== publishedVersion,
      canPublish: true, // Will be updated below
    }
  })

  // Check for circular dependencies
  const cycles = detectCircularDeps(packages)
  if (cycles.length > 0) {
    return {
      order: [],
      packages,
      blockers: cycles.map((c) => `Circular dependency detected: ${c}`),
      ready: false,
    }
  }

  // Check if workspace deps are published or will be published
  const blockers: string[] = []
  const pkgMap = new Map(packages.map((p) => [p.name, p]))

  packages.forEach((pkg) => {
    pkg.workspaceDeps.forEach((depName) => {
      const dep = pkgMap.get(depName)
      if (dep) {
        if (dep.hasUnpublishedChanges && !dep.canPublish) {
          pkg.canPublish = false
          pkg.blockReason = `Depends on unpublished ${depName}@${dep.localVersion}`
          blockers.push(`${pkg.name} depends on unpublished ${depName}@${dep.localVersion}`)
        }
      }
    })
  })

  // Get topological order
  const order = topologicalSort(packages)

  // Filter to target package and its deps if specified
  if (targetPackage && targetPackage !== 'all') {
    const normalizedTarget = targetPackage.startsWith('@')
      ? targetPackage
      : `@skillsmith/${targetPackage}`

    const targetIdx = order.indexOf(normalizedTarget)
    if (targetIdx === -1) {
      throw new Error(
        `Unknown package: ${targetPackage}. Available: ${WORKSPACE_PACKAGES.map((p) => p.name).join(', ')}`
      )
    }

    const needed = new Set([normalizedTarget])

    // Include all dependencies transitively
    function addDeps(name: string): void {
      const pkg = pkgMap.get(name)
      if (pkg) {
        pkg.workspaceDeps.forEach((dep) => {
          if (pkgMap.has(dep) && !needed.has(dep)) {
            needed.add(dep)
            addDeps(dep)
          }
        })
      }
    }
    addDeps(normalizedTarget)

    return {
      order: order.filter((name) => needed.has(name)),
      packages: packages.filter((p) => needed.has(p.name)),
      blockers: blockers.filter(
        (b) => b.includes(normalizedTarget) || [...needed].some((n) => b.includes(n))
      ),
      ready: blockers.length === 0,
    }
  }

  return {
    order,
    packages,
    blockers,
    ready: blockers.length === 0,
  }
}

function printPlan(plan: PublishPlan, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }

  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║               Publish Dependency Analysis                     ║')
  console.log('╠══════════════════════════════════════════════════════════════╣')
  console.log(
    `║  Publish Order: ${plan.order
      .map((n) => n.replace('@skillsmith/', ''))
      .join(' → ')
      .padEnd(43)} ║`
  )
  console.log('╠══════════════════════════════════════════════════════════════╣')

  plan.packages.forEach((p) => {
    const status = p.hasUnpublishedChanges
      ? `${p.publishedVersion || 'unpublished'} → ${p.localVersion}`
      : 'up to date'
    const icon = p.canPublish ? '✓' : '✗'
    const shortName = p.name.replace('@skillsmith/', '')
    console.log(`║  ${icon} ${shortName.padEnd(15)} ${status.padEnd(30)} ║`)
  })

  console.log('╚══════════════════════════════════════════════════════════════╝')

  if (plan.blockers.length > 0) {
    console.error('\n⚠️  Blockers:')
    plan.blockers.forEach((b) => console.error(`  ✗ ${b}`))
  }

  if (plan.ready) {
    console.log('\n✓ Ready to publish in order:', plan.order.join(' → '))
  }
}

// CLI entry point
if (process.argv[1]?.includes('analyze-publish-deps')) {
  const args = process.argv.slice(2)
  const targetPackage = args.find((a) => a.startsWith('--package='))?.split('=')[1]
  const jsonOutput = args.includes('--json')

  try {
    const plan = analyzePublishDeps(targetPackage)
    printPlan(plan, jsonOutput)

    // GitHub Actions output
    if (process.env.GITHUB_OUTPUT) {
      const fs = await import('fs')
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `order=${JSON.stringify(plan.order)}\n`)
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_blockers=${plan.blockers.length > 0}\n`)
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `ready=${plan.ready}\n`)
    }

    process.exit(plan.ready ? 0 : 1)
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
