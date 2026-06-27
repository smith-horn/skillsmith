/**
 * @fileoverview `sklx audit sources` — skill source provenance recovery subcommand factory.
 * @module @skillsmith/cli/commands/audit-sources
 * @see SMI-5407
 *
 * Sibling of `sklx audit advisories` and `sklx audit collisions`.
 * Implementation lives in `audit-sources.action.ts` (SMI-5127+ split).
 *
 * Flags:
 *   [skillsRoot]            Optional positional: override the scan root
 *                           (default: ~/.claude/skills).
 *   --apply                 Write recovered sources to the manifest.
 *                           Dry-run when omitted.
 *   --yes                   Skip typed-confirmation gate (requires --apply).
 *   --set <pair...>         Override: dirName=owner/repo. Repeatable.
 *   --min-confidence <c>    Minimum confidence to backfill.
 *                           One of: exact|high|medium|low. Default: high.
 *   --json                  Emit JSON to stdout; no prompts; no file mutation.
 *   --embedding             Enable embedding tiebreak tier (off by default).
 *   --catalog-hint          Enable catalog / author hint tier (off by default).
 *   --write-frontmatter     Write repository: into non-git SKILL.md frontmatter.
 *                           Requires --force-write-frontmatter.
 *   --force-write-frontmatter  Confirm SKILL.md mutation (required with
 *                              --write-frontmatter). Prints a bold warning.
 *   -d, --db <path>         SQLite database path (default: ~/.skillsmith/skills.db).
 *
 * Community tier (no requireTier call). Read-only by default; --apply enables
 * the manifest write path.
 */

import { Command } from 'commander'
import { DEFAULT_DB_PATH } from '../config.js'
import { auditSourcesAction } from './audit-sources.action.js'

/**
 * Build the `audit sources` subcommand. Registered in `createAuditCommand()`
 * beside `advisories` and `collisions`.
 */
export function createAuditSourcesSubcommand(): Command {
  return new Command('sources')
    .description(
      'Recover the canonical GitHub source of locally-installed skills ' +
        'and optionally backfill ~/.skillsmith/manifest.json'
    )
    .argument('[skillsRoot]', 'Root directory to scan (default: ~/.claude/skills)')
    .option('--apply', 'Write recovered sources to the manifest (dry-run by default)', false)
    .option('--yes', 'Skip typed-confirmation phrase (requires --apply)', false)
    .option('--set <pair...>', 'Override source for a skill: dirName=owner/repo (repeatable)')
    .option('--min-confidence <c>', 'Minimum confidence to backfill: exact|high|medium|low', 'high')
    .option('--json', 'Emit JSON to stdout; no prompts; no file mutation', false)
    .option('--embedding', 'Enable embedding tiebreak tier (off by default)', false)
    .option('--catalog-hint', 'Enable catalog / author hint tier (off by default)', false)
    .option(
      '--write-frontmatter',
      'Write repository: into non-git SKILL.md frontmatter (requires --force-write-frontmatter)',
      false
    )
    .option(
      '--force-write-frontmatter',
      'Confirm SKILL.md mutation — required with --write-frontmatter (prints a bold warning)',
      false
    )
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .action(auditSourcesAction)
}

export default createAuditSourcesSubcommand
