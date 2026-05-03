/**
 * Migration Runner
 *
 * Extracted from schema.ts (SMI-3910) to keep schema.ts focused on
 * schema definition and database creation.
 *
 * Handles running pending migrations against the database, with
 * graceful handling of duplicate-column errors from migrations that
 * add columns already present in the initial schema.
 *
 * IMPORTANT: Uses db.exec(migration.sql) directly instead of splitting
 * by semicolon. Splitting breaks trigger bodies (e.g., FTS5 sync triggers).
 * See MEMORY.md "SCHEMA_SQL semicolon-split trap".
 */

import type { Database } from './database-interface.js'
import { MIGRATION_V2_SQL } from './migrations/v2-phase5-columns.js'
import { MIGRATION_V3_SQL } from './migrations/v3-sync-tables.js'
import { MIGRATION_V4_SQL } from './migrations/v4-security-columns.js'
import { MIGRATION_V5_SQL } from './migrations/v5-skill-versions.js'
import { MIGRATION_V5B_SQL } from './migrations/v5b-change-type.js'
import { MIGRATION_V6_SQL } from './migrations/v6-advisories.js'
import { MIGRATION_V7_SQL } from './migrations/v7-compatibility.js'
import { MIGRATION_V8_SQL } from './migrations/v8-co-installs.js'
import { MIGRATION_V10_SQL } from './migrations/v10-dependencies.js'
import { MIGRATION_V12_SQL } from './migrations/v12-risk-score-history.js'
import { MIGRATION_V13_SQL } from './migrations/v13-team-tables.js'
import { applyMigrationV16 } from './migrations/v16-skill-source.js'
import { SCHEMA_SQL, FTS5_MIGRATION_SQL } from './schema-sql.js'

/**
 * Migration definition for schema upgrades.
 *
 * A migration carries either a literal `sql` string OR an imperative `apply`
 * function for cases where the change cannot be expressed as a single
 * idempotent SQL blob (e.g. SMI-4665 v16 — SQLite cannot ALTER an existing
 * CHECK constraint, so the table must be recreated, but only when the column
 * is actually missing).
 */
export interface Migration {
  version: number
  description: string
  sql?: string
  apply?: (db: Database) => void
}

// Reserved: v14 (RBAC), v15 (integrations), v16 → SMI-4665

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema creation',
    sql: SCHEMA_SQL,
  },
  {
    version: 2,
    description: 'SMI-974: Add missing columns for Phase 5 imported databases',
    sql: MIGRATION_V2_SQL,
  },
  {
    version: 3,
    description: 'Registry sync tables for local-to-live synchronization',
    sql: MIGRATION_V3_SQL,
  },
  {
    version: 4,
    description: 'SMI-825: Add security scan columns to skills table',
    sql: MIGRATION_V4_SQL,
  },
  {
    version: 5,
    description: 'SMI-skill-version-tracking Wave 1: skill_versions table',
    sql: MIGRATION_V5_SQL,
  },
  {
    version: 6,
    description: 'SMI-skill-version-tracking Wave 2: add change_type to skill_versions',
    sql: MIGRATION_V5B_SQL,
  },
  {
    version: 7,
    description: 'SMI-skill-version-tracking Wave 3: skill_advisories table',
    sql: MIGRATION_V6_SQL,
  },
  {
    version: 8,
    description: 'SMI-2760: compatibility column on skills table',
    sql: MIGRATION_V7_SQL,
  },
  {
    version: 9,
    description: 'SMI-2761: skill_co_installs table for co-install recommendations',
    sql: MIGRATION_V8_SQL,
  },
  {
    version: 10,
    description: 'Skill dependency intelligence: skill_dependencies table',
    sql: MIGRATION_V10_SQL,
  },
  {
    version: 11,
    description: 'SMI-3510: content_hash column for tamper detection',
    sql: 'ALTER TABLE skills ADD COLUMN content_hash TEXT',
  },
  {
    version: 12,
    description: 'SMI-3864: risk_score_history table for trend detection',
    sql: MIGRATION_V12_SQL,
  },
  {
    version: 13,
    description: 'SMI-3896: visibility and team_id columns for private skills',
    sql: MIGRATION_V13_SQL,
  },
  {
    version: 16,
    description: "SMI-4665: source column + extend trust_tier CHECK to allow 'local'",
    apply: applyMigrationV16,
  },
]

/**
 * Get the current schema version from the database
 */
export function getSchemaVersion(db: Database): number {
  try {
    const result = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as
      | { version: number }
      | undefined
    return result?.version ?? 0
  } catch {
    return 0
  }
}

/**
 * Run pending migrations to upgrade the schema.
 *
 * Uses db.exec(migration.sql) directly — never splits by semicolon,
 * which would break trigger bodies. Duplicate-column errors are caught
 * at the full-SQL level.
 */
export function runMigrations(db: Database): number {
  const currentVersion = getSchemaVersion(db)
  let migrationsRun = 0

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      try {
        applyMigration(db, migration)
      } catch (error) {
        // Ignore "duplicate column" errors - column already exists from initial schema
        const msg = error instanceof Error ? error.message : String(error)
        if (!msg.includes('duplicate column')) {
          throw error
        }
      }
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
      migrationsRun++
    }
  }

  return migrationsRun
}

/**
 * Apply a single migration — either by executing its SQL or by calling its
 * imperative `apply` function. SMI-4665: certain migrations (e.g. v16 CHECK
 * constraint extension via table recreation) need imperative logic to remain
 * idempotent, so the runner accepts either form.
 */
function applyMigration(db: Database, migration: Migration): void {
  if (migration.apply) {
    migration.apply(db)
    return
  }
  if (migration.sql !== undefined) {
    db.exec(migration.sql)
    return
  }
  throw new Error(`Migration v${migration.version} has neither sql nor apply — invalid definition`)
}

/**
 * SMI-974: Run migrations with error handling for existing columns.
 *
 * Like runMigrations but wraps each migration in try/catch so a single
 * failure doesn't prevent subsequent migrations from running.
 */
export function runMigrationsSafe(db: Database): number {
  const currentVersion = getSchemaVersion(db)
  let migrationsRun = 0

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      try {
        try {
          applyMigration(db, migration)
        } catch (error) {
          // Ignore "duplicate column" errors - column already exists
          const msg = error instanceof Error ? error.message : String(error)
          if (!msg.includes('duplicate column')) {
            throw error
          }
        }
        // SMI-4665: only stamp schema_version after a successful apply. If
        // applyMigration threw a non-duplicate-column error we DO NOT advance
        // the version — the next run will retry. Guards against a v16 SQL
        // failure being silently masked.
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
        migrationsRun++
      } catch (error) {
        // Log but don't fail on migration errors
        console.warn(`Migration ${migration.version} failed:`, error)
      }
    }
  }

  // Try to create FTS5 table (may already exist)
  try {
    db.exec(FTS5_MIGRATION_SQL)
  } catch {
    // FTS5 may already exist or have issues - that's ok
  }

  return migrationsRun
}
