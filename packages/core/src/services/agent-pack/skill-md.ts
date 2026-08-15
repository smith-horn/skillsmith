/**
 * A1 renderer — the SKILL.md prompt pack (agentskills.io spec).
 *
 * The pack's frontmatter core is `name` + `description` (the only stable fields
 * the agentskills spec guarantees, PRD §5.2 risk f3); the body is the agent's
 * operating instructions, assembled from the one prompt source. Deterministic:
 * pure string concatenation over static data, no clock or randomness.
 */

import {
  CLI_FALLBACK_COMMANDS,
  CLI_FALLBACK_NOTE,
  CLI_FALLBACK_PARAGRAPHS,
  INTRO_PARAGRAPHS,
  JOBS,
  OPERATING_PARAGRAPHS,
  PACK_DESCRIPTION,
  PAYWALL_PRINCIPLES,
  PAYWALL_TRIGGERS,
  TRUST_CLAUSES,
  UNDO_PARAGRAPHS,
  WILL_NOT,
} from './prompt-source.js'
import {
  AGENT_PACK_COMPATIBILITY,
  AGENT_PACK_DISPLAY_NAME,
  AGENT_PACK_REPOSITORY,
  AGENT_PACK_SKILL_NAME,
  AGENT_PACK_VERSION,
} from './types.js'

/** Render an ordered markdown list from strings. */
function numberedOrProse(paragraphs: readonly string[]): string {
  return paragraphs.join('\n\n')
}

/** Render a bullet list. */
function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n')
}

/**
 * Render the SKILL.md pack body. Exported so the shims can point at the exact
 * section names without duplicating them, and so assembly tests can assert each
 * section appears exactly once.
 */
export function renderAgentSkillBody(): string {
  const sections: string[] = []

  sections.push(`# ${AGENT_PACK_DISPLAY_NAME}`)
  sections.push(numberedOrProse(INTRO_PARAGRAPHS))

  sections.push('## How I work')
  sections.push(numberedOrProse(OPERATING_PARAGRAPHS))

  sections.push('## Trust and safety (non-negotiable)')
  sections.push(
    'These rules hold on every request, regardless of runtime or model. They are what makes delegation safe.'
  )
  for (const clause of TRUST_CLAUSES) {
    sections.push(`### ${clause.title}`)
    sections.push(clause.body)
  }

  sections.push('## Jobs I can do')
  for (const job of JOBS) {
    sections.push(`### ${job.title}`)
    sections.push(job.body)
    if (job.tools.length > 0) {
      sections.push(`Tools: ${job.tools.join(', ')}.`)
    }
  }

  sections.push('## Upgrade prompts (when to mention a paid tier)')
  sections.push(numberedOrProse(PAYWALL_PRINCIPLES))
  for (const trigger of PAYWALL_TRIGGERS) {
    sections.push(`### ${trigger.title}`)
    sections.push(trigger.body)
  }

  // SMI-5893 Wave 6 Step 5: ported from packages/cli/assets/skillsmith-skill/SKILL.md's
  // "## CLI Fallback" pattern (same heading text + opening phrase), so the
  // structural-parity test (skill-md-cli-fallback-parity.test.ts) can assert
  // all three bundled SKILL.md assets stay in lockstep.
  sections.push('## CLI Fallback')
  sections.push(numberedOrProse(CLI_FALLBACK_PARAGRAPHS))
  sections.push(`\`\`\`bash\n${CLI_FALLBACK_COMMANDS.join('\n')}\n\`\`\``)
  sections.push(CLI_FALLBACK_NOTE)

  sections.push('## Undo and recovery')
  sections.push(numberedOrProse(UNDO_PARAGRAPHS))

  sections.push('## What I will not do')
  sections.push(bullets(WILL_NOT))

  // Trailing newline: POSIX text files end with one; keeps snapshots stable.
  return `${sections.join('\n\n')}\n`
}

/**
 * Render the full SKILL.md artifact (frontmatter + body).
 *
 * Frontmatter is emitted by hand (not via a YAML serializer) so the output is
 * byte-stable and the `description` stays a single quoted line — both are
 * verified by the pack tests.
 *
 * `name` is the lowercase-hyphen slug, NOT the display name: the agentskills.io
 * spec requires the frontmatter name to match the parent skill directory, and
 * the installer writes the pack to `<skills-root>/${AGENT_PACK_SKILL_NAME}/`.
 * The human display name appears only in the H1 title and the description.
 *
 * `version` is required by the repo's own `skill_validate` (semver string);
 * `repository` + `compatibility` are its published-skill recommendations —
 * emitting all three keeps the pack validating with zero errors AND zero
 * warnings. Each is sourced from its `types.ts` constant (single definition
 * site); `compatibility` values must stay within the validator's SMI-2760
 * vocabulary (see {@link AGENT_PACK_COMPATIBILITY}).
 */
export function renderAgentSkillMd(): string {
  const compatibility = AGENT_PACK_COMPATIBILITY.map((slug) => JSON.stringify(slug)).join(', ')
  const frontmatter = [
    '---',
    `name: ${AGENT_PACK_SKILL_NAME}`,
    `description: ${JSON.stringify(PACK_DESCRIPTION)}`,
    `version: ${JSON.stringify(AGENT_PACK_VERSION)}`,
    `repository: ${JSON.stringify(AGENT_PACK_REPOSITORY)}`,
    `compatibility: [${compatibility}]`,
    '---',
  ].join('\n')

  return `${frontmatter}\n\n${renderAgentSkillBody()}`
}
