#!/usr/bin/env node
/**
 * Governance Check Script
 * Verifies compliance with engineering standards from standards.md
 *
 * Usage: node governance-check.mjs [--fix]
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = join(__dirname, '../../../../')

const MAX_FILE_LINES = 500
const PACKAGES_DIR = join(ROOT, 'packages')

let errors = 0
let warnings = 0

function log(level, message, file = null) {
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '✅'
  const fileInfo = file ? ` (${relative(ROOT, file)})` : ''
  console.log(`${prefix} ${message}${fileInfo}`)
  if (level === 'error') errors++
  if (level === 'warn') warnings++
}

function checkFileLine(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n').length
    if (lines > MAX_FILE_LINES) {
      log('error', `File exceeds ${MAX_FILE_LINES} lines (${lines} lines)`, filePath)
      return false
    }
    return true
  } catch {
    return true
  }
}

function checkConsoleLog(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8')
    if (/console\.log\(/.test(content) && !filePath.includes('.test.')) {
      log('warn', 'Contains console.log statement', filePath)
      return false
    }
    return true
  } catch {
    return true
  }
}

function walkDir(dir, callback) {
  try {
    const files = readdirSync(dir)
    for (const file of files) {
      const filePath = join(dir, file)
      const stat = statSync(filePath)
      if (stat.isDirectory()) {
        if (!file.startsWith('.') && file !== 'node_modules' && file !== 'dist') {
          walkDir(filePath, callback)
        }
      } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
        callback(filePath)
      }
    }
  } catch {
    // Directory may not exist
  }
}

console.log('🔍 Running Governance Check...\n')

// Check all TypeScript files
walkDir(PACKAGES_DIR, (file) => {
  checkFileLine(file)
  checkConsoleLog(file)
})

console.log(`\n📊 Results: ${errors} errors, ${warnings} warnings`)

if (errors > 0) {
  console.log('\n❌ Governance check failed. Fix errors before committing.')
  process.exit(1)
} else if (warnings > 0) {
  console.log('\n⚠️ Governance check passed with warnings.')
  process.exit(0)
} else {
  console.log('\n✅ All governance checks passed!')
  process.exit(0)
}
