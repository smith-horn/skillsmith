/**
 * @fileoverview `sklx audit security` — local rug-pull / malicious-content scan
 *               + local acceptance allowlist for reviewed false positives.
 * @module @skillsmith/cli/commands/audit-security
 * @see SMI-5541 R0 Wave 2C (Option 1 — client-side continuous audit engine)
 * @see SMI-5883 Wave 2 — `--accept`/`--revoke`/candidate listing (SMI-5127
 *   sibling-split convention: this file keeps only the commander factory;
 *   action impls live in `audit-security.action.ts` / `.mutate.ts` / `.candidates.ts`).
 *
 * Sibling of `sklx audit collisions` / `sklx audit advisories`. Wraps the
 * shared `runSecurityAudit` helper from `@skillsmith/mcp-server/audit` so the
 * scan runs where the skill content actually lives — the user's machine.
 * Nothing leaves the device: the inventory data plane is metadata-only
 * (ADR-124), so a server-side scan is impossible; this is the audit engine.
 *
 * It reads each installed skill's content, scans it with `@skillsmith/core`'s
 * `SecurityScanner`, and — against a per-skill baseline persisted across runs
 * — reports rug-pulls (a benign→malicious update), currently-failing skills,
 * and material worsenings. A local acceptance store (`~/.skillsmith/audits/
 * security-acceptance.json`) lets a user mark a reviewed false positive as
 * accepted so it stops re-surfacing — WITHOUT ever affecting the separate
 * rug-pull detection path (`compareScanReports` never sees acceptance state).
 */

import { Command } from 'commander'

import { securityAction } from './audit-security.action.js'

/**
 * Build the `audit security` subcommand. Registered as a sibling of
 * `audit collisions` / `audit advisories` in `audit.ts`.
 */
export function createAuditSecuritySubcommand(): Command {
  return new Command('security')
    .description(
      "Scan each installed skill's SKILL.md for malicious content and rug-pull " +
        'updates (runs locally, no content leaves your machine; bundled scripts ' +
        'are not yet scanned)'
    )
    .option('--json', 'Emit the full result as JSON; no formatted output', false)
    .option(
      '--email',
      'Also email this digest to your account (requires `skillsmith login` and ' +
        'opt-in; consent is enforced server-side)',
      false
    )
    .option('--candidates', 'List candidate findings available to accept', false)
    .option('--limit <n>', 'Max candidates shown in human output (default 20)')
    .option('--page <n>', 'Candidate page number for --json (default 1)')
    .option('--page-size <n>', 'Candidates per --json page (default 200)')
    .option(
      '--all-candidates',
      'Emit the complete uncapped candidate array (requires --json)',
      false
    )
    .option(
      '--accept <key>',
      'Accept a candidate finding by its full 64-hex key (requires --reason)'
    )
    .option(
      '--reason <text>',
      'Required with --accept: why this finding is a reviewed false positive'
    )
    .option('--revoke <key>', 'Revoke a previously accepted finding by its full 64-hex key')
    .option('--list-accepted', 'List all currently stored acceptances', false)
    .action(securityAction)
}

// Internal exports for tests — sourced from the sibling action/mutate/candidates
// modules (SMI-5128 split).
export {
  runAuditSecurity,
  printFindings,
  pushDigest,
  printEmailOutcome,
  securityAction,
} from './audit-security.action.js'
export type {
  AuditSecurityOptions,
  AuditSecurityCliSeams,
  EmailOutcome,
} from './audit-security.types.js'
export {
  validateOptions,
  applyAcceptance,
  applyRevoke,
  printAcceptOutcome,
  printRevokeOutcome,
  printAcceptances,
} from './audit-security.mutate.js'
export type { ValidationCode, ValidationResult, MutationOutcome } from './audit-security.mutate.js'
export {
  compareCandidates,
  orderedCandidates,
  paginate,
  allCandidatesPagination,
  printCandidates,
} from './audit-security.candidates.js'
export type { Pagination } from './audit-security.candidates.js'

export default createAuditSecuritySubcommand
