/**
 * SMI-744: Interactive Search Mode
 *
 * Provides interactive CLI for searching skills with filters and pagination.
 *
 * SMI-5127: Action implementation moved to search.action.ts.
 * This file retains only the commander factory function and re-exports.
 */

import { Command } from 'commander'
import { DEFAULT_DB_PATH } from '../config.js'
import { searchAction } from './search.action.js'

// Re-export types and formatters for backwards compatibility
export type { InteractiveSearchState, SearchPhase, SearchCommandOptions } from './search-types.js'
export { PAGE_SIZE } from './search-types.js'
export {
  TRUST_TIER_COLORS,
  formatSecurityStatus,
  formatSkillRow,
  displayResults,
  displaySkillDetails,
  getTrustTierColor,
} from './search-formatters.js'

/**
 * Create search command
 */
export function createSearchCommand(): Command {
  const cmd = new Command('search')
    .description(
      `Search for skills

Quality Score Formula:
  Quality scores (0-100%) reflect repository health using logarithmic scaling:
    Stars: log₁₀(stars + 1) × 15  (max 50 pts)
    Forks: log₁₀(forks + 1) × 10  (max 25 pts)
    Base:  25 pts (baseline)

  Example scores:
    ~48%  - 10 stars, 5 forks
    ~68%  - 100 stars, 20 forks
    ~86%  - 500 stars, 100 forks
    100%  - 10,000+ stars

  Verified skills from high-trust authors may have manually assigned scores.`
    )
    .argument(
      '[query]',
      'Search query (optional when using --tier, --category, or --min-score filters)'
    )
    .option('-i, --interactive', 'Launch interactive search mode')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .option('-l, --limit <number>', 'Maximum results to show', '20')
    .option(
      '-t, --tier <tier>',
      'Filter by trust tier (verified, curated, community, experimental, unknown, local)'
    )
    .option(
      '-c, --category <category>',
      'Filter by category (development, testing, devops, documentation, productivity, security)'
    )
    .option('-s, --min-score <number>', 'Minimum quality score (0-100, see above for formula)')
    // SMI-825: Security filters
    .option('--safe-only', 'Only show skills that passed security scan')
    .option('--max-risk <number>', 'Maximum risk score (0-100, lower is safer)')
    .action(searchAction)

  return cmd
}

export default createSearchCommand
