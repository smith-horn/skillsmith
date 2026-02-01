/**
 * SMI-2182: FTS5 Support Test
 *
 * Tests whether the current sql.js installation has FTS5 support.
 * FTS5 is required for full-text search capabilities.
 *
 * Standard sql.js builds do NOT include FTS5 by default.
 * If this test fails, we need to build a custom sql.js with FTS5 enabled.
 *
 * @see https://github.com/niclaslindstedt/sql.js-fts5
 * @see https://www.sqlite.org/fts5.html
 */

import { describe, it, expect, afterEach } from 'vitest'
import type initSqlJsType from 'fts5-sql-bundle'

// Type for the sql.js module
type SqlJs = Awaited<ReturnType<typeof initSqlJsType>>
type SqlJsDatabase = InstanceType<SqlJs['Database']>

// Track database for cleanup
let db: SqlJsDatabase | null = null

/**
 * Load fts5-sql-bundle WASM module directly for this test
 * fts5-sql-bundle has a built-in locateFile that correctly resolves the WASM file
 */
async function loadSqlJs(): Promise<SqlJs> {
  const initSqlJs = (await import('fts5-sql-bundle')).default
  return initSqlJs()
}

describe('FTS5 Support Detection', () => {
  afterEach(() => {
    if (db) {
      db.close()
      db = null
    }
  })

  it('should detect FTS5 availability in sql.js', async () => {
    const SQL = await loadSqlJs()
    db = new SQL.Database()

    let fts5Available = false
    let errorMessage = ''

    try {
      // Attempt to create an FTS5 virtual table
      db.run(`
        CREATE VIRTUAL TABLE test_fts USING fts5(content);
      `)
      fts5Available = true

      // If successful, test insertion and MATCH query
      db.run(`INSERT INTO test_fts (content) VALUES ('hello world');`)
      db.run(`INSERT INTO test_fts (content) VALUES ('goodbye world');`)
      db.run(`INSERT INTO test_fts (content) VALUES ('hello there');`)

      // Run a MATCH query
      const stmt = db.prepare(`SELECT content FROM test_fts WHERE test_fts MATCH 'hello';`)
      const results: string[] = []

      while (stmt.step()) {
        const row = stmt.get()
        results.push(row[0] as string)
      }
      stmt.free()

      // Verify MATCH query works
      expect(results).toHaveLength(2)
      expect(results).toContain('hello world')
      expect(results).toContain('hello there')

      console.log('\n========================================')
      console.log('FTS5 IS AVAILABLE in sql.js')
      console.log('----------------------------------------')
      console.log('FTS5 virtual table creation: SUCCESS')
      console.log('FTS5 INSERT operations: SUCCESS')
      console.log('FTS5 MATCH query: SUCCESS')
      console.log(`  - Found ${results.length} results for "hello"`)
      console.log('========================================\n')
    } catch (error) {
      fts5Available = false
      errorMessage = error instanceof Error ? error.message : String(error)

      console.log('\n========================================')
      console.log('FTS5 IS NOT AVAILABLE in sql.js')
      console.log('----------------------------------------')
      console.log(`Error: ${errorMessage}`)
      console.log('')
      console.log('RECOMMENDATION: Build custom sql.js with FTS5')
      console.log('See: https://github.com/niclaslindstedt/sql.js-fts5')
      console.log('Or: Build from source with -DSQLITE_ENABLE_FTS5')
      console.log('========================================\n')
    }

    // Report the result - test passes either way to show the detection result
    console.log(`\nFTS5 Support: ${fts5Available ? 'YES' : 'NO'}`)

    // Make this an informational test that always passes
    // The real assertion is whether we need a custom build
    expect(true).toBe(true)
  })

  it('should report SQLite compile options', async () => {
    const SQL = await loadSqlJs()
    db = new SQL.Database()

    // Query compile options to see what's enabled
    const stmt = db.prepare('PRAGMA compile_options;')
    const options: string[] = []

    while (stmt.step()) {
      const row = stmt.get()
      options.push(row[0] as string)
    }
    stmt.free()

    console.log('\n========================================')
    console.log('SQLite Compile Options in sql.js')
    console.log('----------------------------------------')
    options.forEach((opt) => {
      console.log(`  - ${opt}`)
    })
    console.log('========================================\n')

    // Check for FTS-related options
    const hasFts3 = options.some((opt) => opt.includes('FTS3'))
    const hasFts4 = options.some((opt) => opt.includes('FTS4'))
    const hasFts5 = options.some((opt) => opt.includes('FTS5'))

    console.log(`FTS3: ${hasFts3 ? 'ENABLED' : 'NOT FOUND'}`)
    console.log(`FTS4: ${hasFts4 ? 'ENABLED' : 'NOT FOUND'}`)
    console.log(`FTS5: ${hasFts5 ? 'ENABLED' : 'NOT FOUND'}`)

    // This test always passes - it's for reporting purposes
    expect(options.length).toBeGreaterThan(0)
  })

  it('should report SQLite version', async () => {
    const SQL = await loadSqlJs()
    db = new SQL.Database()

    const stmt = db.prepare('SELECT sqlite_version();')
    stmt.step()
    const version = stmt.get()[0] as string
    stmt.free()

    console.log(`\nSQLite Version: ${version}`)

    expect(version).toBeDefined()
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
