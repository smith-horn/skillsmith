#!/usr/bin/env npx tsx
/**
 * SMI-1179: Deploy Supabase Schema
 *
 * Deploys the skill registry schema to Supabase using the Management API.
 * This bypasses the need for direct database password by using the service role key.
 *
 * Usage:
 *   npx tsx scripts/supabase/deploy-schema.ts
 *
 * Requirements:
 *   - SUPABASE_ACCESS_TOKEN in .env
 *   - SUPABASE_PROJECT_REF in .env
 */

import * as fs from 'fs'
import * as path from 'path'

interface QueryResult {
  data?: unknown
  error?: { message: string; code?: string }
}

async function deploySchema(): Promise<void> {
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN
  const projectRef = process.env.SUPABASE_PROJECT_REF || 'vrcnzpmndtroqxxoqkzy'

  if (!accessToken) {
    console.error('Error: SUPABASE_ACCESS_TOKEN not set in environment')
    console.error('Get your token from: https://supabase.com/dashboard/account/tokens')
    process.exit(1)
  }

  const migrationPath = path.join(
    process.cwd(),
    'supabase/migrations/001_initial_schema.sql'
  )

  if (!fs.existsSync(migrationPath)) {
    console.error(`Error: Migration file not found: ${migrationPath}`)
    process.exit(1)
  }

  const migrationSql = fs.readFileSync(migrationPath, 'utf-8')

  console.log('🚀 Deploying Skillsmith schema to Supabase...')
  console.log(`   Project: ${projectRef}`)
  console.log(`   Migration: 001_initial_schema.sql`)

  // Split migration into smaller statements to handle via REST API
  const statements = splitSqlStatements(migrationSql)
  console.log(`   Statements: ${statements.length}`)

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!serviceRoleKey) {
    console.error('Error: SUPABASE_SERVICE_ROLE_KEY not set')
    console.error('This is required to run DDL statements')
    process.exit(1)
  }

  // For DDL operations, we need to use the SQL Query API
  const sqlApiUrl = `https://api.supabase.com/v1/projects/${projectRef}/database/query`

  console.log('\n📦 Executing migration statements...\n')

  let successCount = 0
  let errorCount = 0
  const errors: string[] = []

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i].trim()
    if (!stmt || stmt.startsWith('--')) continue

    const preview = stmt.substring(0, 60).replace(/\n/g, ' ')
    process.stdout.write(`   [${i + 1}/${statements.length}] ${preview}...`)

    try {
      const response = await fetch(sqlApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: stmt }),
      })

      const result = (await response.json()) as QueryResult

      if (response.ok && !result.error) {
        console.log(' ✓')
        successCount++
      } else {
        const errorMsg = result.error?.message || `HTTP ${response.status}`
        // Ignore "already exists" errors
        if (
          errorMsg.includes('already exists') ||
          errorMsg.includes('duplicate key') ||
          errorMsg.includes('relation') && errorMsg.includes('already')
        ) {
          console.log(' ⏭ (already exists)')
          successCount++
        } else {
          console.log(` ✗ ${errorMsg}`)
          errorCount++
          errors.push(`Statement ${i + 1}: ${errorMsg}`)
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.log(` ✗ ${msg}`)
      errorCount++
      errors.push(`Statement ${i + 1}: ${msg}`)
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`✅ Successful: ${successCount}`)
  console.log(`❌ Errors: ${errorCount}`)

  if (errors.length > 0) {
    console.log('\nErrors encountered:')
    errors.forEach((e) => console.log(`   - ${e}`))
  }

  if (errorCount > 0 && errorCount > successCount) {
    console.log('\n⚠️  Migration had significant errors.')
    console.log('   Try running manually via Supabase Dashboard → SQL Editor')
    process.exit(1)
  } else {
    console.log('\n🎉 Schema deployment complete!')
    console.log(`   Dashboard: https://supabase.com/dashboard/project/${projectRef}/editor`)
  }
}

/**
 * Split SQL into individual statements, handling:
 * - Multi-line strings
 * - Functions/triggers (BEGIN...END blocks)
 * - Comments
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inString = false
  let stringChar = ''
  let inDollarQuote = false
  let dollarTag = ''
  let depth = 0

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    const prev = sql[i - 1] || ''

    // Handle dollar-quoted strings ($$...$$)
    if (char === '$' && !inString) {
      const dollarMatch = sql.substring(i).match(/^(\$[^$]*\$)/)
      if (dollarMatch) {
        if (!inDollarQuote) {
          inDollarQuote = true
          dollarTag = dollarMatch[1]
          current += dollarTag
          i += dollarTag.length - 1
          continue
        } else if (sql.substring(i, i + dollarTag.length) === dollarTag) {
          inDollarQuote = false
          current += dollarTag
          i += dollarTag.length - 1
          continue
        }
      }
    }

    // Handle regular strings
    if ((char === "'" || char === '"') && !inDollarQuote && prev !== '\\') {
      if (!inString) {
        inString = true
        stringChar = char
      } else if (char === stringChar) {
        inString = false
      }
    }

    // Track BEGIN/END depth for function bodies
    if (!inString && !inDollarQuote) {
      const word = sql.substring(i, i + 5).toUpperCase()
      if (word === 'BEGIN') depth++
      if (sql.substring(i, i + 3).toUpperCase() === 'END' && depth > 0) depth--
    }

    current += char

    // Statement terminator
    if (char === ';' && !inString && !inDollarQuote && depth === 0) {
      const stmt = current.trim()
      if (stmt && stmt !== ';') {
        statements.push(stmt)
      }
      current = ''
    }
  }

  // Add any remaining statement
  if (current.trim()) {
    statements.push(current.trim())
  }

  return statements
}

// Load environment variables from .env
function loadEnv(): void {
  const envPath = path.join(process.cwd(), '.env')
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/)
      if (match) {
        const [, key, value] = match
        if (!process.env[key.trim()]) {
          process.env[key.trim()] = value.trim()
        }
      }
    }
  }
}

loadEnv()
deploySchema().catch(console.error)
