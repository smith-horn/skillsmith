# Execution Plan: Coordinated npm Publish Pipeline (SMI-2230)

**Status**: Ready for Execution
**Linear Issue**: [SMI-2230](https://linear.app/smith-horn-group/issue/SMI-2230)
**Reviewed**: 2025-02-01 via plan-review-specialist
**Critical Issues Addressed**: 4/4

---

## Executive Summary

Implement coordinated npm publishing that prevents dependency mismatch incidents like `mcp-server@0.3.18` being published before `core@0.4.9` had the required exports.

### Key Changes from Implementation Plan

| Critical Issue | Resolution |
|----------------|------------|
| Hardcoded versions | Phase 0: Migrate to `workspace:*` protocol |
| Docker not integrated | Use existing `publish.yml` Docker pattern |
| Rollback infeasible | Replace with hotfix automation + `npm deprecate` |
| Duplicate validation | Merge into existing `pre-publish-check` job |

---

## Phase 0: Workspace Protocol Migration (PREREQUISITE)

**Must complete before any other phase.**

### Task 0.1: Update package.json files to use workspace:*

```bash
# packages/mcp-server/package.json
"dependencies": {
  "@skillsmith/core": "workspace:*"  # Was: "^0.4.9"
}

# packages/cli/package.json
"dependencies": {
  "@skillsmith/core": "workspace:*"  # Was: "^0.4.9"
}
```

### Task 0.2: Update npm scripts for workspace publishing

```json
// Root package.json
{
  "scripts": {
    "publish:dry-run": "npm publish --workspaces --dry-run",
    "publish:all": "npm publish --workspaces --access public"
  }
}
```

### Task 0.3: Verify workspace resolution

```bash
docker exec skillsmith-dev-1 npm ls @skillsmith/core
# Should show workspace: linked, not npm version
```

---

## Phase 1: Dependency Graph Analyzer

**Integrates with existing CI Docker pattern.**

### Task 1.1: Create `scripts/analyze-publish-deps.ts`

```typescript
#!/usr/bin/env npx tsx
/**
 * Dependency Graph Analyzer for Coordinated Publishing
 * SMI-2230: Detects unpublished workspace dependencies
 */

import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

interface PackageInfo {
  name: string
  version: string
  localVersion: string
  publishedVersion: string | null
  workspaceDeps: string[]
  hasUnpublishedChanges: boolean
  canPublish: boolean
}

interface PublishPlan {
  order: string[]  // Topological sort
  packages: PackageInfo[]
  blockers: string[]
}

const WORKSPACE_PACKAGES = [
  'packages/core',
  'packages/mcp-server',
  'packages/cli',
]

function getPublishedVersion(name: string): string | null {
  try {
    const result = execSync(`npm view ${name} version 2>/dev/null`, { encoding: 'utf-8' })
    return result.trim()
  } catch {
    return null // Not published yet
  }
}

function getLocalVersion(pkgPath: string): string {
  const pkg = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf-8'))
  return pkg.version
}

function getWorkspaceDeps(pkgPath: string): string[] {
  const pkg = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf-8'))
  const deps = { ...pkg.dependencies, ...pkg.peerDependencies }
  return Object.entries(deps)
    .filter(([, v]) => (v as string).startsWith('workspace:'))
    .map(([k]) => k)
}

function topologicalSort(packages: PackageInfo[]): string[] {
  const visited = new Set<string>()
  const result: string[] = []
  const pkgMap = new Map(packages.map(p => [p.name, p]))

  function visit(name: string) {
    if (visited.has(name)) return
    visited.add(name)
    const pkg = pkgMap.get(name)
    if (pkg) {
      pkg.workspaceDeps.forEach(dep => visit(dep))
      result.push(name)
    }
  }

  packages.forEach(p => visit(p.name))
  return result
}

export function analyzePublishDeps(targetPackage?: string): PublishPlan {
  const packages: PackageInfo[] = WORKSPACE_PACKAGES.map(path => {
    const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf-8'))
    const localVersion = getLocalVersion(path)
    const publishedVersion = getPublishedVersion(pkg.name)
    const workspaceDeps = getWorkspaceDeps(path)

    return {
      name: pkg.name,
      version: localVersion,
      localVersion,
      publishedVersion,
      workspaceDeps,
      hasUnpublishedChanges: localVersion !== publishedVersion,
      canPublish: true, // Will be updated below
    }
  })

  // Check if workspace deps are published
  const blockers: string[] = []
  packages.forEach(pkg => {
    pkg.workspaceDeps.forEach(depName => {
      const dep = packages.find(p => p.name === depName)
      if (dep?.hasUnpublishedChanges) {
        pkg.canPublish = false
        blockers.push(`${pkg.name} depends on unpublished ${depName}@${dep.localVersion}`)
      }
    })
  })

  const order = topologicalSort(packages)

  // Filter to target package and its deps if specified
  if (targetPackage && targetPackage !== 'all') {
    const targetIdx = order.indexOf(targetPackage)
    if (targetIdx === -1) {
      throw new Error(`Unknown package: ${targetPackage}`)
    }
    // Include target and all its dependencies
    const target = packages.find(p => p.name === targetPackage)!
    const needed = new Set([targetPackage, ...target.workspaceDeps])
    return {
      order: order.filter(name => needed.has(name)),
      packages: packages.filter(p => needed.has(p.name)),
      blockers: blockers.filter(b => b.includes(targetPackage)),
    }
  }

  return { order, packages, blockers }
}

// CLI entry point
if (process.argv[1]?.endsWith('analyze-publish-deps.ts')) {
  const targetPackage = process.argv.find(a => a.startsWith('--package='))?.split('=')[1]
  const plan = analyzePublishDeps(targetPackage)

  console.log('Publish Order:', plan.order.join(' → '))
  console.log('\nPackages:')
  plan.packages.forEach(p => {
    const status = p.hasUnpublishedChanges
      ? `${p.publishedVersion || 'unpublished'} → ${p.localVersion}`
      : 'up to date'
    console.log(`  ${p.name}: ${status} ${p.canPublish ? '✓' : '✗'}`)
  })

  if (plan.blockers.length > 0) {
    console.error('\nBlockers:')
    plan.blockers.forEach(b => console.error(`  ✗ ${b}`))
    process.exit(1)
  }

  // Output for GitHub Actions
  console.log(`\n::set-output name=plan::${JSON.stringify(plan.order)}`)
}
```

### Task 1.2: Add npm script

```json
// Root package.json
{
  "scripts": {
    "analyze:publish-deps": "npx tsx scripts/analyze-publish-deps.ts"
  }
}
```

---

## Phase 2: Smoke Test Runner

### Task 2.1: Create `scripts/smoke-test-published.ts`

```typescript
#!/usr/bin/env npx tsx
/**
 * Smoke Test for Published Packages
 * SMI-2230: Verifies published package works correctly
 */

import { execSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

interface SmokeTestResult {
  package: string
  version: string
  tests: {
    name: string
    passed: boolean
    error?: string
  }[]
  passed: boolean
}

export async function smokeTestPackage(packageName: string, version: string): Promise<SmokeTestResult> {
  const tests: SmokeTestResult['tests'] = []
  const tempDir = mkdtempSync(join(tmpdir(), 'smoke-test-'))

  try {
    // Test 1: Package installs
    try {
      execSync(`npm install ${packageName}@${version}`, {
        cwd: tempDir,
        stdio: 'pipe',
        timeout: 60000
      })
      tests.push({ name: 'install', passed: true })
    } catch (e) {
      tests.push({ name: 'install', passed: false, error: String(e) })
      return { package: packageName, version, tests, passed: false }
    }

    // Test 2: Package can be imported (for mcp-server, test CLI)
    if (packageName === '@skillsmith/mcp-server') {
      try {
        execSync(`npx -y ${packageName}@${version} --version`, {
          stdio: 'pipe',
          timeout: 30000
        })
        tests.push({ name: 'version-check', passed: true })
      } catch (e) {
        tests.push({ name: 'version-check', passed: false, error: String(e) })
      }
    }

    // Test 3: Core exports resolve
    if (packageName === '@skillsmith/core') {
      try {
        const testScript = `
          const core = require('${packageName}');
          if (!core.createDatabaseSync) throw new Error('Missing createDatabaseSync');
          if (!core.openDatabaseAsync) throw new Error('Missing openDatabaseAsync');
          console.log('Exports OK');
        `
        execSync(`node -e "${testScript}"`, {
          cwd: tempDir,
          stdio: 'pipe',
          timeout: 10000
        })
        tests.push({ name: 'exports', passed: true })
      } catch (e) {
        tests.push({ name: 'exports', passed: false, error: String(e) })
      }
    }

    return {
      package: packageName,
      version,
      tests,
      passed: tests.every(t => t.passed),
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

// CLI entry point
if (process.argv[1]?.endsWith('smoke-test-published.ts')) {
  const pkg = process.argv[2]
  const version = process.argv[3] || 'latest'

  if (!pkg) {
    console.error('Usage: smoke-test-published.ts <package> [version]')
    process.exit(1)
  }

  smokeTestPackage(pkg, version).then(result => {
    console.log(`\nSmoke Test: ${result.package}@${result.version}`)
    result.tests.forEach(t => {
      console.log(`  ${t.passed ? '✓' : '✗'} ${t.name}${t.error ? `: ${t.error}` : ''}`)
    })
    process.exit(result.passed ? 0 : 1)
  })
}
```

---

## Phase 3: Hotfix Automation (Replaces Rollback)

**Rationale**: npm unpublish only works within 72h and breaks dependent packages. Hotfix + deprecate is safer.

### Task 3.1: Create `scripts/hotfix-publish.ts`

```typescript
#!/usr/bin/env npx tsx
/**
 * Hotfix Publisher
 * SMI-2230: Automated hotfix for broken publishes
 *
 * Instead of unpublishing (breaks dependents), this:
 * 1. Deprecates the broken version
 * 2. Publishes a hotfix with incremented patch version
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

interface HotfixOptions {
  package: string
  brokenVersion: string
  reason: string
  dryRun?: boolean
}

function incrementPatch(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number)
  return `${major}.${minor}.${patch + 1}`
}

export function createHotfix(options: HotfixOptions): void {
  const { package: pkgName, brokenVersion, reason, dryRun } = options

  // Find package path
  const paths: Record<string, string> = {
    '@skillsmith/core': 'packages/core',
    '@skillsmith/mcp-server': 'packages/mcp-server',
    '@skillsmith/cli': 'packages/cli',
  }
  const pkgPath = paths[pkgName]
  if (!pkgPath) throw new Error(`Unknown package: ${pkgName}`)

  const pkgJsonPath = join(pkgPath, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))

  const hotfixVersion = incrementPatch(brokenVersion)

  console.log(`\nHotfix Plan for ${pkgName}:`)
  console.log(`  Deprecating: ${brokenVersion}`)
  console.log(`  Publishing:  ${hotfixVersion}`)
  console.log(`  Reason: ${reason}`)

  if (dryRun) {
    console.log('\n[DRY RUN] Would execute:')
    console.log(`  npm deprecate ${pkgName}@${brokenVersion} "${reason}"`)
    console.log(`  npm publish --access public (version ${hotfixVersion})`)
    return
  }

  // Step 1: Deprecate broken version
  console.log(`\nDeprecating ${pkgName}@${brokenVersion}...`)
  execSync(`npm deprecate ${pkgName}@${brokenVersion} "${reason}"`, { stdio: 'inherit' })

  // Step 2: Update version in package.json
  pkg.version = hotfixVersion
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n')

  // Step 3: Publish hotfix
  console.log(`\nPublishing ${pkgName}@${hotfixVersion}...`)
  execSync(`npm publish --access public`, { cwd: pkgPath, stdio: 'inherit' })

  console.log(`\n✓ Hotfix complete: ${pkgName}@${hotfixVersion}`)
}

// CLI entry point
if (process.argv[1]?.endsWith('hotfix-publish.ts')) {
  const args = process.argv.slice(2)
  const pkg = args.find(a => a.startsWith('--package='))?.split('=')[1]
  const version = args.find(a => a.startsWith('--version='))?.split('=')[1]
  const reason = args.find(a => a.startsWith('--reason='))?.split('=')[1]
  const dryRun = args.includes('--dry-run')

  if (!pkg || !version || !reason) {
    console.error('Usage: hotfix-publish.ts --package=<name> --version=<broken> --reason=<msg> [--dry-run]')
    process.exit(1)
  }

  createHotfix({ package: pkg, brokenVersion: version, reason, dryRun })
}
```

---

## Phase 4: GitHub Actions Integration

### Task 4.1: Update `.github/workflows/publish.yml`

**Merges into existing workflow, uses existing Docker pattern.**

```yaml
name: Publish Packages

on:
  workflow_dispatch:
    inputs:
      package:
        description: 'Package to publish (or "all" for coordinated)'
        required: true
        type: choice
        options:
          - '@skillsmith/core'
          - '@skillsmith/mcp-server'
          - '@skillsmith/cli'
          - 'all'
      dry_run:
        description: 'Dry run (no actual publish)'
        type: boolean
        default: true

jobs:
  analyze:
    runs-on: ubuntu-latest
    outputs:
      publish_order: ${{ steps.analyze.outputs.order }}
      has_blockers: ${{ steps.analyze.outputs.has_blockers }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: npm ci

      - name: Analyze publish dependencies
        id: analyze
        run: |
          OUTPUT=$(npx tsx scripts/analyze-publish-deps.ts --package=${{ inputs.package }})
          echo "$OUTPUT"

          # Extract order from output
          ORDER=$(echo "$OUTPUT" | grep "::set-output" | sed 's/.*:://' | cut -d'=' -f2)
          echo "order=$ORDER" >> $GITHUB_OUTPUT

          if echo "$OUTPUT" | grep -q "Blockers:"; then
            echo "has_blockers=true" >> $GITHUB_OUTPUT
          else
            echo "has_blockers=false" >> $GITHUB_OUTPUT
          fi

      - name: Fail on blockers
        if: steps.analyze.outputs.has_blockers == 'true'
        run: |
          echo "::error::Cannot publish - workspace dependencies have unpublished changes"
          exit 1

  publish:
    needs: analyze
    if: needs.analyze.outputs.has_blockers != 'true'
    runs-on: ubuntu-latest
    strategy:
      matrix:
        package: ${{ fromJson(needs.analyze.outputs.publish_order) }}
      max-parallel: 1  # Sequential publish in dependency order
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: npm ci

      - name: Build package
        run: npm run build -w ${{ matrix.package }}

      - name: Run tests
        run: npm test -w ${{ matrix.package }}

      - name: Publish to npm
        if: ${{ !inputs.dry_run }}
        run: npm publish --access public -w ${{ matrix.package }}
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Smoke test
        if: ${{ !inputs.dry_run }}
        run: |
          sleep 10  # Wait for npm propagation
          VERSION=$(npm view ${{ matrix.package }} version)
          npx tsx scripts/smoke-test-published.ts ${{ matrix.package }} $VERSION

  mcp-registry:
    needs: publish
    if: ${{ !inputs.dry_run && contains(needs.analyze.outputs.publish_order, 'mcp-server') }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Publish to MCP Registry
        run: |
          cd packages/mcp-server
          npx mcp-publisher publish
        env:
          MCP_REGISTRY_TOKEN: ${{ secrets.MCP_REGISTRY_TOKEN }}

      - name: Verify registry listing
        run: |
          sleep 30  # Wait for propagation
          VERSION=$(npm view @skillsmith/mcp-server version)
          REGISTRY_VERSION=$(curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=skillsmith" | jq -r '.servers[0].packages[0].version')
          if [ "$VERSION" != "$REGISTRY_VERSION" ]; then
            echo "::warning::MCP Registry version mismatch: npm=$VERSION, registry=$REGISTRY_VERSION"
          fi
```

---

## Phase 5: Version Sync Enhancement

**Merges into existing `pre-publish-check` job instead of duplicating.**

### Task 5.1: Create `scripts/validate-versions.ts`

```typescript
#!/usr/bin/env npx tsx
/**
 * Version Sync Validator
 * SMI-2230: Ensures package.json matches server.json for MCP server
 */

import { readFileSync } from 'fs'

interface ValidationResult {
  package: string
  packageJsonVersion: string
  serverJsonVersion?: string
  match: boolean
  error?: string
}

export function validateVersions(): ValidationResult[] {
  const results: ValidationResult[] = []

  // Check mcp-server package.json vs server.json
  try {
    const pkg = JSON.parse(readFileSync('packages/mcp-server/package.json', 'utf-8'))
    const server = JSON.parse(readFileSync('packages/mcp-server/server.json', 'utf-8'))

    const pkgVersion = pkg.version
    const serverVersion = server.version
    const serverPkgVersion = server.packages?.[0]?.version

    results.push({
      package: '@skillsmith/mcp-server',
      packageJsonVersion: pkgVersion,
      serverJsonVersion: serverVersion,
      match: pkgVersion === serverVersion && pkgVersion === serverPkgVersion,
      error: pkgVersion !== serverVersion
        ? `package.json (${pkgVersion}) != server.json (${serverVersion})`
        : pkgVersion !== serverPkgVersion
        ? `server.json version (${serverVersion}) != packages[0].version (${serverPkgVersion})`
        : undefined,
    })
  } catch (e) {
    results.push({
      package: '@skillsmith/mcp-server',
      packageJsonVersion: 'unknown',
      match: false,
      error: `Failed to read files: ${e}`,
    })
  }

  return results
}

// CLI entry point
if (process.argv[1]?.endsWith('validate-versions.ts')) {
  const results = validateVersions()
  let hasErrors = false

  results.forEach(r => {
    if (r.match) {
      console.log(`✓ ${r.package}: ${r.packageJsonVersion}`)
    } else {
      console.error(`✗ ${r.package}: ${r.error}`)
      hasErrors = true
    }
  })

  process.exit(hasErrors ? 1 : 0)
}
```

### Task 5.2: Add to pre-publish-check in CI

```yaml
# In .github/workflows/ci.yml, add to pre-publish-check job:
- name: Validate version sync
  run: npx tsx scripts/validate-versions.ts
```

---

## Execution Checklist

### Wave 1: Foundation
- [ ] Task 0.1: Update package.json files to use workspace:*
- [ ] Task 0.2: Update npm scripts for workspace publishing
- [ ] Task 0.3: Verify workspace resolution

### Wave 2: Analysis Scripts
- [ ] Task 1.1: Create `scripts/analyze-publish-deps.ts`
- [ ] Task 1.2: Add npm script

### Wave 3: Testing & Safety
- [ ] Task 2.1: Create `scripts/smoke-test-published.ts`
- [ ] Task 3.1: Create `scripts/hotfix-publish.ts`

### Wave 4: CI Integration
- [ ] Task 4.1: Update `.github/workflows/publish.yml`
- [ ] Task 5.1: Create `scripts/validate-versions.ts`
- [ ] Task 5.2: Add to pre-publish-check in CI

### Wave 5: Verification
- [ ] Test dry-run publish workflow
- [ ] Test smoke test on existing published packages
- [ ] Verify MCP Registry integration

---

## Success Criteria

1. **Zero dependency mismatch publishes**: Cannot publish package with unpublished workspace deps
2. **Automated smoke tests**: Every publish verified with basic functionality tests
3. **Hotfix capability**: Can quickly deprecate broken versions and publish fixes
4. **MCP Registry sync**: Registry always updated after npm publish

---

## References

- [Linear Issue SMI-2230](https://linear.app/smith-horn-group/issue/SMI-2230)
- [Implementation Plan](../implementation/smi-2230-coordinated-npm-publish-pipeline.md)
- [Plan Review Issues](../reviews/) (4 Critical addressed)
