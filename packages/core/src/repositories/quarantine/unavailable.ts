/**
 * SMI-7260: what `QuarantineRepository` uses when its table is absent on a
 * read-only handle (see ../read-only-guard.ts). Reads report no quarantine
 * entries; every mutation throws the read-only refusal.
 *
 * The quarantine table is created lazily by the repository, not by the schema
 * or migrations, so a database the native driver created often lacks it. A
 * WASM search constructs this repository on every query, so it must not throw.
 */

import type { Database } from '../../db/database-interface.js'
import { absentTableStatement } from '../read-only-guard.js'
import type { PaginatedQuarantineResults, PreparedStatements, QuarantineStats } from './types.js'

export function absentQuarantineStatements(db: Database): PreparedStatements {
  const absent = absentTableStatement(db)
  return {
    insert: absent,
    selectById: absent,
    selectBySkillId: absent,
    selectAll: absent,
    selectCount: { get: () => ({ count: 0 }) },
    update: absent,
    delete: absent,
    deleteBySkillId: absent,
  } as unknown as PreparedStatements
}

export function emptyQuarantinePage(limit: number, offset: number): PaginatedQuarantineResults {
  return { items: [], total: 0, limit, offset, hasMore: false }
}

export function emptyQuarantineStats(): QuarantineStats {
  return {
    total: 0,
    bySeverity: {} as QuarantineStats['bySeverity'],
    byStatus: {} as QuarantineStats['byStatus'],
    pendingReview: 0,
    oldestEntry: null,
    newestEntry: null,
  }
}
