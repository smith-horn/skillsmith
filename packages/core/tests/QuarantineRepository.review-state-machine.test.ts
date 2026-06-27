/**
 * SMI-5358: QuarantineRepository — Human-Review State Machine Tests
 *
 * Focuses on the three-state review lifecycle (pending → approved | rejected)
 * and the isQuarantined gate that controls installability.
 *
 * Regression targets:
 *   - approve must clear isQuarantined (blocked if canImport logic regresses)
 *   - reject must keep isQuarantined=true (blocked if || vs && logic reintroduced)
 *   - persisted fields (reviewStatus, reviewedBy, reviewDate) must survive a
 *     round-trip through findById — not just reflect the in-memory return value
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from '../src/db/schema.js'
import { QuarantineRepository } from '../src/repositories/QuarantineRepository.js'
import type { QuarantineCreateInput } from '../src/repositories/QuarantineRepository.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<QuarantineCreateInput> = {}): QuarantineCreateInput {
  return {
    skillId: 'community/state-machine-skill',
    source: 'github',
    quarantineReason: 'Obfuscated code detected',
    severity: 'SUSPICIOUS',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('QuarantineRepository – review state machine', () => {
  let db: ReturnType<typeof createDatabase>
  let repo: QuarantineRepository

  beforeEach(() => {
    db = createDatabase(':memory:')
    repo = new QuarantineRepository(db)
  })

  afterEach(() => {
    if (db) closeDatabase(db)
  })

  // -------------------------------------------------------------------------
  // 1. Initial state after create
  // -------------------------------------------------------------------------

  describe('(1) create → pending', () => {
    it('entry is created with reviewStatus=pending', () => {
      const entry = repo.create(makeInput())

      // Re-read from DB to assert persisted state, not in-memory return
      const persisted = repo.findById(entry.id)
      expect(persisted).not.toBeNull()
      expect(persisted!.reviewStatus).toBe('pending')
    })

    it('isQuarantined is true immediately after create', () => {
      const skillId = 'community/fresh-quarantine'
      repo.create(makeInput({ skillId }))

      expect(repo.isQuarantined(skillId)).toBe(true)
    })

    it('reviewedBy and reviewDate are null on creation', () => {
      const entry = repo.create(makeInput())
      const persisted = repo.findById(entry.id)

      expect(persisted!.reviewedBy).toBeNull()
      expect(persisted!.reviewDate).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // 2. Approve path
  // -------------------------------------------------------------------------

  describe('(2) approve → isQuarantined false', () => {
    it('review() returns approved=true and canImport=true for RISKY (allowImport policy)', () => {
      // SUSPICIOUS/MALICIOUS have allowImport=false; use RISKY which has allowImport=true
      const entry = repo.create(
        makeInput({ severity: 'RISKY', quarantineReason: 'Uses deprecated APIs' })
      )

      const decision = repo.review(entry.id, {
        reviewedBy: 'security-team',
        reviewStatus: 'approved',
      })

      expect(decision).not.toBeNull()
      expect(decision!.approved).toBe(true)
      expect(decision!.canImport).toBe(true)
    })

    it('review() returns approved=true but canImport=false for SUSPICIOUS (allowImport=false policy)', () => {
      // SUSPICIOUS has allowImport=false — approval clears isQuarantined but import is still gated
      const entry = repo.create(makeInput({ severity: 'SUSPICIOUS' }))

      const decision = repo.review(entry.id, {
        reviewedBy: 'security-team',
        reviewStatus: 'approved',
      })

      expect(decision).not.toBeNull()
      expect(decision!.approved).toBe(true)
      expect(decision!.canImport).toBe(false)
    })

    it('persisted reviewStatus is approved after approve review', () => {
      const entry = repo.create(makeInput())

      repo.review(entry.id, {
        reviewedBy: 'security-team',
        reviewStatus: 'approved',
      })

      // Regression: if update() is bypassed, the DB row stays 'pending'
      const persisted = repo.findById(entry.id)
      expect(persisted!.reviewStatus).toBe('approved')
    })

    it('persisted reviewedBy is set after approve', () => {
      const entry = repo.create(makeInput())

      repo.review(entry.id, {
        reviewedBy: 'security-team',
        reviewStatus: 'approved',
      })

      const persisted = repo.findById(entry.id)
      expect(persisted!.reviewedBy).toBe('security-team')
    })

    it('persisted reviewDate is set after approve', () => {
      const entry = repo.create(makeInput())

      repo.review(entry.id, {
        reviewedBy: 'security-team',
        reviewStatus: 'approved',
      })

      const persisted = repo.findById(entry.id)
      // reviewDate must be a non-null ISO string — proves the DB column was written
      expect(persisted!.reviewDate).not.toBeNull()
      expect(typeof persisted!.reviewDate).toBe('string')
      expect(persisted!.reviewDate!.length).toBeGreaterThan(0)
    })

    it('isQuarantined is false after approve — REGRESSION GATE', () => {
      const skillId = 'community/approve-clears-quarantine'
      const entry = repo.create(makeInput({ skillId }))

      // Confirm it starts quarantined
      expect(repo.isQuarantined(skillId)).toBe(true)

      repo.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
      })

      // After approval, skill must be installable
      expect(repo.isQuarantined(skillId)).toBe(false)
    })

    it('optional reviewNotes are persisted on approval', () => {
      const entry = repo.create(makeInput())

      repo.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
        reviewNotes: 'Manual review confirmed safe',
      })

      const persisted = repo.findById(entry.id)
      expect(persisted!.reviewNotes).toBe('Manual review confirmed safe')
    })
  })

  // -------------------------------------------------------------------------
  // 3. Reject path
  // -------------------------------------------------------------------------

  describe('(3) reject → isQuarantined still true', () => {
    it('review() returns approved=false and canImport=false for rejected SUSPICIOUS', () => {
      const entry = repo.create(makeInput({ severity: 'SUSPICIOUS' }))

      const decision = repo.review(entry.id, {
        reviewedBy: 'security-team',
        reviewStatus: 'rejected',
        reviewNotes: 'Confirmed malicious obfuscation',
      })

      expect(decision).not.toBeNull()
      expect(decision!.approved).toBe(false)
      expect(decision!.canImport).toBe(false)
    })

    it('persisted reviewStatus is rejected after reject review', () => {
      const entry = repo.create(makeInput())

      repo.review(entry.id, {
        reviewedBy: 'security-team',
        reviewStatus: 'rejected',
      })

      const persisted = repo.findById(entry.id)
      expect(persisted!.reviewStatus).toBe('rejected')
    })

    it('persisted reviewedBy is set on rejection', () => {
      const entry = repo.create(makeInput())

      repo.review(entry.id, {
        reviewedBy: 'security-team',
        reviewStatus: 'rejected',
      })

      const persisted = repo.findById(entry.id)
      expect(persisted!.reviewedBy).toBe('security-team')
    })

    it('persisted reviewDate is set on rejection', () => {
      const entry = repo.create(makeInput())

      repo.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'rejected',
      })

      const persisted = repo.findById(entry.id)
      expect(persisted!.reviewDate).not.toBeNull()
    })

    it('isQuarantined remains true after rejection — REGRESSION GATE', () => {
      const skillId = 'community/reject-blocks-install'
      const entry = repo.create(makeInput({ skillId }))

      repo.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'rejected',
        reviewNotes: 'Confirmed threat',
      })

      // Rejected entry must still block installation
      expect(repo.isQuarantined(skillId)).toBe(true)
    })

    it('canImport is false for rejected RISKY (guards || vs && regression)', () => {
      // RISKY policy has allowImport=true; rejection must override that
      const entry = repo.create(
        makeInput({ severity: 'RISKY', quarantineReason: 'Deprecated APIs' })
      )

      const decision = repo.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'rejected',
      })

      // Bug: canImport = false || allowImport(true) = true  ← old broken logic
      // Fix: canImport = false && allowImport(true) = false ← correct
      expect(decision!.canImport).toBe(false)
      expect(repo.isQuarantined(entry.skillId)).toBe(true)
    })

    it('canImport is false for rejected LOW_QUALITY (guards || vs && regression)', () => {
      const entry = repo.create(
        makeInput({ severity: 'LOW_QUALITY', quarantineReason: 'Poor code quality' })
      )

      const decision = repo.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'rejected',
      })

      expect(decision!.canImport).toBe(false)
      expect(repo.isQuarantined(entry.skillId)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // 4. MALICIOUS severity — canImport false even when approved
  // -------------------------------------------------------------------------

  describe('(4) MALICIOUS policy — canImport always false', () => {
    it('canImport is false even when MALICIOUS entry is approved', () => {
      const entry = repo.create(
        makeInput({ severity: 'MALICIOUS', quarantineReason: 'Contains malware' })
      )

      const decision = repo.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
      })

      expect(decision!.approved).toBe(true)
      // Policy.allowImport=false for MALICIOUS — approval cannot override it
      expect(decision!.canImport).toBe(false)
    })

    it('isQuarantined is false after approving MALICIOUS (approved clears block)', () => {
      // The quarantine block is lifted on approval regardless of canImport policy;
      // canImport controls install permission separately.
      const skillId = 'community/malicious-approved'
      const entry = repo.create(
        makeInput({ skillId, severity: 'MALICIOUS', quarantineReason: 'Threat' })
      )

      repo.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
      })

      // isQuarantined reads reviewStatus; approved → false (the caller must then
      // check canImport to decide whether to install)
      expect(repo.isQuarantined(skillId)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // 5. Multiple entries — mixed review states
  // -------------------------------------------------------------------------

  describe('(5) multiple entries for the same skill', () => {
    it('skill stays quarantined when one entry is pending and another approved', () => {
      const skillId = 'community/mixed-entries'

      const first = repo.create(makeInput({ skillId, severity: 'LOW_QUALITY' }))
      repo.create(makeInput({ skillId, severity: 'SUSPICIOUS' })) // stays pending

      repo.review(first.id, {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
      })

      // Second entry is still pending → skill remains quarantined
      expect(repo.isQuarantined(skillId)).toBe(true)
    })

    it('skill is not quarantined once all entries are approved', () => {
      const skillId = 'community/all-approved'

      const a = repo.create(makeInput({ skillId, severity: 'LOW_QUALITY' }))
      const b = repo.create(makeInput({ skillId, severity: 'SUSPICIOUS' }))

      repo.review(a.id, { reviewedBy: 'admin', reviewStatus: 'approved' })
      repo.review(b.id, { reviewedBy: 'admin', reviewStatus: 'approved' })

      expect(repo.isQuarantined(skillId)).toBe(false)
    })

    it('one rejected entry keeps the skill quarantined', () => {
      const skillId = 'community/one-rejected'

      const a = repo.create(makeInput({ skillId, severity: 'LOW_QUALITY' }))
      const b = repo.create(makeInput({ skillId, severity: 'SUSPICIOUS' }))

      repo.review(a.id, { reviewedBy: 'admin', reviewStatus: 'approved' })
      repo.review(b.id, { reviewedBy: 'admin', reviewStatus: 'rejected' })

      expect(repo.isQuarantined(skillId)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // 6. review() on non-existent ID
  // -------------------------------------------------------------------------

  describe('(6) edge cases', () => {
    it('review() returns null for a non-existent entry id', () => {
      const decision = repo.review('does-not-exist', {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
      })

      expect(decision).toBeNull()
    })

    it('isQuarantined returns false for a skill with no entries', () => {
      expect(repo.isQuarantined('community/never-quarantined')).toBe(false)
    })
  })
})
