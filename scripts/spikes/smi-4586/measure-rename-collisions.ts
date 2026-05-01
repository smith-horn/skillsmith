/**
 * SMI-4586 Goal #4 — Does ${author}-${token} itself collide?
 *
 * Pass criterion: collision rate < 5%.
 *
 * Method:
 *   - For each fixture skill, generate suggested rename = ${author}-${token}
 *     where token is the skill's name. (Approximates the rename engine's
 *     dry-run output.)
 *   - For each fixture command/agent (kind-without-author), generate suggested
 *     rename = local-${kind}-${name} (the "no-author" fallback).
 *   - Build set of all original identifiers (skill ids + command names + agent
 *     names). Build set of all suggested renames.
 *   - Count collisions: any suggested rename that is already a member of the
 *     original-identifier set OR of another suggested rename. Express as %.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURE_ROOT = process.env.SPIKE_FIXTURE_DIR ?? '/tmp/smi-4586-fixture'

interface SkillFm {
  author: string
  name: string
  dir: string
}

function parseSkillFrontmatter(skillMd: string): { author: string; name: string } | null {
  const fmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return null
  const fm = fmMatch[1]
  const author = fm.match(/^author:\s*(.+)$/m)?.[1].trim()
  const name = fm.match(/^name:\s*(.+)$/m)?.[1].trim()
  if (!author || !name) return null
  return { author, name }
}

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function main(): void {
  const skillsDir = join(FIXTURE_ROOT, 'skills')
  const commandsDir = join(FIXTURE_ROOT, 'commands')
  const agentsDir = join(FIXTURE_ROOT, 'agents')

  const skills: SkillFm[] = []
  for (const dir of readdirSync(skillsDir)) {
    const skillMd = join(skillsDir, dir, 'SKILL.md')
    let content: string
    try { content = readFileSync(skillMd, 'utf8') } catch { continue }
    const fm = parseSkillFrontmatter(content)
    if (fm) skills.push({ ...fm, dir })
  }

  const commands = readdirSync(commandsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
  const agents = readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))

  // Original identifier set (cross-kind to detect a rename colliding with another kind too)
  const originals = new Set<string>()
  for (const s of skills) originals.add(sanitize(s.name))
  for (const c of commands) originals.add(sanitize(c))
  for (const a of agents) originals.add(sanitize(a))

  // Generate suggested renames
  const renames: Array<{ kind: 'skill' | 'command' | 'agent'; original: string; suggested: string }> = []
  for (const s of skills) {
    const suggested = sanitize(`${s.author}-${s.name}`)
    renames.push({ kind: 'skill', original: sanitize(s.name), suggested })
  }
  for (const c of commands) {
    const suggested = sanitize(`local-command-${c}`)
    renames.push({ kind: 'command', original: sanitize(c), suggested })
  }
  for (const a of agents) {
    const suggested = sanitize(`local-agent-${a}`)
    renames.push({ kind: 'agent', original: sanitize(a), suggested })
  }

  // Collision detection
  const suggestedSet = new Set<string>()
  const suggestedDuplicates: string[] = []
  for (const r of renames) {
    if (suggestedSet.has(r.suggested)) suggestedDuplicates.push(r.suggested)
    suggestedSet.add(r.suggested)
  }

  const collisions = renames.filter(
    (r) =>
      // suggested rename equals an original identifier (different from its own original)
      (originals.has(r.suggested) && r.suggested !== r.original) ||
      // suggested rename appears more than once
      suggestedDuplicates.includes(r.suggested),
  )

  const collisionRate = (collisions.length / renames.length) * 100

  const result = {
    goal: 4,
    fixture_dir: FIXTURE_ROOT,
    total_renames: renames.length,
    skill_renames: skills.length,
    command_renames: commands.length,
    agent_renames: agents.length,
    collision_count: collisions.length,
    collision_rate_pct: Number(collisionRate.toFixed(2)),
    collisions: collisions.map((c) => ({
      kind: c.kind,
      original: c.original,
      suggested: c.suggested,
      reason: originals.has(c.suggested) && c.suggested !== c.original
        ? 'collides with another original identifier'
        : 'duplicate suggested rename',
    })),
    sample_renames: renames.slice(0, 5),
    criterion: 'collision rate < 5%',
    verdict: collisionRate < 5 ? 'pass' : 'no-go',
  }

  console.log(JSON.stringify(result, null, 2))
}

main()
