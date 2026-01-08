#!/usr/bin/env npx tsx
/**
 * SMI-1179: Verify Supabase Schema
 *
 * Checks if the skill registry schema was deployed correctly.
 */

import * as fs from 'fs'
import * as path from 'path'

async function verifySchema(): Promise<void> {
  const projectRef = process.env.SUPABASE_PROJECT_REF || 'vrcnzpmndtroqxxoqkzy'
  const anonKey = process.env.SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  const apiKey = serviceKey || anonKey
  if (!apiKey) {
    console.error('Error: SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY not set')
    process.exit(1)
  }

  const baseUrl = `https://${projectRef}.supabase.co`

  console.log('🔍 Verifying Skillsmith schema on Supabase...')
  console.log(`   Project: ${projectRef}`)
  console.log(`   URL: ${baseUrl}\n`)

  // Check if skills table exists by trying to query it
  const expectedTables = [
    'skills',
    'sources',
    'categories',
    'skill_categories',
    'cache',
    'audit_logs',
    'schema_version',
  ]

  console.log('Checking tables...\n')

  for (const table of expectedTables) {
    try {
      const response = await fetch(`${baseUrl}/rest/v1/${table}?limit=1`, {
        headers: {
          apikey: apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
      })

      if (response.ok) {
        console.log(`   ✅ ${table}`)
      } else if (response.status === 404) {
        console.log(`   ❌ ${table} - NOT FOUND`)
      } else {
        const text = await response.text()
        console.log(`   ⚠️  ${table} - ${response.status}: ${text.substring(0, 50)}`)
      }
    } catch (error) {
      console.log(`   ❌ ${table} - ${error}`)
    }
  }

  // Check search function
  console.log('\nChecking functions...\n')

  try {
    const response = await fetch(`${baseUrl}/rest/v1/rpc/search_skills`, {
      method: 'POST',
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        search_query: 'test',
        limit_count: 1,
        offset_count: 0,
      }),
    })

    if (response.ok) {
      console.log('   ✅ search_skills function')
    } else {
      const text = await response.text()
      console.log(`   ⚠️  search_skills - ${response.status}: ${text.substring(0, 100)}`)
    }
  } catch (error) {
    console.log(`   ❌ search_skills - ${error}`)
  }

  try {
    const response = await fetch(`${baseUrl}/rest/v1/rpc/fuzzy_search_skills`, {
      method: 'POST',
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        search_query: 'test',
        similarity_threshold: 0.3,
        limit_count: 1,
      }),
    })

    if (response.ok) {
      console.log('   ✅ fuzzy_search_skills function')
    } else {
      const text = await response.text()
      console.log(`   ⚠️  fuzzy_search_skills - ${response.status}: ${text.substring(0, 100)}`)
    }
  } catch (error) {
    console.log(`   ❌ fuzzy_search_skills - ${error}`)
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('Verification complete!')
  console.log(`Dashboard: https://supabase.com/dashboard/project/${projectRef}/editor`)
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
verifySchema().catch(console.error)
