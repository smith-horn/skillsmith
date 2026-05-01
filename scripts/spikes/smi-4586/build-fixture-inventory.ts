/**
 * SMI-4586 Wave 0 fixture builder (THROWAWAY — spike branch only).
 *
 * Reads NDJSON skill records (already extracted from the public registry via
 * the pooler — public-tier data, reproducible) and materializes a synthetic
 * `~/.claude/`-shaped fixture directory:
 *
 *   <fixture>/skills/<author>__<name>/SKILL.md
 *   <fixture>/commands/*.md          (planted to collide with verified-tier skills)
 *   <fixture>/agents/*.md            (planted to semantically overlap with skills)
 *   <fixture>/claude-md/*.md         (real CLAUDE.md captures, copied in)
 *
 * Public-tier sources only — see plan §1. The provenance manifest is written
 * to <fixture>/MANIFEST.json so reviewers can rebuild.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

interface RegistrySkill {
  id: string
  author: string
  name: string
  description: string
  trust_tier: 'verified' | 'community' | 'experimental'
}

const FIXTURE_ROOT =
  process.env.SPIKE_FIXTURE_DIR ?? '/tmp/smi-4586-fixture'

const SOURCES: Record<RegistrySkill['trust_tier'], string> = {
  verified: '/tmp/spike-v.ndjson',
  community: '/tmp/spike-c.ndjson',
  experimental: '/tmp/spike-e.ndjson',
}

const PLANTED_COMMAND_NAMES = [
  'ship', // collides with skills triggered by "ship"
  'review',
  'plan',
  'spec',
  'build',
  'deploy',
  'test',
  // non-colliding control commands
  'changelog',
  'release-notes',
  'kanban-sync',
]

const PLANTED_AGENT_NAMES = [
  'spec-writer', // overlaps spec-* skills
  'shipper', // overlaps ship-* skills
  'reviewer', // overlaps review-* skills
  'general-purpose',
]

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function readNdjson(path: string): RegistrySkill[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RegistrySkill)
}

function writeSkillFixture(skill: RegistrySkill, fixtureRoot: string): string {
  const author = sanitize(skill.author)
  const name = sanitize(skill.name)
  const dir = join(fixtureRoot, 'skills', `${author}__${name}`)
  mkdirSync(dir, { recursive: true })
  const skillMd = `---
name: ${skill.name}
description: ${JSON.stringify(skill.description)}
author: ${skill.author}
trust_tier: ${skill.trust_tier}
skill_id: ${skill.id}
---

# ${skill.name}

${skill.description}
`
  const path = join(dir, 'SKILL.md')
  writeFileSync(path, skillMd)
  return path
}

function writeCommandFixture(commandName: string, fixtureRoot: string): string {
  const dir = join(fixtureRoot, 'commands')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${commandName}.md`)
  // Synthetic — public dotfile pattern (verb on first line, body below).
  const body = `Run the ${commandName} workflow for the current project.

When the user says "${commandName} this", execute the steps below.
`
  writeFileSync(path, body)
  return path
}

function writeAgentFixture(agentName: string, fixtureRoot: string): string {
  const dir = join(fixtureRoot, 'agents')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${agentName}.md`)
  const body = `---
name: ${agentName}
description: Subagent that handles ${agentName.replace(/-/g, ' ')} tasks. Use when the user wants to ${agentName.replace(/-/g, ' ')}.
---

# ${agentName}

This subagent assists with ${agentName.replace(/-/g, ' ')} workflows.
`
  writeFileSync(path, body)
  return path
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
}

function main(): void {
  mkdirSync(FIXTURE_ROOT, { recursive: true })
  const manifest: Array<{ kind: string; path: string; sha256: string; provenance: string }> = []

  // Skills
  const tierCounts: Record<string, number> = { verified: 0, community: 0, experimental: 0 }
  for (const tier of Object.keys(SOURCES) as Array<keyof typeof SOURCES>) {
    const records = readNdjson(SOURCES[tier])
    for (const skill of records) {
      const skillPath = writeSkillFixture(skill, FIXTURE_ROOT)
      manifest.push({
        kind: 'skill',
        path: skillPath.replace(`${FIXTURE_ROOT}/`, ''),
        sha256: sha256OfFile(skillPath),
        provenance: `registry: skills/${skill.id} (${tier})`,
      })
      tierCounts[tier]++
    }
  }

  // Commands (synthetic + intentionally colliding)
  for (const cmd of PLANTED_COMMAND_NAMES) {
    const cmdPath = writeCommandFixture(cmd, FIXTURE_ROOT)
    manifest.push({
      kind: 'command',
      path: cmdPath.replace(`${FIXTURE_ROOT}/`, ''),
      sha256: sha256OfFile(cmdPath),
      provenance: 'synthetic: planted collision',
    })
  }

  // Agents
  for (const agent of PLANTED_AGENT_NAMES) {
    const agentPath = writeAgentFixture(agent, FIXTURE_ROOT)
    manifest.push({
      kind: 'agent',
      path: agentPath.replace(`${FIXTURE_ROOT}/`, ''),
      sha256: sha256OfFile(agentPath),
      provenance: 'synthetic: planted collision',
    })
  }

  // CLAUDE.md fixtures (copied from caller-provided dir if present)
  const claudeMdSrc = process.env.SPIKE_CLAUDE_MD_DIR
  if (claudeMdSrc && existsSync(claudeMdSrc)) {
    const dir = join(FIXTURE_ROOT, 'claude-md')
    mkdirSync(dir, { recursive: true })
    for (const entry of readdirSync(claudeMdSrc)) {
      if (entry.endsWith('.md')) {
        const dst = join(dir, entry)
        copyFileSync(join(claudeMdSrc, entry), dst)
        manifest.push({
          kind: 'claude_md',
          path: dst.replace(`${FIXTURE_ROOT}/`, ''),
          sha256: sha256OfFile(dst),
          provenance: `copied from ${claudeMdSrc}/${entry}`,
        })
      }
    }
  }

  writeFileSync(
    join(FIXTURE_ROOT, 'MANIFEST.json'),
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        fixtureRoot: FIXTURE_ROOT,
        counts: {
          skills: manifest.filter((m) => m.kind === 'skill').length,
          commands: manifest.filter((m) => m.kind === 'command').length,
          agents: manifest.filter((m) => m.kind === 'agent').length,
          claude_md: manifest.filter((m) => m.kind === 'claude_md').length,
          tier: tierCounts,
        },
        entries: manifest,
      },
      null,
      2,
    ),
  )

  console.log(`fixture built: ${FIXTURE_ROOT}`)
  console.log(
    `skills=${manifest.filter((m) => m.kind === 'skill').length} commands=${manifest.filter((m) => m.kind === 'command').length} agents=${manifest.filter((m) => m.kind === 'agent').length} claude_md=${manifest.filter((m) => m.kind === 'claude_md').length}`,
  )
}

main()
