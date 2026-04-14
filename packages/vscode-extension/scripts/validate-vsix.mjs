#!/usr/bin/env node

/**
 * Validates VSIX package contents before publishing.
 *
 * Usage: node scripts/validate-vsix.mjs [path-to-vsix]
 *
 * Checks:
 *   - No source or test files leaked into the package
 *   - Required artifacts exist (dist/extension.js, resources/, LICENSE)
 *   - Total size stays under the defined cap
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_VSIX_SIZE_MB = 5

const vsixPath = process.argv[2] || 'skillsmith.vsix'

if (!fs.existsSync(vsixPath)) {
  console.error(`ERROR: VSIX not found at "${vsixPath}"`)
  process.exit(1)
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-validate-'))

try {
  // --- Extract -----------------------------------------------------------
  execSync(`unzip -q -o "${path.resolve(vsixPath)}" -d "${tmpDir}"`)

  // Collect all file paths relative to tmpDir
  const allFiles = []
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel)
      } else {
        allFiles.push(rel)
      }
    }
  }
  walk(tmpDir, '')

  let failed = false

  const fail = (message) => {
    console.error(`FAIL: ${message}`)
    failed = true
  }

  // --- 1. No source or test files ----------------------------------------
  const forbidden = allFiles.filter((f) => /(?:^|\/)src\//.test(f) || /(?:^|\/)__tests__\//.test(f))
  if (forbidden.length > 0) {
    fail(
      `Source/test files found in VSIX (${forbidden.length}):\n` +
        forbidden.map((f) => `  ${f}`).join('\n')
    )
  }

  // --- 2. dist/extension.js exists ---------------------------------------
  if (!allFiles.includes('extension/dist/extension.js')) {
    fail('Missing extension/dist/extension.js')
  }

  // --- 3. resources/ directory exists ------------------------------------
  const hasResources = allFiles.some((f) => f.startsWith('extension/resources/'))
  if (!hasResources) {
    fail('Missing extension/resources/ directory')
  }

  // --- 3a. Walkthrough markdown files present ----------------------------
  // These are required for the Getting Started walkthrough declared in package.json.
  // If .vscodeignore drops them, VS Code renders blank walkthrough steps silently.
  const requiredWalkthrough = ['discover.md', 'install.md', 'create.md']
  for (const wf of requiredWalkthrough) {
    if (!allFiles.includes(`extension/resources/walkthrough/${wf}`)) {
      fail(`Missing walkthrough file: resources/walkthrough/${wf} — check .vscodeignore allowlist`)
    }
  }

  // --- 4. LICENSE file present -------------------------------------------
  const hasLicense = allFiles.some(
    (f) =>
      f === 'extension/LICENSE' ||
      f === 'extension/LICENSE.txt' ||
      f === 'LICENSE' ||
      f === 'LICENSE.txt'
  )
  if (!hasLicense) {
    fail('Missing LICENSE file (expected LICENSE or LICENSE.txt)')
  }

  // --- 5. Total size under cap -------------------------------------------
  const stats = fs.statSync(vsixPath)
  const sizeMB = stats.size / (1024 * 1024)
  if (sizeMB > MAX_VSIX_SIZE_MB) {
    fail(`VSIX size ${sizeMB.toFixed(2)} MB exceeds limit of ${MAX_VSIX_SIZE_MB} MB`)
  }

  // --- Summary -----------------------------------------------------------
  const sizeKB = (stats.size / 1024).toFixed(1)
  const topLevel = [...new Set(allFiles.map((f) => f.split('/')[0]))].sort()

  console.log(`\nVSIX Validation Summary`)
  console.log(`-----------------------`)
  console.log(`File:        ${vsixPath}`)
  console.log(`Files:       ${allFiles.length}`)
  console.log(`Size:        ${sizeKB} KB`)
  console.log(`Top-level:   ${topLevel.join(', ')}`)

  if (failed) {
    console.error('\nValidation FAILED — see errors above.')
    process.exit(1)
  }

  console.log('\nAll checks passed.')
} finally {
  // --- Cleanup -----------------------------------------------------------
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
