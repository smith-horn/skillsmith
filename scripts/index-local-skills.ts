#!/usr/bin/env npx tsx
/**
 * Index local skills from ~/.claude/skills/ into the Skillsmith database
 */

import { createDatabase, SkillRepository, type SkillCreateInput } from '@skillsmith/core'
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { parse as parseYaml } from 'yaml'

const SKILLS_DIRS = [
  join(homedir(), '.claude/skills'),
  // Also index project-level skills if running from skillsmith repo
  join(process.cwd(), '.claude/skills'),
]

const DB_PATH = join(homedir(), '.skillsmith/skills.db')

// Ensure directory exists
mkdirSync(dirname(DB_PATH), { recursive: true })

console.log('Opening database:', DB_PATH)
const db = createDatabase(DB_PATH)
const repo = new SkillRepository(db)

interface SkillMeta {
  name?: string
  version?: string
  description?: string
  author?: string
  category?: string
  tags?: string[]
}

function findSkills(dir: string): Array<{ name: string; path: string }> {
  const skills: Array<{ name: string; path: string }> = []
  if (!existsSync(dir)) {
    console.log('Directory not found:', dir)
    return skills
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const skillPath = join(dir, entry.name, 'SKILL.md')
      if (existsSync(skillPath)) {
        skills.push({ name: entry.name, path: skillPath })
      }
    }
  }
  return skills
}

function parseFrontmatter(content: string): SkillMeta | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  try {
    return parseYaml(match[1]) as SkillMeta
  } catch {
    return null
  }
}

let totalIndexed = 0

for (const skillsDir of SKILLS_DIRS) {
  console.log('\nScanning:', skillsDir)
  const skills = findSkills(skillsDir)
  console.log(`Found ${skills.length} skills`)

  for (const skill of skills) {
    try {
      const content = readFileSync(skill.path, 'utf-8')
      const meta = parseFrontmatter(content)

      if (meta?.name) {
        const id = `local/${skill.name}`
        const input: SkillCreateInput = {
          id,
          name: meta.name,
          description: meta.description || '',
          author: meta.author || 'local',
          repoUrl: undefined,
          qualityScore: 0.8,
          trustTier: 'community',
          tags: meta.tags || [],
        }

        repo.upsert(input)
        totalIndexed++
        console.log(`  ✓ ${id}`)
      }
    } catch (error) {
      console.log(`  ✗ ${skill.name}: ${(error as Error).message}`)
    }
  }
}

console.log(`\n✓ Indexed ${totalIndexed} skills into ${DB_PATH}`)
db.close()
