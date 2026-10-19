/**
 * @fileoverview `apply_manifest_reconcile` `verify` ledgers each verified entry
 * once, not once per run, when the manifest lock is lost once.
 * @see SMI-7143: a lost lock reruns the `updateSafely` callback once;
 *   `actuallyWritten` lives outside it and drives the ledger, so the callback
 *   resets it.
 *
 * Real caller, real manifest and ledger files (the sandboxed HOME, as in
 * `tests/unit/apply-manifest-reconcile.test.ts`); only the registry lookup is
 * mocked. The lost lock is forced by backdating `<manifest>.lock` by 26 s
 * during the FIRST read of the manifest made while the lock is held. A batch
 * verify of two matching entries then runs its locked callback twice, and the
 * ledger must still hold two entries.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const inject = vi.hoisted(() => ({
  target: null as string | null,
  lockedReads: 0,
  afterFirstLockedRead: null as (() => void) | null,
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const { existsSync } = await import('node:fs')
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args)
    if (
      inject.target !== null &&
      String(args[0]) === inject.target &&
      existsSync(`${inject.target}.lock`)
    ) {
      inject.lockedReads += 1
      if (inject.lockedReads === 1 && inject.afterFirstLockedRead) inject.afterFirstLockedRead()
    }
    return result
  }) as typeof actual.readFile
  return { ...actual, readFile, default: { ...actual, readFile } }
})

vi.mock('./install.helpers.js', () => ({
  lookupSkillFromRegistry: vi.fn(),
}))

import { lookupSkillFromRegistry } from './install.helpers.js'
import { hashContent } from './install.conflict-helpers.js'
import { SKILLSMITH_DIR, MANIFEST_PATH } from './install.types.js'
import type { SkillManifest, SkillManifestEntry } from './install.types.js'
import { applyManifestReconcile } from './apply-manifest-reconcile.js'
import type { ToolContext } from '../context.js'

const mockedLookup = vi.mocked(lookupSkillFromRegistry)
const LEDGER_PATH = path.join(SKILLSMITH_DIR, 'manifest-reconcile-ledger.json')
const NAMES = ['alpha', 'beta']

function content(name: string): string {
  return `---\nname: ${name}\n---\nbody of ${name}`
}

function plantEntry(name: string): SkillManifestEntry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `skillsmith-reconcile-retry-${name}-`))
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content(name), 'utf-8')
  const at = '2026-01-01T00:00:00.000Z'
  return {
    id: `author/${name}`,
    name,
    version: '1.0.0',
    source: `github:author/${name}`,
    installPath: dir,
    installedAt: at,
    lastUpdated: at,
  }
}

function readLedgerKeys(): string[] {
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8')) as {
    entries: Array<{ manifestKey: string }>
  }
  return ledger.entries.map((e) => e.manifestKey)
}

const context = { apiClient: { isOffline: () => false } } as unknown as ToolContext

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
  mockedLookup.mockReset()
  mockedLookup.mockImplementation(async (id: string) => {
    const name = id.split('/').pop() ?? ''
    return {
      repoUrl: `https://github.com/author/${name}`,
      name,
      trustTier: 'verified',
      contentHash: hashContent(content(name)),
    }
  })
  fs.mkdirSync(SKILLSMITH_DIR, { recursive: true })
  fs.rmSync(MANIFEST_PATH, { force: true })
  fs.rmSync(LEDGER_PATH, { force: true })
  const manifest: SkillManifest = {
    version: '1.0.0',
    installedSkills: Object.fromEntries(NAMES.map((n) => [n, plantEntry(n)])),
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8')
  inject.target = MANIFEST_PATH
  inject.lockedReads = 0
  inject.afterFirstLockedRead = null
})

afterEach(() => {
  inject.target = null
  inject.afterFirstLockedRead = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('apply_manifest_reconcile verify after one lost manifest lock (SMI-7143)', () => {
  it('POSITIVE CONTROL: without a lost lock, one locked read and one ledger entry per skill', async () => {
    const result = await applyManifestReconcile({ scope: 'global', action: 'verify' }, context)

    expect(result.success).toBe(true)
    expect(inject.lockedReads).toBe(1)
    expect(readLedgerKeys().sort()).toEqual(NAMES)
  })

  it('ledgers each verified skill once, not once per run', async () => {
    inject.afterFirstLockedRead = () => {
      const past = new Date(Date.now() - 26_000)
      fs.utimesSync(`${MANIFEST_PATH}.lock`, past, past)
    }

    const result = await applyManifestReconcile({ scope: 'global', action: 'verify' }, context)

    expect(result.success).toBe(true)
    expect(inject.lockedReads).toBe(2)
    expect(readLedgerKeys().sort()).toEqual(NAMES)
    const saved = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as SkillManifest
    for (const name of NAMES) expect(saved.installedSkills[name]?.verifiedAt).toBeTruthy()
  })
})
