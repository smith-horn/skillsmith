import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  writeSync,
  openSync,
  closeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSupabaseMigrationsAdapter, isLikelyEncrypted } from './supabase-migrations.js'
import type { AdapterContext } from '../types.js'
import type { CorpusConfig } from '../config.js'

function makeCtx(
  repoRoot: string,
  mode: 'full' | 'incremental',
  lastRunAt: string | null = null
): AdapterContext {
  const cfg: CorpusConfig = {
    storagePath: '.ruvector/store',
    metadataPath: '.ruvector/metadata.json',
    stateFile: '.ruvector/state.json',
    embeddingDim: 384,
    chunk: { targetTokens: 240, overlapTokens: 48, minTokens: 32 },
    globs: ['**/*.md'],
  }
  return { repoRoot, cfg, mode, lastSha: null, lastRunAt }
}

const PLAIN_SQL = `-- SMI-4051 — add device code auth schema
-- Migration: 081_device_code_auth.sql
-- Rationale: RFC 8628 device flow requires paired code/token tables
-- with TTL semantics. audit_logs has no user_id column — store the
-- user identifier inside metadata->>'user_id' to match idx_audit_logs_team_id.

CREATE TABLE IF NOT EXISTS device_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE audit_logs ADD COLUMN metadata JSONB;
`

let scratch: string
let migrations: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'supabase-migrations-'))
  migrations = join(scratch, 'supabase', 'migrations')
  mkdirSync(migrations, { recursive: true })
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warnSpy.mockRestore()
  rmSync(scratch, { recursive: true, force: true })
})

describe('isLikelyEncrypted', () => {
  it('returns true when file starts with git-crypt magic bytes', () => {
    const f = join(migrations, 'locked.sql')
    const fd = openSync(f, 'w')
    writeSync(fd, Buffer.from('\0GITCRYPT\0rest-of-ciphertext', 'binary'))
    closeSync(fd)
    expect(isLikelyEncrypted(f)).toBe(true)
  })

  it('returns false for ordinary UTF-8 SQL', () => {
    const f = join(migrations, 'plain.sql')
    writeFileSync(f, PLAIN_SQL)
    expect(isLikelyEncrypted(f)).toBe(false)
  })

  it('returns true on file read error (missing file)', () => {
    expect(isLikelyEncrypted(join(migrations, 'nope.sql'))).toBe(true)
  })
})

describe('supabase-migrations adapter — listFiles', () => {
  it('returns [] when directory does not exist', async () => {
    const adapter = createSupabaseMigrationsAdapter()
    rmSync(migrations, { recursive: true })
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files).toEqual([])
  })

  it('indexes *.sql files with repo-relative logicalPath', async () => {
    writeFileSync(join(migrations, '081_device_code_auth.sql'), PLAIN_SQL)
    const adapter = createSupabaseMigrationsAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files.length).toBe(1)
    expect(files[0].logicalPath).toBe('supabase/migrations/081_device_code_auth.sql')
    expect(files[0].rawContent).toContain('device_codes')
  })

  it('parses migration_number and tables_touched into tags', async () => {
    writeFileSync(join(migrations, '081_device_code_auth.sql'), PLAIN_SQL)
    const adapter = createSupabaseMigrationsAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files[0].tags?.source).toBe('supabase-migrations')
    expect(files[0].tags?.migration_number).toBe(81)
    expect(files[0].tags?.tables_touched).toBe('audit_logs,device_codes')
  })

  it('warns and returns [] when first file is git-crypt encrypted', async () => {
    const fd = openSync(join(migrations, '000_init.sql'), 'w')
    writeSync(fd, Buffer.from('\0GITCRYPT\0xyz', 'binary'))
    closeSync(fd)
    // A second plaintext file should also be skipped — the probe only
    // checks the first entry.
    writeFileSync(join(migrations, '001_next.sql'), PLAIN_SQL)

    const adapter = createSupabaseMigrationsAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('supabase-migrations: first file appears encrypted')
    )
  })

  it('skips files under 64 bytes', async () => {
    writeFileSync(join(migrations, '001_tiny.sql'), '-- stub\n')
    const adapter = createSupabaseMigrationsAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files).toEqual([])
  })

  it('incremental mtime filter', async () => {
    writeFileSync(join(migrations, '001_old.sql'), PLAIN_SQL)
    writeFileSync(join(migrations, '002_new.sql'), PLAIN_SQL)
    const oldTime = new Date(Date.now() - 10 * 60 * 1000)
    utimesSync(join(migrations, '001_old.sql'), oldTime, oldTime)
    const lastRunAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()

    const adapter = createSupabaseMigrationsAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'incremental', lastRunAt))
    expect(files.map((f) => f.logicalPath)).toEqual(['supabase/migrations/002_new.sql'])
  })
})

describe('supabase-migrations adapter — chunk', () => {
  it('produces one long-term `migration` chunk with hashed id', async () => {
    writeFileSync(join(migrations, '081_device_code_auth.sql'), PLAIN_SQL)
    const adapter = createSupabaseMigrationsAdapter()
    const ctx = makeCtx(scratch, 'full')
    const files = await adapter.listFiles(ctx)
    const chunks = await adapter.chunk(files[0], ctx)
    expect(chunks.length).toBe(1)
    expect(chunks[0].kind).toBe('migration')
    expect(chunks[0].lifetime).toBe('long-term')
    expect(chunks[0].filePath).toBe('supabase/migrations/081_device_code_auth.sql')
    expect(chunks[0].id).toMatch(
      /^supabase\/migrations\/081_device_code_auth\.sql#L\d+-L\d+@[0-9a-f]{16}$/
    )
    expect(chunks[0].text).toContain('audit_logs')
  })

  it('truncates oversize files to targetTokens worth of chars', async () => {
    const huge = PLAIN_SQL + '\n' + 'SELECT 1;\n'.repeat(5000)
    writeFileSync(join(migrations, '099_huge.sql'), huge)
    const adapter = createSupabaseMigrationsAdapter()
    const ctx = makeCtx(scratch, 'full')
    const files = await adapter.listFiles(ctx)
    const chunks = await adapter.chunk(files[0], ctx)
    expect(chunks.length).toBe(1)
    // targetTokens=240, char ratio=4 → max 960 chars
    expect(chunks[0].text.length).toBeLessThanOrEqual(960)
  })
})

describe('supabase-migrations adapter — listDeletedPaths', () => {
  it('returns [] (migrations are immutable history)', async () => {
    const adapter = createSupabaseMigrationsAdapter()
    const deleted = await adapter.listDeletedPaths(makeCtx(scratch, 'incremental'))
    expect(deleted).toEqual([])
  })
})
