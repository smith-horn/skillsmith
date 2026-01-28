#!/usr/bin/env npx tsx
/**
 * SMI-1900: Validate Supabase anonymous function configuration
 *
 * Ensures that:
 * 1. All anonymous functions in config.toml have verify_jwt = false
 * 2. CLAUDE.md documents all anonymous functions
 * 3. No anonymous function is missing from either location
 *
 * Run: npx tsx scripts/validate-anonymous-functions.ts
 * CI:  npm run validate:anonymous-functions
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const CONFIG_TOML_PATH = join(process.cwd(), 'supabase/config.toml')
const CLAUDE_MD_PATH = join(process.cwd(), 'CLAUDE.md')

// Canonical list of functions that MUST be anonymous (no JWT verification)
// Add new anonymous functions here when created
const ANONYMOUS_FUNCTIONS = [
  'early-access-signup',
  'contact-submit',
  'stats',
  'skills-search',
  'skills-get',
  'skills-recommend',
  'stripe-webhook',
  'checkout',
  'events',
] as const

interface ValidationResult {
  passed: boolean
  errors: string[]
  warnings: string[]
}

function parseConfigToml(content: string): Set<string> {
  const functions = new Set<string>()
  // Match [functions.name] followed by verify_jwt = false
  const regex = /\[functions\.([^\]]+)\]\s*\n\s*verify_jwt\s*=\s*false/g
  let match
  while ((match = regex.exec(content)) !== null) {
    functions.add(match[1])
  }
  return functions
}

function parseClaudeMd(content: string): Set<string> {
  const functions = new Set<string>()
  // Match: npx supabase functions deploy <name> --no-verify-jwt
  // Exclude placeholder examples like <function-name>
  const regex = /npx supabase functions deploy ([a-z][a-z0-9-]+) --no-verify-jwt/g
  let match
  while ((match = regex.exec(content)) !== null) {
    functions.add(match[1])
  }
  return functions
}

function validate(): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Read files
  let configToml: string
  let claudeMd: string

  try {
    configToml = readFileSync(CONFIG_TOML_PATH, 'utf-8')
  } catch {
    errors.push(`Cannot read ${CONFIG_TOML_PATH}`)
    return { passed: false, errors, warnings }
  }

  try {
    claudeMd = readFileSync(CLAUDE_MD_PATH, 'utf-8')
  } catch {
    errors.push(`Cannot read ${CLAUDE_MD_PATH}`)
    return { passed: false, errors, warnings }
  }

  // Parse both files
  const configFunctions = parseConfigToml(configToml)
  const docFunctions = parseClaudeMd(claudeMd)

  console.log('📋 Canonical anonymous functions:', ANONYMOUS_FUNCTIONS.length)
  console.log('📄 config.toml has:', configFunctions.size)
  console.log('📝 CLAUDE.md documents:', docFunctions.size)
  console.log('')

  // Check 1: All canonical functions are in config.toml
  for (const fn of ANONYMOUS_FUNCTIONS) {
    if (!configFunctions.has(fn)) {
      errors.push(`Missing from config.toml: [functions.${fn}] with verify_jwt = false`)
    }
  }

  // Check 2: All canonical functions are documented in CLAUDE.md
  for (const fn of ANONYMOUS_FUNCTIONS) {
    if (!docFunctions.has(fn)) {
      errors.push(`Missing from CLAUDE.md: npx supabase functions deploy ${fn} --no-verify-jwt`)
    }
  }

  // Check 3: Warn about undocumented functions in config.toml
  for (const fn of configFunctions) {
    if (!ANONYMOUS_FUNCTIONS.includes(fn as (typeof ANONYMOUS_FUNCTIONS)[number])) {
      warnings.push(
        `Function "${fn}" in config.toml but not in canonical list - add to ANONYMOUS_FUNCTIONS array`
      )
    }
  }

  // Check 4: Warn about undocumented functions in CLAUDE.md
  for (const fn of docFunctions) {
    if (!ANONYMOUS_FUNCTIONS.includes(fn as (typeof ANONYMOUS_FUNCTIONS)[number])) {
      warnings.push(
        `Function "${fn}" in CLAUDE.md but not in canonical list - add to ANONYMOUS_FUNCTIONS array`
      )
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  }
}

// Main
console.log('═'.repeat(60))
console.log('SMI-1900: Validating Supabase Anonymous Functions')
console.log('═'.repeat(60))
console.log('')

const result = validate()

if (result.warnings.length > 0) {
  console.log('⚠️  Warnings:')
  for (const warning of result.warnings) {
    console.log(`   ${warning}`)
  }
  console.log('')
}

if (result.errors.length > 0) {
  console.log('❌ Errors:')
  for (const error of result.errors) {
    console.log(`   ${error}`)
  }
  console.log('')
  console.log('To fix:')
  console.log('1. Add missing functions to supabase/config.toml:')
  console.log('   [functions.<name>]')
  console.log('   verify_jwt = false')
  console.log('')
  console.log('2. Add missing functions to CLAUDE.md anonymous functions section:')
  console.log('   npx supabase functions deploy <name> --no-verify-jwt')
  console.log('')
  console.log('3. Deploy with: npx supabase functions deploy <name> --no-verify-jwt')
  console.log('')
  process.exit(1)
}

console.log('✅ All anonymous functions properly configured!')
console.log('')
console.log('Remember: When deploying, ALWAYS use --no-verify-jwt flag:')
for (const fn of ANONYMOUS_FUNCTIONS) {
  console.log(`   npx supabase functions deploy ${fn} --no-verify-jwt`)
}
process.exit(0)
