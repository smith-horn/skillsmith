/**
 * How a corruption probe's failure is classified (ADR-175 § 2, SMI-6946/6947).
 *
 * Pure and dependency-free so it can be tested directly against every code the
 * ADR names — including the ones no fixture on writable storage can produce.
 * That is deliberate: the classification is specified from SQLite's
 * documentation, so it is tested from the specification rather than from
 * reproduction. A branch that exists only because a fixture happened to reach
 * it is not a contract.
 *
 * **Matching is family-level, not exact-string.** better-sqlite3 exposes
 * *extended* result codes — its own docs give `SQLITE_CONSTRAINT_UNIQUE` as an
 * example — so an enumeration of primary names silently misfiles every extended
 * sibling. `SQLITE_BUSY_RECOVERY` and `SQLITE_BUSY_TIMEOUT` are busy results;
 * `SQLITE_CANTOPEN_ISDIR` is an operational fault. An earlier draft of this
 * contract enumerated exact names and misfiled all three.
 */

/**
 * What the probe established, which is not always "healthy or corrupt".
 *
 * - `corrupt` — a verdict. Refuse, and do not touch the file.
 * - `transient` — a lock, not a fact about the data. Retrying can still reach a
 *   verdict (wiring: ADR-175 § 3).
 * - `recovery-required` — the probe could not read the file *only because the
 *   recovery it needs requires write capability*. A read-write caller can
 *   recover and then be re-checked; a read-only caller cannot (ADR-175 § 4).
 * - `operational` — a fault about the environment, not the data. Propagate it
 *   unchanged; never relabel it as corruption.
 */
export type ProbeFailureClass = 'corrupt' | 'transient' | 'recovery-required' | 'operational'

/** True when `code` is `family` or one of its extended children. */
function inFamily(code: string, family: string): boolean {
  return code === family || code.startsWith(`${family}_`)
}

/**
 * The corruption family.
 *
 * `SQLITE_NOTADB` is included and is not a `SQLITE_CORRUPT_*` child: SQLite
 * returns it when the file "does not appear to be an SQLite database file",
 * which is the not-a-database case rather than a damaged one, but it is equally
 * a verdict about the file's contents.
 */
export function isCorruptionCode(code: string): boolean {
  return inFamily(code, 'SQLITE_CORRUPT') || inFamily(code, 'SQLITE_NOTADB')
}

/**
 * The read-only codes meaning "a recovery is needed and I may not perform it".
 *
 * Enumerated rather than matched as a family, because the `SQLITE_READONLY`
 * family is **not** uniform: `SQLITE_READONLY_DIRECTORY` and a bare
 * `SQLITE_READONLY` mean the caller simply cannot write, which is operational.
 * Only these four describe a pending recovery.
 */
const RECOVERY_REQUIRED_CODES: ReadonlySet<string> = new Set([
  'SQLITE_READONLY_RECOVERY',
  'SQLITE_READONLY_ROLLBACK',
  'SQLITE_READONLY_CANTLOCK',
  'SQLITE_READONLY_CANTINIT',
])

/**
 * Classify a thrown probe failure.
 *
 * Note what is **not** consulted: the filesystem. An earlier draft split
 * `SQLITE_CANTOPEN` on whether the path existed, which is both too coarse and a
 * time-of-check/time-of-use race — an existing path can be a directory
 * (`SQLITE_CANTOPEN_ISDIR`), a prohibited symlink, permission-denied, or
 * replaced between the check and the open. All of those are operational. The
 * useful question is which *code* fired, and every `SQLITE_CANTOPEN_*` is
 * operational.
 *
 * An error carrying no usable `code` is `operational`: unclassifiable is not
 * corruption, and refusing to open a user's database on an unrecognised fault
 * is the backwards direction of fail-closed.
 */
export function classifyProbeFailure(error: unknown): ProbeFailureClass {
  const raw = (error as { code?: unknown } | null | undefined)?.code
  if (typeof raw !== 'string' || raw.length === 0) return 'operational'

  if (isCorruptionCode(raw)) return 'corrupt'
  if (inFamily(raw, 'SQLITE_BUSY')) return 'transient'
  if (RECOVERY_REQUIRED_CODES.has(raw)) return 'recovery-required'
  return 'operational'
}

/**
 * Which recommended recovery framework a corruption verdict should offer.
 *
 * `SQLITE_CORRUPT_INDEX` is the one code SQLite names a repair for, and it
 * names it conditionally — `REINDEX` *might* resolve the problem "assuming no
 * other problems exist." The probe uses `quick_check(1)`, which stops at the
 * first reported problem, so it **cannot** establish that the index is the only
 * damage. `reindex` is therefore the narrower suggestion, not a promise, and
 * the rendered guidance ends in a re-check rather than in a fix.
 */
export function remedyKindFor(sqliteCode: string | undefined): 'reindex' | 'replace' {
  return sqliteCode === 'SQLITE_CORRUPT_INDEX' ? 'reindex' : 'replace'
}
