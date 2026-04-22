/**
 * SMI-4408: Indexer blocklist tests.
 *
 * Covers:
 *  - Exact-match blocking (owner/name, case-sensitive)
 *  - Non-blocklisted repos pass through
 *  - Empty/missing blocklist file returns EMPTY_BLOCKLIST (no-op)
 *  - Schema validation: version=1, required fields, valid repo format, valid dates
 *  - Duplicate entries rejected at load
 *  - Malformed JSON rejected at load
 *  - Ship-it sanity check: data/indexer-blocklist.json parses and contains
 *    the 2 known-bad entries from SMI-4396 Wave 2 residuals.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  buildBlocklist,
  EMPTY_BLOCKLIST,
  loadBlocklist,
  parseBlocklistFile,
} from '../../src/scripts/github-import/blocklist.js'
import type { BlocklistEntry } from '../../src/scripts/github-import/blocklist.js'

const VALID_ENTRY: BlocklistEntry = {
  repo: 'vinayaksavle/UploadDownloadPDF',
  reason: 'ASP.NET MVC tutorial, not a Claude skill',
  addedBy: 'ryansmith108',
  addedAt: '2026-04-21',
}

// ------------------------ matcher behavior ------------------------

describe('BlocklistMatcher (SMI-4408)', () => {
  it('blocks exact-match owner/name (case-sensitive)', () => {
    const matcher = buildBlocklist([VALID_ENTRY])
    expect(matcher.isBlocked('vinayaksavle/UploadDownloadPDF')).toBe(true)
  })

  it('does not block case-mismatched repo (exact match)', () => {
    const matcher = buildBlocklist([VALID_ENTRY])
    expect(matcher.isBlocked('vinayaksavle/uploaddownloadpdf')).toBe(false)
    expect(matcher.isBlocked('Vinayaksavle/UploadDownloadPDF')).toBe(false)
  })

  it('does not block non-blocklisted repos', () => {
    const matcher = buildBlocklist([VALID_ENTRY])
    expect(matcher.isBlocked('anthropics/skills')).toBe(false)
    expect(matcher.isBlocked('smith-horn/skill-image-pipeline')).toBe(false)
  })

  it('does not match partial strings (substring not allowed)', () => {
    const matcher = buildBlocklist([VALID_ENTRY])
    expect(matcher.isBlocked('vinayaksavle/UploadDownloadPDF-extra')).toBe(false)
    expect(matcher.isBlocked('other/vinayaksavle/UploadDownloadPDF')).toBe(false)
  })

  it('exposes entries() for audit-log output', () => {
    const matcher = buildBlocklist([VALID_ENTRY])
    const entries = matcher.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual(VALID_ENTRY)
  })

  it('EMPTY_BLOCKLIST blocks nothing', () => {
    expect(EMPTY_BLOCKLIST.isBlocked('anything/at-all')).toBe(false)
    expect(EMPTY_BLOCKLIST.entries()).toEqual([])
  })
})

// ------------------------ schema validation ------------------------

describe('parseBlocklistFile (SMI-4408)', () => {
  const validFile = {
    version: 1,
    updatedAt: '2026-04-21',
    blocked: [VALID_ENTRY],
  }

  it('parses a valid file', () => {
    const result = parseBlocklistFile(validFile)
    expect(result.version).toBe(1)
    expect(result.updatedAt).toBe('2026-04-21')
    expect(result.blocked).toHaveLength(1)
    expect(result.blocked[0]).toEqual(VALID_ENTRY)
  })

  it('rejects non-object root', () => {
    expect(() => parseBlocklistFile(null)).toThrow(/must be an object/i)
    expect(() => parseBlocklistFile('string')).toThrow(/must be an object/i)
    // Arrays pass typeof === 'object' but fail on missing `version` field.
    expect(() => parseBlocklistFile([])).toThrow(/unsupported blocklist file version/i)
  })

  it('rejects unsupported version', () => {
    expect(() => parseBlocklistFile({ ...validFile, version: 2 })).toThrow(
      /unsupported blocklist file version/i
    )
    expect(() => parseBlocklistFile({ ...validFile, version: 0 })).toThrow(
      /unsupported blocklist file version/i
    )
  })

  it('rejects invalid updatedAt', () => {
    expect(() => parseBlocklistFile({ ...validFile, updatedAt: '04/21/2026' })).toThrow(
      /updatedAt must be YYYY-MM-DD/i
    )
    expect(() => parseBlocklistFile({ ...validFile, updatedAt: 42 })).toThrow(
      /updatedAt must be YYYY-MM-DD/i
    )
  })

  it('rejects blocked field when not an array', () => {
    expect(() => parseBlocklistFile({ ...validFile, blocked: {} })).toThrow(
      /blocked must be an array/i
    )
  })

  it('rejects entry with missing required field', () => {
    for (const field of ['repo', 'reason', 'addedBy', 'addedAt']) {
      const badEntry = { ...VALID_ENTRY } as Record<string, unknown>
      delete badEntry[field]
      expect(() => parseBlocklistFile({ ...validFile, blocked: [badEntry] })).toThrow(
        new RegExp(`missing or empty required field: ${field}`, 'i')
      )
    }
  })

  it('rejects entry with empty required field', () => {
    expect(() =>
      parseBlocklistFile({ ...validFile, blocked: [{ ...VALID_ENTRY, reason: '' }] })
    ).toThrow(/missing or empty required field: reason/i)
  })

  it('rejects malformed repo string', () => {
    const bad = ['no-slash', '/leading', 'trailing/', 'too/many/slashes', 'has spaces/ok']
    for (const repo of bad) {
      expect(() =>
        parseBlocklistFile({ ...validFile, blocked: [{ ...VALID_ENTRY, repo }] })
      ).toThrow(/repo must be 'owner\/name'/i)
    }
  })

  it('accepts GitHub-valid repo names with common punctuation', () => {
    const good = ['foo/bar', 'foo-bar/baz.qux', 'Foo123/Bar_v2', 'org.name/repo-name']
    for (const repo of good) {
      expect(() =>
        parseBlocklistFile({ ...validFile, blocked: [{ ...VALID_ENTRY, repo }] })
      ).not.toThrow()
    }
  })

  it('rejects invalid addedAt format', () => {
    expect(() =>
      parseBlocklistFile({ ...validFile, blocked: [{ ...VALID_ENTRY, addedAt: 'yesterday' }] })
    ).toThrow(/addedAt must be YYYY-MM-DD/i)
  })

  it('rejects duplicate repo entries', () => {
    expect(() =>
      parseBlocklistFile({
        ...validFile,
        blocked: [VALID_ENTRY, { ...VALID_ENTRY, addedAt: '2026-04-22' }],
      })
    ).toThrow(/duplicate entry: vinayaksavle\/UploadDownloadPDF/i)
  })

  it('non-object entry rejected with index', () => {
    expect(() =>
      parseBlocklistFile({ ...validFile, blocked: [VALID_ENTRY, 'string-entry'] })
    ).toThrow(/entry #1 is not an object/i)
  })
})

// ------------------------ loadBlocklist ------------------------

describe('loadBlocklist (SMI-4408)', () => {
  it('returns EMPTY_BLOCKLIST when file is absent', () => {
    const tmp = path.join(os.tmpdir(), `blocklist-absent-${Date.now()}.json`)
    const matcher = loadBlocklist(tmp)
    expect(matcher).toBe(EMPTY_BLOCKLIST)
    expect(matcher.isBlocked('anything/at-all')).toBe(false)
  })

  it('throws on malformed JSON', () => {
    const tmp = path.join(os.tmpdir(), `blocklist-malformed-${Date.now()}.json`)
    fs.writeFileSync(tmp, '{ not valid json')
    try {
      expect(() => loadBlocklist(tmp)).toThrow(/is not valid JSON/i)
    } finally {
      fs.unlinkSync(tmp)
    }
  })

  it('throws on invalid schema', () => {
    const tmp = path.join(os.tmpdir(), `blocklist-invalid-${Date.now()}.json`)
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, updatedAt: '2026-04-21', blocked: [] }))
    try {
      expect(() => loadBlocklist(tmp)).toThrow(/unsupported blocklist file version/i)
    } finally {
      fs.unlinkSync(tmp)
    }
  })

  it('loads a valid file', () => {
    const tmp = path.join(os.tmpdir(), `blocklist-valid-${Date.now()}.json`)
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        version: 1,
        updatedAt: '2026-04-21',
        blocked: [VALID_ENTRY],
      })
    )
    try {
      const matcher = loadBlocklist(tmp)
      expect(matcher.isBlocked('vinayaksavle/UploadDownloadPDF')).toBe(true)
      expect(matcher.isBlocked('anthropics/skills')).toBe(false)
    } finally {
      fs.unlinkSync(tmp)
    }
  })
})

// ------------------------ ship-it sanity ------------------------

describe('data/indexer-blocklist.json (ship-it sanity)', () => {
  it('is parseable and contains the 2 SMI-4396 Wave 2 residuals', () => {
    const filePath = path.resolve(__dirname, '../../../../data/indexer-blocklist.json')
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const parsed = parseBlocklistFile(raw)
    expect(parsed.blocked.length).toBe(2)
    const repos = parsed.blocked.map((e) => e.repo).sort()
    expect(repos).toEqual(['Sfedfcv/redesigned-pancake', 'vinayaksavle/UploadDownloadPDF'].sort())
    // Each entry must carry a reason for audit trail.
    expect(parsed.blocked.every((e) => e.reason.length > 0)).toBe(true)
    expect(parsed.blocked.every((e) => e.addedBy.length > 0)).toBe(true)
  })
})
