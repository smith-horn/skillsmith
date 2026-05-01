/**
 * SMI-4586 Goal #2 — Stoplist coverage on real installed skills.
 *
 * Pass criterion: ≥40% of planted-collision skills produce ≥1 flag from
 * `detectGenericTriggerWords`.
 *
 * Planted-collision tokens (from build-fixture-inventory.ts):
 *   ship, spec, build, test, deploy, plan, review
 *
 * A skill is "planted-collision" if its name or description contains any of
 * those tokens. (NDJSON sources were filtered with this same predicate at
 * extraction time, so most fixture skills should qualify.)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { detectGenericTriggerWords } from '../../../packages/mcp-server/src/tools/skill-pack-audit.helpers.js'

const FIXTURE_ROOT = process.env.SPIKE_FIXTURE_DIR ?? '/tmp/smi-4586-fixture'

const PLANTED_TOKENS = ['ship', 'spec', 'build', 'test', 'deploy', 'plan', 'review']

const GENERIC_TRIGGERS = JSON.parse(
  readFileSync(
    join(import.meta.dirname ?? '.', '../../../packages/core/src/data/generic-triggers.json'),
    'utf8',
  ),
)

interface Skill {
  id: string
  name: string
  description: string
}

function loadSkills(): Skill[] {
  const skillsDir = join(FIXTURE_ROOT, 'skills')
  const skills: Skill[] = []
  for (const entry of readdirSync(skillsDir)) {
    const skillMd = join(skillsDir, entry, 'SKILL.md')
    let content: string
    try { content = readFileSync(skillMd, 'utf8') } catch { continue }
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
    if (!fmMatch) continue
    const fm = fmMatch[1]
    const nameMatch = fm.match(/^name:\s*(.+)$/m)
    const descMatch = fm.match(/^description:\s*(.+)$/m)
    if (!nameMatch || !descMatch) continue
    let description = descMatch[1].trim()
    if (description.startsWith('"') && description.endsWith('"')) {
      try { description = JSON.parse(description) } catch { /* */ }
    }
    skills.push({ id: entry, name: nameMatch[1].trim(), description })
  }
  return skills
}

function isPlantedCollision(s: Skill): boolean {
  const haystack = `${s.name} ${s.description}`.toLowerCase()
  return PLANTED_TOKENS.some((t) => new RegExp(`\\b${t}\\b`).test(haystack))
}

function main(): void {
  const skills = loadSkills()
  const planted: Skill[] = []
  const flaggedPlanted: Array<{ skill: Skill; flags: ReturnType<typeof detectGenericTriggerWords> }> = []
  const missedPlanted: Skill[] = []

  for (const s of skills) {
    if (!isPlantedCollision(s)) continue
    planted.push(s)
    const flags = detectGenericTriggerWords(s.description, s.name, null, GENERIC_TRIGGERS)
    if (flags.length > 0) {
      flaggedPlanted.push({ skill: s, flags })
    } else {
      missedPlanted.push(s)
    }
  }

  // Tokens that appear in planted skills but never produced a flag
  const missedTokens = new Set<string>()
  for (const m of missedPlanted) {
    const haystack = `${m.name} ${m.description}`.toLowerCase()
    for (const t of PLANTED_TOKENS) {
      if (new RegExp(`\\b${t}\\b`).test(haystack)) missedTokens.add(t)
    }
  }

  const coveragePct = planted.length === 0 ? 0 : (flaggedPlanted.length / planted.length) * 100

  const result = {
    goal: 2,
    fixture_dir: FIXTURE_ROOT,
    total_skills: skills.length,
    planted_count: planted.length,
    flagged_count: flaggedPlanted.length,
    missed_count: missedPlanted.length,
    coverage_pct: Number(coveragePct.toFixed(2)),
    missed_tokens: [...missedTokens].sort(),
    missed_skill_ids: missedPlanted.map((s) => s.id),
    sample_flags: flaggedPlanted.slice(0, 5).map((fp) => ({
      skill_id: fp.skill.id,
      tokens: fp.flags.map((f) => f.token),
    })),
    criterion: 'coverage ≥ 40%',
    verdict: coveragePct >= 40 ? 'pass' : 'no-go',
  }

  console.log(JSON.stringify(result, null, 2))
}

main()
