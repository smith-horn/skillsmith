/**
 * SMI-6276 (Wave 6 Step 1): per-client generation profile for companion
 * subagent files (`SubagentGenerator.ts`).
 *
 * `SubagentGenerator.generateSubagentContent()` predates multi-client support
 * entirely — it always emitted Claude-native tool names (`Read, Write, Bash,
 * WebFetch, Grep, Glob, WebSearch`) plus a `model: <haiku|sonnet|opus>`
 * frontmatter field, for every client `COMPANION_AGENT_TARGETS`
 * (`../install/paths.ts`) writes a companion-agent file for — including
 * clients whose own agent-definition format doesn't have a `tools:` or
 * `model:` concept, has one with entirely different value semantics, or (a
 * real, spec-documented failure mode for AntiGravity specifically — see
 * below) can HANG the subagent process on an unmapped tool name.
 *
 * This module is the exhaustive per-client answer, keyed on `ClientId`
 * (matching `COMPANION_AGENT_TARGETS`'s own key set, not the narrower
 * `HarnessId` — every `ClientId` gets a companion-agent file written
 * somewhere per `COMPANION_AGENT_TARGETS`, so every one needs a content
 * decision here too). For each client:
 *
 * 1. Which frontmatter fields it accepts (`includeSkillsField`,
 *    `toolsPolicy`, `modelPolicy`, `extraFrontmatterLines`).
 * 2. Its tool-identifier vocabulary and value SHAPE — `'claude-native'`
 *    (Skillsmith's internal tool names ARE that client's own names, emitted
 *    as a comma-separated scalar, no translation needed), `'mapped-array'`
 *    (the client has its OWN, confirmed-different tool vocabulary AND
 *    expects a YAML array rather than a scalar — translate through
 *    `toolNameMap`, silently drop any internal name with no confirmed
 *    mapping, and omit the field entirely if nothing maps), or `'omit'`
 *    (vocabulary not independently verified at all — never emit the field
 *    rather than guess a wrong value).
 * 3. Its model-selection policy — `'claude-enum'` (accepts Claude's
 *    `haiku|sonnet|opus` values directly) or `'omit'` (either no `model:`
 *    concept at all, or one with value semantics that don't line up with
 *    Skillsmith's internal enum — including a DIFFERENT PROVIDER's own
 *    model-tier vocabulary, which is a family swap, not just a renaming).
 *
 * Confidence levels (style follows `../install/agent-harness-targets.ts`'s
 * own header — HIGH/MEDIUM/LOW per client, dated citation, never asserted
 * past what the citation actually supports):
 *
 * - **claude-code** — HIGH. Claude Code's own native subagent format
 *   (`.claude/agents/*.md`): `name`, `description`, `tools` (comma-separated
 *   Claude tool names), `model`. This is this repo's pre-existing behavior
 *   (unchanged by this wave) and matches `renderClaudeShim()`
 *   (`agent-pack/shims.ts`), which uses the identical `name`/`description`/
 *   `tools` frontmatter shape for the fixed named-agent shim.
 * - **cursor** — HIGH, verified live against cursor.com/docs/subagents
 *   (fetched 2026-08-30): "Cursor recognizes subagent files across multiple
 *   directory formats: `.cursor/agents/` (Cursor format), `.claude/agents/`
 *   (Claude compatibility), `.codex/agents/` (Codex compatibility)."
 *   `COMPANION_AGENT_TARGETS.cursor` resolves to the SAME path as
 *   `claude-code` (`~/.claude/agents/<name>-specialist.md` — see that
 *   table's own comment: "Cursor 2.4+ reads `.claude/agents/` natively — no
 *   separate shim file"), so the file this generator actually writes for
 *   `--client cursor` is read by Cursor through that Claude-compatibility
 *   path and must carry genuine Claude-format frontmatter — this profile
 *   mirrors `claude-code`'s exactly (same object, not a coincidental
 *   duplicate). Cursor's OWN native `.cursor/agents/*.md` format is verified
 *   DIFFERENT (fields: `name`, `description`, `model` — values `inherit`,
 *   `fast`, or a hardcoded model ID, NOT Claude's `haiku|sonnet|opus` enum —
 *   `readonly`, `is_background`; explicitly NO `tools` field: "Subagents
 *   inherit all tools from the parent, including MCP tools from configured
 *   servers") but Skillsmith never writes to that native directory (no
 *   `.cursor/agents/` entry exists in `COMPANION_AGENT_TARGETS`), so that
 *   narrower native schema does not govern the file this generator produces.
 * - **antigravity** — HIGH for the schema itself, verified live against
 *   `antigravity.google/docs/subagents/` (fetched 2026-08-30, cross-checked
 *   by an independent WebSearch and by Wayback snapshots bracketing
 *   2026-08-06 through 2026-08-16 — see
 *   `docs/internal/implementation/smi-6276-subagent-true-antigravity-repro.md`
 *   for the full investigation, filed for the separate `subagent: true`
 *   question but covering this same schema). **Correction of SMI-5982's
 *   original sourcing**: that wave cited
 *   `antigravity.google/docs/cli/commands/agents` (the CLI `/agents` TUI
 *   command reference, whose example happens to show only `name`+
 *   `description`) as if it were the full schema. The real, richer schema
 *   lives at `/docs/subagents`: `name`, `description` (both required),
 *   `tools` (`string[]`, default `[]` — a YAML ARRAY, not a scalar, of
 *   AntiGravity's OWN tool names, e.g. `view_file`, `replace_file_content`,
 *   `grep_search`, `run_command` — confirmed DIFFERENT from Skillsmith's
 *   Claude-style names), `mainAgent`/`subagent` (booleans, both default
 *   `true` — the `subagent: true` question is Step 2's separate scope, not
 *   touched here), `model` (`inherit|flash|pro`, default `inherit` — NOT
 *   Claude's `haiku|sonnet|opus`), `commandExecutionPolicy`, `mcpServers`,
 *   `skills`/`plugins` (skill PATHS like `skills/my-helper-skill` — a
 *   DIFFERENT concept from Skillsmith's own `skills: <bare-name>` extension
 *   field below, not reused here for that reason).
 *
 *   MEDIUM for the specific tool-name MAPPING used here: the docs page only
 *   gives 4 example tool names (not a complete enumeration), so
 *   `toolNameMap` below covers only those 4, mapped by clear name
 *   correspondence (`view_file`→Read, `replace_file_content`→Write/Edit,
 *   `grep_search`→Grep, `run_command`→Bash); Skillsmith's `Glob`, `WebFetch`,
 *   and `WebSearch` have no confirmed AntiGravity equivalent and are
 *   silently dropped, never guessed. This is deliberately a `'mapped-array'`
 *   policy rather than `'omit'`, unlike every other unverified-vocabulary
 *   client in this table: AntiGravity's own schema documents `tools`
 *   defaulting to `[]` (empty) when omitted — the OPPOSITE of Cursor's
 *   "inherits from parent" or Copilot's "all tools available" defaults — so
 *   omitting the field here would ship a companion subagent with literally
 *   ZERO tool access, not a harmlessly-permissive default. A confidently-cited
 *   partial mapping is more correct than that, and strictly safer than
 *   guessing at unconfirmed names: the same docs page's own "Known Issue
 *   (Tool Validation)" warns that "specifying an unmapped or misspelled tool
 *   name in the `tools` list may cause the subagent process to hang during
 *   execution" — every name emitted here is a name AntiGravity's own docs
 *   use as a worked example, never an invented one.
 *
 *   `model:` is OMITTED for AntiGravity, not mapped — deliberately, not for
 *   lack of trying. AntiGravity's `flash`/`pro` are Gemini model tiers;
 *   Skillsmith's `haiku`/`sonnet`/`opus` are Claude model tiers. These are
 *   two DIFFERENT model families from two different vendors, not two
 *   spellings of the same capability scale — `haiku→flash` and `opus→pro`
 *   are plausible analogies, but `sonnet` (Skillsmith's own default "for
 *   balanced workloads", `determineModel()`) has no principled third rung to
 *   land on in a 2-tier scale, and no official source equates any Claude
 *   tier to any Gemini tier. Omitting the field uses AntiGravity's own
 *   documented default (`inherit` — defer to whatever tier the invoking
 *   session already uses), which is a real, working, spec-sanctioned value,
 *   not an absence of a decision.
 * - **copilot** — MEDIUM, verified live against GitHub's own docs
 *   (docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents,
 *   fetched 2026-08-30): `.agent.md` frontmatter DOES support a `tools` list
 *   (documented examples: `"read"`, `"edit"`, `"search"`) and a `model`
 *   field. NOT verified: a full mapping from Skillsmith's own 8-tool
 *   vocabulary (`Read`/`Write`/`Edit`/`Bash`/`Grep`/`Glob`/`WebFetch`/
 *   `WebSearch`) onto Copilot's identifier set — only 2-3 of the 8 have a
 *   plausible lowercase counterpart in the documented examples, with no
 *   confirmed equivalents for `Bash`/`Grep`/`Glob`/`WebFetch` specifically.
 *   Unlike AntiGravity, Copilot's own docs confirm omission is SAFE here —
 *   "Omitting tools grants access to all available tools — the default is
 *   permissive" — so, per this wave's fallback rule, omit `tools:` rather
 *   than emit a guessed-wrong partial mapping; the omission doesn't cripple
 *   the subagent the way it would for AntiGravity. `model:` is likewise
 *   omitted — its value format (Copilot's own model catalog IDs) has no
 *   confirmed correspondence to Skillsmith's internal `haiku|sonnet|opus`
 *   abstraction.
 * - **opencode** — MEDIUM, verified live against opencode.ai/v2/docs/agents/
 *   (fetched 2026-08-30): confirmed frontmatter fields `description`, `mode`
 *   (`primary|subagent|all`), `model` (`provider/model#variant` format — NOT
 *   Claude's `haiku|sonnet|opus` enum), `color`, `steps`, `permissions`. This
 *   repo's own `renderOpenCodeShim()` (`agent-pack/shims.ts`) already
 *   documents the load-bearing fact this profile reuses: "OpenCode's
 *   frontmatter `tools` field is a permission map, not a plain list; setting
 *   it wrong would restrict tools rather than reference them" — same
 *   precedent applied here, omitting `tools:` rather than writing a
 *   Claude-shaped value into a boolean-permission-map field (a different,
 *   harder mapping problem than AntiGravity's plain array — not attempted in
 *   this wave). `mode: subagent` IS included (HIGH confidence for this one
 *   line specifically — mirrors the already-shipped `renderOpenCodeShim()`
 *   verbatim). `model:` omitted — no confirmed mapping from Skillsmith's
 *   internal enum to OpenCode's `provider/model` format.
 * - **windsurf** — LOW. No independently confirmed per-subagent-file
 *   frontmatter schema for tool/model restriction was found; Windsurf's
 *   Cascade agent runtime is additionally documented as being retired (EOL
 *   2026-07-01, superseded by Devin Local). Omit `tools:` and `model:`,
 *   matching this table's existing conservative default for windsurf
 *   (`COMPANION_AGENT_TARGETS.windsurf`'s own comment: "No
 *   `AGENT_SHIM_TARGETS` entry exists for windsurf ... defaults to today's
 *   actual behavior" — that comment covers the file PATH only; this module
 *   makes the equivalent conservative call for the file's CONTENT).
 * - **agents** — LOW. This `ClientId` is the generic cross-agent /
 *   `AGENTS.md` convention (also Codex's install target — "Codex: reads
 *   ONLY `~/.agents/skills`", `../install/paths.ts`'s own header comment).
 *   The `AGENTS.md` standard itself has no required fields and no YAML
 *   frontmatter for its single project-instructions file (openai/codex's own
 *   `AGENTS.md`; agents.md spec) — there is no confirmed per-agent-definition
 *   file schema with tool/model fields for this identifier at all. Omit
 *   `tools:` and `model:`.
 * - **hermes** — LOW. Hermes's own documented frontmatter
 *   (hermes-agent.nousresearch.com/docs/) is for SKILL files (`name`,
 *   `description`, `version`, `author`, `platforms`), not a separate
 *   subagent-definition schema with tool/model restriction fields. Omit
 *   `tools:` and `model:`.
 * - **grok** — LOW. Grok Build (docs.x.ai/build/overview,
 *   github.com/xai-org/grok-build) confirms agent frontmatter EXISTS
 *   ("Subagents can declare their own `mcpServers` in agent frontmatter") but
 *   no built-in tool-identifier vocabulary or Claude-comparable model enum is
 *   documented. Omit `tools:` and `model:`.
 *
 * @see docs/internal/implementation/cursor-antigravity-tier-parity-plan.md (Wave 6 Step 1)
 * @see docs/internal/implementation/smi-6276-subagent-true-antigravity-repro.md (AntiGravity schema source-of-truth)
 */

import { CANONICAL_CLIENT, type ClientId } from '../install/paths.js'

/**
 * `'claude-native'` — Skillsmith's internal tool names (`Read`, `Write`,
 * `Edit`, `Bash`, `Grep`, `Glob`, `WebFetch`, `WebSearch`) ARE this client's
 * own tool-identifier vocabulary; emit `tools:` as a plain comma-separated
 * scalar list, no translation needed.
 *
 * `'mapped-array'` — this client has its OWN, confirmed-different tool
 * vocabulary AND expects `tools:` as a YAML array (not a scalar). Translate
 * through the profile's `toolNameMap`; any internal name with no confirmed
 * entry is silently dropped (never guessed), and the field is omitted
 * entirely if the mapped result is empty.
 *
 * `'omit'` — this client's tool vocabulary (or its `tools:` field's VALUE
 * shape) has not been independently verified to accept Skillsmith's internal
 * names as-is, and omitting the field is either safe (permissive default,
 * e.g. Copilot) or the only defensible choice given no evidence at all.
 * Never emit a guessed-wrong value.
 */
export type SubagentToolsPolicy = 'claude-native' | 'mapped-array' | 'omit'

/**
 * `'claude-enum'` — this client accepts a `model:` field whose values are
 * (or are compatible with) Skillsmith's internal `haiku|sonnet|opus` enum.
 *
 * `'omit'` — either no `model:` concept exists for this client, or its
 * value semantics (a hardcoded model ID, a `provider/model` string, a
 * different vendor's own model-tier vocabulary, an `inherit`/`fast`
 * keyword, etc.) don't correspond to Skillsmith's internal enum. Omit the
 * field rather than emit a value the client would reject, silently ignore,
 * or (worse) apply as a real but wrong model selection.
 */
export type SubagentModelPolicy = 'claude-enum' | 'omit'

/** Per-client shape of the generated companion-subagent file's frontmatter. */
export interface SubagentGenerationProfile {
  /** How well-evidenced this profile's fields are (see module header). */
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  /** One-line pointer to the citation backing this profile (see module header for the full text). */
  citation: string
  /**
   * Whether to emit Skillsmith's own `skills: <skill-name>` extension field
   * (a Skillsmith convention — a bare skill name — not any external
   * harness's own field of the same name, e.g. AntiGravity's `skills:`
   * expects PATHS and is a different concept) — kept true only for clients
   * this generator has always emitted it for.
   */
  includeSkillsField: boolean
  toolsPolicy: SubagentToolsPolicy
  /**
   * Skillsmith-internal tool name -> this client's own tool identifier.
   * Only present (and only meaningful) when `toolsPolicy === 'mapped-array'`.
   * An internal name with no entry here is silently dropped, never guessed.
   */
  toolNameMap?: Readonly<Record<string, string>>
  modelPolicy: SubagentModelPolicy
  /**
   * Static frontmatter lines specific to this client, appended after
   * `tools:` (when present) and before `model:` (when present). Empty for
   * every client except OpenCode's `mode: subagent`.
   */
  extraFrontmatterLines: readonly string[]
}

/** claude-code's own native format — this generator's pre-existing (unchanged) behavior. */
const CLAUDE_FORMAT_PROFILE: SubagentGenerationProfile = {
  confidence: 'HIGH',
  citation:
    "Claude Code's native `.claude/agents/*.md` subagent format (name/description/tools/model) — this repo's pre-existing behavior; matches renderClaudeShim() (agent-pack/shims.ts).",
  includeSkillsField: true,
  toolsPolicy: 'claude-native',
  modelPolicy: 'claude-enum',
  extraFrontmatterLines: [],
}

/** Minimal name+description-only shape shared by every unverified-vocabulary client. */
function minimalProfile(
  confidence: SubagentGenerationProfile['confidence'],
  citation: string,
  extraFrontmatterLines: readonly string[] = []
): SubagentGenerationProfile {
  return {
    confidence,
    citation,
    includeSkillsField: false,
    toolsPolicy: 'omit',
    modelPolicy: 'omit',
    extraFrontmatterLines,
  }
}

/**
 * AntiGravity's own tool vocabulary (antigravity.google/docs/subagents/,
 * fetched 2026-08-30) — only the 4 names the docs page itself uses as
 * worked examples. See module header for why this is `'mapped-array'`
 * rather than `'omit'` (AntiGravity's own `tools` default is `[]`, not
 * permissive) and why `Glob`/`WebFetch`/`WebSearch` have no entry.
 */
const ANTIGRAVITY_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  Read: 'view_file',
  Write: 'replace_file_content',
  Edit: 'replace_file_content',
  Bash: 'run_command',
  Grep: 'grep_search',
}

export const SUBAGENT_CLIENT_PROFILES: Readonly<Record<ClientId, SubagentGenerationProfile>> = {
  'claude-code': CLAUDE_FORMAT_PROFILE,
  // Mirrors claude-code exactly: COMPANION_AGENT_TARGETS.cursor writes into
  // the SAME `~/.claude/agents/<name>-specialist.md` path, and Cursor reads
  // that directory as a documented Claude-compatibility surface (see module
  // header). This is a deliberate object reuse, not accidental sharing.
  cursor: CLAUDE_FORMAT_PROFILE,
  antigravity: {
    confidence: 'HIGH',
    citation:
      'antigravity.google/docs/subagents/ (fetched 2026-08-30, cross-checked via independent WebSearch + Wayback bracketing 2026-08-06..2026-08-16; see smi-6276-subagent-true-antigravity-repro.md): tools is a YAML array of AntiGravity-own names defaulting to [] when omitted; model is inherit|flash|pro (a different vendor/model family from Claude — omitted rather than force-mapped).',
    includeSkillsField: false,
    toolsPolicy: 'mapped-array',
    toolNameMap: ANTIGRAVITY_TOOL_NAME_MAP,
    modelPolicy: 'omit',
    extraFrontmatterLines: [],
  },
  copilot: minimalProfile(
    'MEDIUM',
    "docs.github.com custom-agents docs (fetched 2026-08-30): tools/model fields exist and omitting tools is documented as permissive ('all tools available') — safe to omit rather than guess the full Skillsmith-tool-name mapping."
  ),
  opencode: minimalProfile(
    'MEDIUM',
    "opencode.ai/v2/docs/agents/ (fetched 2026-08-30) + this repo's own renderOpenCodeShim(): tools is a boolean permission map, not a list — omit rather than mis-shape it. mode: subagent is HIGH-confidence and included.",
    ['mode: subagent']
  ),
  windsurf: minimalProfile(
    'LOW',
    'No confirmed per-subagent-file tools/model schema found; Cascade is documented as being retired (EOL 2026-07-01).'
  ),
  agents: minimalProfile(
    'LOW',
    'The generic AGENTS.md convention has no required fields and no confirmed per-agent-definition-file schema at all.'
  ),
  hermes: minimalProfile(
    'LOW',
    'hermes-agent.nousresearch.com/docs/: documented frontmatter is for SKILL files (name/description/version/author/platforms), not a subagent tools/model schema.'
  ),
  grok: minimalProfile(
    'LOW',
    'docs.x.ai/build/overview + xai-org/grok-build: agent frontmatter exists but no built-in tool-identifier vocabulary or Claude-comparable model enum is documented.'
  ),
}

/** Resolve the per-client generation profile for `client` (default: canonical / claude-code). */
export function getSubagentGenerationProfile(
  client: ClientId = CANONICAL_CLIENT
): SubagentGenerationProfile {
  return SUBAGENT_CLIENT_PROFILES[client]
}

/**
 * Translate Skillsmith-internal tool names through `profile.toolNameMap`,
 * dropping any name with no confirmed entry and de-duplicating the result
 * (two internal names can map to the same client tool, e.g. AntiGravity's
 * `Write`/`Edit` -> `replace_file_content`). Returns `[]` when nothing maps
 * — callers must omit the `tools:` field entirely in that case, not emit an
 * empty array, per this module's own fallback philosophy.
 */
export function mapToolNames(
  tools: readonly string[],
  profile: SubagentGenerationProfile
): string[] {
  const map = profile.toolNameMap ?? {}
  const mapped = tools.map((tool) => map[tool]).filter((tool): tool is string => tool !== undefined)
  return Array.from(new Set(mapped))
}
