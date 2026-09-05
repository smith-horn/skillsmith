/**
 * e2e-smi6362-analytics-fixtures.ts
 *
 * SMI-6362 — shared, pure (no DB/network I/O) fixture data for the cloud usage
 * analytics staging round-trip: user/team/consent-state definitions and the
 * k-anonymity expected-coverage calculator. Both
 * scripts/seed-e2e-smi6362-analytics-users.ts (writes these fixtures to
 * staging) and scripts/e2e-smi6362-analytics-roundtrip.ts (exercises the
 * write/read paths against them) import this module — single source of
 * truth so team-size/consent-state literals are never duplicated, and so
 * `computeExpectedCoverage()` mirrors the exact k=5 suppression ladder in
 * 20260905060000_cloud_usage_analytics_wiring.sql's
 * analytics_team_reporting_coverage() function.
 *
 * Fixture plan (see task spec for full rationale):
 *   - Team GEN-A (4 members): general write/read/isolation testing. A4 is
 *     undecided, so non_reporting=2 < k=5 -> coverage is 'qualitative'.
 *   - Team GEN-B (2 members): the "other team" for tenant-isolation negative
 *     tests. Both members enabled+decided -> non_reporting=0 < k=5 ->
 *     'qualitative' too (rev-4's fixed case: an all-consenting team must not
 *     leak exact counts either).
 *   - Five coverage-matrix teams (COV_4_0 / COV_5_0 / COV_5_1 / COV_10_5A /
 *     COV_10_5B) sized to exercise every branch of the suppression ladder.
 *     Members are drawn from three small SHARED pools (ENABLED_POOL /
 *     DISABLED_POOL / UNDECIDED_POOL) — consent state is a property of a
 *     user, not of a team membership, so the same person can sit in several
 *     coverage teams with one fixed global consent state, keeping the total
 *     fixture to 20 distinct users instead of 20+ per-team.
 */

export type ConsentState = 'enabled_decided' | 'disabled_decided' | 'undecided'

export interface FixtureUser {
  /** Short stable id used for cross-referencing in logs/assertions (e.g. 'A1'). */
  key: string
  email: string
  consent: ConsentState
}

// Throwaway staging-only test password, literal per task instructions ("this
// is throwaway staging test data, not a real secret requiring rotation
// infrastructure") — not a real credential, never used against prod.
export const E2E_PASSWORD = 'Smi6362-E2E-Analytics-Test-Pw!1'

// ============================================================================
// Users — Team GEN-A / Team GEN-B (dedicated identities; exercised directly
// by the write-path assertions, so kept distinct from the coverage pools).
// ============================================================================

export const USER_A1: FixtureUser = {
  key: 'A1',
  email: 'e2e-smi6362-a1@skillsmith.test',
  consent: 'enabled_decided',
}
export const USER_A2: FixtureUser = {
  key: 'A2',
  email: 'e2e-smi6362-a2@skillsmith.test',
  consent: 'enabled_decided',
}
export const USER_A3: FixtureUser = {
  key: 'A3',
  email: 'e2e-smi6362-a3@skillsmith.test',
  consent: 'disabled_decided',
}
export const USER_A4: FixtureUser = {
  key: 'A4',
  email: 'e2e-smi6362-a4@skillsmith.test',
  consent: 'undecided',
}
export const USER_B1: FixtureUser = {
  key: 'B1',
  email: 'e2e-smi6362-b1@skillsmith.test',
  consent: 'enabled_decided',
}
export const USER_B2: FixtureUser = {
  key: 'B2',
  email: 'e2e-smi6362-b2@skillsmith.test',
  consent: 'enabled_decided',
}

// ============================================================================
// Coverage-matrix pools — reused across the five COV_* teams. Pool sizes are
// the max count of that consent state needed within any SINGLE team (5 / 5 / 4
// respectively) — see the module docstring.
// ============================================================================

export const ENABLED_POOL: FixtureUser[] = [1, 2, 3, 4, 5].map((n) => ({
  key: `E${n}`,
  email: `e2e-smi6362-cov-e${n}@skillsmith.test`,
  consent: 'enabled_decided' as const,
}))
export const DISABLED_POOL: FixtureUser[] = [1, 2, 3, 4, 5].map((n) => ({
  key: `D${n}`,
  email: `e2e-smi6362-cov-d${n}@skillsmith.test`,
  consent: 'disabled_decided' as const,
}))
export const UNDECIDED_POOL: FixtureUser[] = [1, 2, 3, 4].map((n) => ({
  key: `U${n}`,
  email: `e2e-smi6362-cov-u${n}@skillsmith.test`,
  consent: 'undecided' as const,
}))

const [E1, E2, E3, E4, E5] = ENABLED_POOL
const [D1, D2, D3, D4, D5] = DISABLED_POOL
const [U1, U2, U3, U4] = UNDECIDED_POOL

export const ALL_USERS: FixtureUser[] = [
  USER_A1,
  USER_A2,
  USER_A3,
  USER_A4,
  USER_B1,
  USER_B2,
  ...ENABLED_POOL,
  ...DISABLED_POOL,
  ...UNDECIDED_POOL,
]

// ============================================================================
// Team specs
// ============================================================================

export interface TeamSpec {
  key: string
  /** Deterministic subscriptions.id — same idempotency key ensure_team_for_subscription() uses. */
  subscriptionId: string
  tier: 'team'
  seatCount: number
  /** The subscription owner — becomes team_members role='owner' via ensure_team_for_subscription(). */
  owner: FixtureUser
  /** Non-owner members, all role='member'. */
  extraMembers: FixtureUser[]
  /** Whether this team needs an active license_keys row (GEN-A / GEN-B only). */
  needsLicenseKey: boolean
}

export function teamAllMembers(spec: TeamSpec): FixtureUser[] {
  return [spec.owner, ...spec.extraMembers]
}

export const TEAM_GEN_A: TeamSpec = {
  key: 'GEN_A',
  subscriptionId: 'smi6362-gen-a-sub',
  tier: 'team',
  seatCount: 4,
  owner: USER_A1,
  extraMembers: [USER_A2, USER_A3, USER_A4],
  needsLicenseKey: true,
}

export const TEAM_GEN_B: TeamSpec = {
  key: 'GEN_B',
  subscriptionId: 'smi6362-gen-b-sub',
  tier: 'team',
  seatCount: 2,
  owner: USER_B1,
  extraMembers: [USER_B2],
  needsLicenseKey: true,
}

export const TEAM_COV_4_0: TeamSpec = {
  key: 'COV_4_0',
  subscriptionId: 'smi6362-cov-4-0-sub',
  tier: 'team',
  seatCount: 4,
  owner: E1,
  extraMembers: [E2, E3, E4],
  needsLicenseKey: false,
}

export const TEAM_COV_5_0: TeamSpec = {
  key: 'COV_5_0',
  subscriptionId: 'smi6362-cov-5-0-sub',
  tier: 'team',
  seatCount: 5,
  owner: E1,
  extraMembers: [E2, E3, E4, E5],
  needsLicenseKey: false,
}

export const TEAM_COV_5_1: TeamSpec = {
  key: 'COV_5_1',
  subscriptionId: 'smi6362-cov-5-1-sub',
  tier: 'team',
  seatCount: 5,
  owner: E1,
  extraMembers: [E2, E3, E4, D1],
  needsLicenseKey: false,
}

export const TEAM_COV_10_5A: TeamSpec = {
  key: 'COV_10_5A',
  subscriptionId: 'smi6362-cov-10-5a-sub',
  tier: 'team',
  seatCount: 10,
  owner: E1,
  extraMembers: [E2, E3, E4, E5, D1, D2, D3, D4, D5],
  needsLicenseKey: false,
}

export const TEAM_COV_10_5B: TeamSpec = {
  key: 'COV_10_5B',
  subscriptionId: 'smi6362-cov-10-5b-sub',
  tier: 'team',
  seatCount: 10,
  owner: E1,
  extraMembers: [E2, E3, E4, E5, D1, U1, U2, U3, U4],
  needsLicenseKey: false,
}

export const ALL_TEAMS: TeamSpec[] = [
  TEAM_GEN_A,
  TEAM_GEN_B,
  TEAM_COV_4_0,
  TEAM_COV_5_0,
  TEAM_COV_5_1,
  TEAM_COV_10_5A,
  TEAM_COV_10_5B,
]

// ============================================================================
// Expected-coverage calculator — mirrors
// analytics_team_reporting_coverage()'s k=5 suppression ladder exactly
// (20260905060000_cloud_usage_analytics_wiring.sql, rev-4: no non_reporting=0
// exemption). Deriving expectations from the SAME member-list source of truth
// used to seed the fixture (rather than hand-typed duplicate literals) means
// the two can never silently drift apart.
// ============================================================================

export interface ExpectedCoverage {
  level: 'full' | 'aggregate' | 'qualitative'
  totalSeats: number | null
  reportingSeats: number | null
  nonReportingSeats: number | null
  optedOutSeats: number | null
  undecidedSeats: number | null
}

const K = 5

export function computeExpectedCoverage(members: FixtureUser[]): ExpectedCoverage {
  const total = members.length
  const reporting = members.filter((m) => m.consent === 'enabled_decided').length
  const optedOut = members.filter((m) => m.consent === 'disabled_decided').length
  const undecided = members.filter((m) => m.consent === 'undecided').length
  const nonReporting = optedOut + undecided

  let level: ExpectedCoverage['level']
  if (
    reporting >= K &&
    nonReporting >= K &&
    (optedOut === 0 || optedOut >= K) &&
    (undecided === 0 || undecided >= K)
  ) {
    level = 'full'
  } else if (reporting >= K && nonReporting >= K) {
    level = 'aggregate'
  } else {
    level = 'qualitative'
  }

  if (level === 'qualitative') {
    return {
      level,
      totalSeats: null,
      reportingSeats: null,
      nonReportingSeats: null,
      optedOutSeats: null,
      undecidedSeats: null,
    }
  }
  if (level === 'aggregate') {
    return {
      level,
      totalSeats: total,
      reportingSeats: reporting,
      nonReportingSeats: nonReporting,
      optedOutSeats: null,
      undecidedSeats: null,
    }
  }
  return {
    level,
    totalSeats: total,
    reportingSeats: reporting,
    nonReportingSeats: nonReporting,
    optedOutSeats: optedOut,
    undecidedSeats: undecided,
  }
}
