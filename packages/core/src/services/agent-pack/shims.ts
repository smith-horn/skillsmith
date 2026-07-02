/**
 * A2-A5 renderers — the per-harness named-agent shims.
 *
 * Every shim carries the SAME four things and nothing else: the agent name, a
 * one-line description, the curated tool references (the full profile passed
 * in), and a pointer into the SKILL.md pack that holds the actual operating
 * instructions. Shims are invocation sugar; they contain zero behavioral logic,
 * so if a harness spec drifts it breaks the sugar, never the behavior (PRD §5.2
 * risk f). The authoritative tool gating is server-side (the curated profile);
 * a shim's tool list is a reference, not the enforcement point.
 */

import { AGENT_PACK_DISPLAY_NAME, AGENT_PACK_SKILL_NAME } from './types.js'

/** Short one-liner for shim frontmatter (the SKILL.md carries the full one). ASCII only. */
export const SHIM_DESCRIPTION =
  'Named entry point for the Skillsmith Agent: delegate keeping your agent skills current, auditing your inventory, and vetting skills before install. Operating instructions live in the Skillsmith Agent skill pack.'

/**
 * The pointer body shared by every markdown shim. Plain prose, no runtime
 * logic. `harnessLabel` names the surface for readers of the file only.
 */
function pointerBody(harnessLabel: string): string {
  return [
    `This file is the ${harnessLabel} named-agent shim for the ${AGENT_PACK_DISPLAY_NAME}.`,
    '',
    `It carries no behavior of its own. The agent's operating instructions are the ${AGENT_PACK_DISPLAY_NAME} skill pack: the SKILL.md installed as \`${AGENT_PACK_SKILL_NAME}\`. Follow that skill: diagnose in full for free, propose a batched plan, and change files only with per-changeset approval, with one-step undo.`,
    '',
    'All capability, tier gating, and the safety split between diagnosing and changing files live in the Skillsmith MCP server, so they hold regardless of which runtime loaded this shim.',
  ].join('\n')
}

/** Render a comma-separated tool reference line from the profile. */
function toolCsv(toolProfile: readonly string[]): string {
  return toolProfile.join(', ')
}

/**
 * A2 — Claude-format agent markdown (`.claude/agents/*.md`). Read natively by
 * Claude Code, Cursor, and the Copilot VS Code surface.
 */
export function renderClaudeShim(toolProfile: readonly string[]): string {
  const frontmatter = [
    '---',
    `name: ${AGENT_PACK_SKILL_NAME}`,
    `description: ${JSON.stringify(SHIM_DESCRIPTION)}`,
    `tools: ${toolCsv(toolProfile)}`,
    '---',
  ].join('\n')
  return `${frontmatter}\n\n${pointerBody('Claude-format')}\n`
}

/**
 * A5 — Copilot `.agent.md` (Copilot cloud-agent + CLI surfaces, which do not
 * read `.claude/agents`).
 */
export function renderCopilotShim(toolProfile: readonly string[]): string {
  const frontmatter = [
    '---',
    `name: ${AGENT_PACK_SKILL_NAME}`,
    `description: ${JSON.stringify(SHIM_DESCRIPTION)}`,
    `tools: ${toolCsv(toolProfile)}`,
    '---',
  ].join('\n')
  return `${frontmatter}\n\n${pointerBody('Copilot')}\n`
}

/**
 * A4 — OpenCode agent markdown (OpenCode's own format).
 *
 * OpenCode's frontmatter `tools` field is a permission map, not a plain list;
 * setting it wrong would restrict tools rather than reference them, so the tool
 * references live in the body (a `Curated tools:` line) and the frontmatter
 * carries only `description` + `mode`. The server profile is the real gate.
 */
export function renderOpenCodeShim(toolProfile: readonly string[]): string {
  const frontmatter = [
    '---',
    `description: ${JSON.stringify(SHIM_DESCRIPTION)}`,
    'mode: subagent',
    '---',
  ].join('\n')
  const body = [pointerBody('OpenCode'), '', `Curated tools: ${toolCsv(toolProfile)}.`].join('\n')
  return `${frontmatter}\n\n${body}\n`
}

/**
 * A3 — Codex TOML `[agents]` entry. The one non-markdown shim. Strings are
 * emitted via `JSON.stringify`, which produces valid TOML basic strings for the
 * ASCII/UTF-8 text used here; the `tools` array is a TOML array of basic
 * strings. Verified to parse in the pack tests.
 */
export function renderCodexToml(toolProfile: readonly string[]): string {
  const toolsArray = toolProfile.map((name) => JSON.stringify(name)).join(', ')
  const instructions = `See the ${AGENT_PACK_DISPLAY_NAME} skill pack (SKILL.md installed as ${AGENT_PACK_SKILL_NAME}) for operating instructions. This entry carries no behavior of its own.`
  return [
    `# ${AGENT_PACK_DISPLAY_NAME} - Codex agent entry. Generated; do not edit by hand.`,
    `[agents.${AGENT_PACK_SKILL_NAME}]`,
    `description = ${JSON.stringify(SHIM_DESCRIPTION)}`,
    `instructions = ${JSON.stringify(instructions)}`,
    `tools = [${toolsArray}]`,
    '',
  ].join('\n')
}
