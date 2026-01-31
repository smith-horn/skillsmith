/**
 * SMI-1916: A/B Testing Command (Team+ tier feature)
 *
 * Runs controlled A/B tests comparing original vs optimized skills.
 * This feature is gated to Team and Enterprise tier users.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { tryLoadEnterpriseValidator } from '../utils/license-validation.js'
import { sanitizeError } from '../utils/sanitize.js'
import type { LicenseTier } from '../utils/license-types.js'

/**
 * Options for the ab-test command
 */
export interface AbTestOptions {
  skill: string | undefined
  iterations: number | undefined
  output: string | undefined
  json: boolean | undefined
}

/**
 * Result of checking A/B testing access
 */
interface AbTestAccessResult {
  allowed: boolean
  tier: LicenseTier
}

/**
 * Check if the current user has access to the A/B testing feature
 *
 * @returns Access result with tier information
 */
async function checkAbTestingAccess(): Promise<AbTestAccessResult> {
  const validator = await tryLoadEnterpriseValidator()

  if (!validator) {
    // Enterprise package not available = community tier
    return { allowed: false, tier: 'community' }
  }

  const licenseKey = process.env['SKILLSMITH_LICENSE_KEY']
  if (!licenseKey) {
    return { allowed: false, tier: 'community' }
  }

  try {
    const result = await validator.validate(licenseKey)
    if (!result.valid || !result.license) {
      return { allowed: false, tier: 'community' }
    }

    const tier = result.license.tier as LicenseTier
    // ab_testing is available for team and enterprise tiers
    const allowed = tier === 'team' || tier === 'enterprise'
    return { allowed, tier }
  } catch {
    return { allowed: false, tier: 'community' }
  }
}

/**
 * Display upgrade prompt for users without A/B testing access
 *
 * @param currentTier - The user's current tier
 */
function showUpgradePrompt(currentTier: LicenseTier): void {
  console.log()
  console.log(chalk.yellow('\u2501'.repeat(60)))
  console.log(chalk.yellow.bold('  A/B Testing requires Team tier or higher'))
  console.log(chalk.yellow('\u2501'.repeat(60)))
  console.log()
  console.log(chalk.dim(`  Current tier: ${currentTier}`))
  console.log()
  console.log('  ' + chalk.cyan('Team tier') + chalk.dim(' ($25/user/mo)'))
  console.log('    \u2022 A/B testing for skill optimization')
  console.log('    \u2022 Team workspaces & private skills')
  console.log('    \u2022 Usage analytics & priority support')
  console.log()
  console.log('  ' + chalk.magenta('Enterprise tier') + chalk.dim(' ($55/user/mo)'))
  console.log('    \u2022 Everything in Team, plus:')
  console.log('    \u2022 SSO/SAML, RBAC, audit logging')
  console.log('    \u2022 Private registry & custom integrations')
  console.log()
  console.log(chalk.bold('  Upgrade: ') + chalk.underline('https://skillsmith.app/pricing'))
  console.log()
}

/**
 * Display upgrade prompt as JSON for programmatic consumption
 *
 * @param currentTier - The user's current tier
 */
function showUpgradePromptJson(currentTier: LicenseTier): void {
  const response = {
    error: 'upgrade_required',
    message: 'A/B Testing requires Team tier or higher',
    currentTier,
    requiredTier: 'team',
    feature: 'ab_testing',
    upgradeUrl: 'https://skillsmith.app/pricing',
    tiers: {
      team: {
        price: '$25/user/mo',
        features: [
          'A/B testing for skill optimization',
          'Team workspaces & private skills',
          'Usage analytics & priority support',
        ],
      },
      enterprise: {
        price: '$55/user/mo',
        features: [
          'Everything in Team',
          'SSO/SAML, RBAC, audit logging',
          'Private registry & custom integrations',
        ],
      },
    },
  }
  console.log(JSON.stringify(response, null, 2))
}

/**
 * Run the A/B test experiment
 *
 * @param options - Test options
 */
export async function runAbTest(options: AbTestOptions): Promise<void> {
  const isJson = options.json ?? false

  // Feature gate check
  const { allowed, tier } = await checkAbTestingAccess()

  if (!allowed) {
    if (isJson) {
      showUpgradePromptJson(tier)
    } else {
      showUpgradePrompt(tier)
    }
    process.exit(1)
  }

  // Team/Enterprise: Proceed with A/B testing
  if (!isJson) {
    console.log()
    console.log(chalk.blue.bold('\u2501'.repeat(50)))
    console.log(chalk.blue.bold('  Skillsmith A/B Testing'))
    console.log(chalk.blue.bold('\u2501'.repeat(50)))
    console.log()
  }

  // Validate required options
  if (!options.skill) {
    if (isJson) {
      console.log(JSON.stringify({ error: 'Skill name is required. Use --skill <name>' }))
    } else {
      console.error(chalk.red('Error: Skill name is required. Use --skill <name>'))
    }
    process.exit(1)
  }

  const iterations = options.iterations ?? 10
  const outputDir = options.output ?? 'docs/research/ab-test'

  if (!isJson) {
    console.log(chalk.dim(`  Tier: ${tier}`))
    console.log(chalk.dim(`  Skill: ${options.skill}`))
    console.log(chalk.dim(`  Iterations: ${iterations}`))
    console.log(chalk.dim(`  Output: ${outputDir}`))
    console.log()
  }

  try {
    // A/B test runner implementation placeholder
    // The actual experiment runner will be implemented in a separate module
    // For now, provide guidance on manual execution
    if (isJson) {
      console.log(
        JSON.stringify({
          status: 'ready',
          message:
            'A/B test infrastructure ready. Use scripts/run-large-skill-experiments.ts for experiments.',
          skill: options.skill,
          iterations,
          outputDir,
          manualCommand: `docker exec skillsmith-dev-1 npx tsx scripts/run-large-skill-experiments.ts --skill ${options.skill} --iterations ${iterations}`,
        })
      )
    } else {
      console.log(chalk.green('A/B testing infrastructure is ready.'))
      console.log()
      console.log(chalk.dim('The A/B testing experiment will:'))
      console.log(chalk.dim('  1. Download original skill from the registry'))
      console.log(chalk.dim('  2. Apply Skillsmith transformations'))
      console.log(chalk.dim('  3. Run comparative benchmarks'))
      console.log(chalk.dim('  4. Generate detailed analysis report'))
      console.log()
      console.log(chalk.cyan('For manual execution, run:'))
      console.log(
        chalk.white(
          `  docker exec skillsmith-dev-1 npx tsx scripts/run-large-skill-experiments.ts --skill ${options.skill} --iterations ${iterations}`
        )
      )
    }

    if (!isJson) {
      console.log()
      console.log(chalk.dim('─'.repeat(50)))
      console.log(chalk.dim('Note: Full A/B test runner coming soon.'))
    }
  } catch (error) {
    if (isJson) {
      console.error(JSON.stringify({ error: sanitizeError(error) }))
    } else {
      console.error(chalk.red('A/B test failed:'), sanitizeError(error))
    }
    process.exit(1)
  }
}

/**
 * Create the ab-test command
 */
export function createAbTestCommand(): Command {
  const cmd = new Command('ab-test')
    .description('Run A/B testing experiments comparing original vs optimized skills (Team+ tier)')
    .option('-s, --skill <name>', 'Name of the skill to test')
    .option('-i, --iterations <number>', 'Number of test iterations', '10')
    .option('-o, --output <directory>', 'Output directory for results', 'docs/research/ab-test')
    .option('-j, --json', 'Output results as JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ skillsmith ab-test --skill governance
  $ skillsmith ab-test --skill commit --iterations 20
  $ skillsmith ab-test --skill react-best-practices --json

Note: This feature requires Team tier ($25/user/mo) or higher.
Visit https://skillsmith.app/pricing to upgrade.
`
    )
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      await runAbTest({
        skill: opts['skill'] as string | undefined,
        iterations: opts['iterations'] ? parseInt(opts['iterations'] as string, 10) : 10,
        output: opts['output'] as string | undefined,
        json: opts['json'] === true,
      })
    })

  return cmd
}

export default createAbTestCommand
