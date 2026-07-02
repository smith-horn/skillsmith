/**
 * Multi-target agent-pack generator (SMI-5456 Wave 1 Step 4).
 *
 * {@link generateAgentPack} renders every artifact of the portable Skillsmith
 * Agent pack from one prompt source + the curated tool profile:
 *   A1 SKILL.md pack, A2 Claude-format agent md, A3 Codex TOML entry,
 *   A4 OpenCode agent md, A5 Copilot .agent.md, A6 SessionStart/SessionEnd
 *   hooks per hook-capable harness.
 *
 * Output is deterministic (byte-identical for identical input) so snapshot and
 * drift tests can guard it. The generator NEVER touches the filesystem — the
 * generation script does that — and never imports `@skillsmith/mcp-server` (the
 * tool profile is injected, keeping the dependency direction clean).
 */

import { renderSessionEndHook, renderSessionStartHook } from './hooks.js'
import { JOBS } from './prompt-source.js'
import { renderAgentSkillMd } from './skill-md.js'
import {
  renderClaudeShim,
  renderCodexToml,
  renderCopilotShim,
  renderOpenCodeShim,
} from './shims.js'
import {
  AGENT_PACK_SKILL_NAME,
  HOOK_HARNESSES,
  type AgentPackArtifact,
  type AgentPackInput,
} from './types.js'

export * from './types.js'
export {
  INTRO_PARAGRAPHS,
  JOBS,
  PACK_DESCRIPTION,
  PAYWALL_TRIGGERS,
  TRUST_CLAUSES,
} from './prompt-source.js'
export { renderAgentSkillBody, renderAgentSkillMd } from './skill-md.js'
export {
  renderClaudeShim,
  renderCodexToml,
  renderCopilotShim,
  renderOpenCodeShim,
  SHIM_DESCRIPTION,
} from './shims.js'
export { renderSessionEndHook, renderSessionStartHook } from './hooks.js'

/**
 * Validate that every tool the prompt source references is a member of the
 * curated profile. This is the build-time guard behind the "tool references ⊆
 * the profile" invariant: a job that names a tool outside the profile is a bug
 * caught here, not shipped to a harness that would then call a tool it cannot
 * see.
 *
 * @throws Error when the profile is empty or a job references a non-member tool.
 */
function assertToolsInProfile(toolProfile: readonly string[]): void {
  if (toolProfile.length === 0) {
    throw new Error('generateAgentPack: toolProfile must be non-empty')
  }
  const profile = new Set(toolProfile)
  for (const job of JOBS) {
    for (const tool of job.tools) {
      if (!profile.has(tool)) {
        throw new Error(
          `generateAgentPack: job "${job.id}" references tool "${tool}" which is not in the curated profile`
        )
      }
    }
  }
}

/**
 * Generate the full agent pack. Paths are POSIX-relative to the pack root; the
 * installer (Step 5) maps each `harness`/`kind` to its on-disk destination.
 */
export function generateAgentPack(input: AgentPackInput): AgentPackArtifact[] {
  const { toolProfile } = input
  assertToolsInProfile(toolProfile)

  const artifacts: AgentPackArtifact[] = [
    {
      path: 'SKILL.md',
      content: renderAgentSkillMd(),
      kind: 'skill',
      harness: null,
      executable: false,
    },
    {
      path: `shims/claude/${AGENT_PACK_SKILL_NAME}.md`,
      content: renderClaudeShim(toolProfile),
      kind: 'shim',
      harness: 'claude-code',
      executable: false,
    },
    {
      path: 'shims/codex/agents.toml',
      content: renderCodexToml(toolProfile),
      kind: 'shim',
      harness: 'codex',
      executable: false,
    },
    {
      path: `shims/opencode/${AGENT_PACK_SKILL_NAME}.md`,
      content: renderOpenCodeShim(toolProfile),
      kind: 'shim',
      harness: 'opencode',
      executable: false,
    },
    {
      path: `shims/copilot/${AGENT_PACK_SKILL_NAME}.agent.md`,
      content: renderCopilotShim(toolProfile),
      kind: 'shim',
      harness: 'copilot',
      executable: false,
    },
  ]

  for (const harness of HOOK_HARNESSES) {
    artifacts.push({
      path: `hooks/${harness}/session-start.sh`,
      content: renderSessionStartHook(harness),
      kind: 'hook',
      harness,
      executable: true,
    })
    artifacts.push({
      path: `hooks/${harness}/session-end.sh`,
      content: renderSessionEndHook(harness),
      kind: 'hook',
      harness,
      executable: true,
    })
  }

  return artifacts
}
