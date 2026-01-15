/**
 * Merge safe skills into the main database
 * Only adds skills that don't already exist (by repo_url)
 */

import Database from 'better-sqlite3'
import { readFileSync } from 'fs'

interface Skill {
  id?: string
  name: string
  description?: string | null
  author?: string | null
  repo_url?: string | null
  quality_score?: number
  qualityScore?: number
  trust_tier?: string
  trustTier?: string
  tags?: string[]
  source?: string
  stars?: number
  created_at?: string
}

interface SafeSkillRef {
  skillId: string
  skillName: string
  author: string
  source: string
  riskScore: number
}

async function main() {
  // Read safe skill IDs from security scan
  const safeSkillsData = JSON.parse(readFileSync('data/safe-skills.json', 'utf-8'))
  const safeRefs: SafeSkillRef[] = safeSkillsData.skills || safeSkillsData
  const safeIds = new Set(safeRefs.map((s) => s.skillId))
  console.log('Safe skill IDs:', safeIds.size)

  // Read full skill data from original import
  const importedData = JSON.parse(readFileSync('data/imported-skills.json', 'utf-8'))
  const allSkills: Skill[] = importedData.skills || importedData
  console.log('Total imported skills:', allSkills.length)

  // Filter to only safe skills
  const safeSkills = allSkills.filter((s) => safeIds.has(s.id || ''))
  console.log('Safe skills with full data:', safeSkills.length)

  // Open existing database
  const db = new Database('data/phase-5-full-import/skills.db')

  // Get existing repo URLs
  const existingRows = db
    .prepare('SELECT repo_url FROM skills WHERE repo_url IS NOT NULL')
    .all() as { repo_url: string }[]
  const existingUrls = new Set(existingRows.map((row) => row.repo_url?.toLowerCase()))
  console.log('Existing skills in DB:', existingUrls.size)

  // Prepare insert statement (matching existing schema)
  const insert = db.prepare(`
    INSERT OR IGNORE INTO skills (id, name, description, author, repo_url, quality_score, trust_tier, tags, source, stars, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  // Filter and insert new skills
  let newCount = 0
  let skippedCount = 0

  const insertMany = db.transaction((skills: Skill[]) => {
    for (const skill of skills) {
      const repoUrl = skill.repo_url?.toLowerCase()
      if (repoUrl && !existingUrls.has(repoUrl)) {
        insert.run(
          skill.id || 'github/' + skill.author + '/' + skill.name,
          skill.name,
          skill.description || null,
          skill.author || null,
          skill.repo_url || null,
          skill.quality_score ?? skill.qualityScore ?? 0.5,
          skill.trust_tier ?? skill.trustTier ?? 'community',
          JSON.stringify(skill.tags || []),
          skill.source || 'github',
          skill.stars || 0,
          skill.created_at || new Date().toISOString()
        )
        newCount++
      } else {
        skippedCount++
      }
    }
  })

  insertMany(safeSkills)

  // Get final count
  const finalCount = db.prepare('SELECT COUNT(*) as count FROM skills').get() as { count: number }

  console.log('')
  console.log('=== MERGE RESULTS ===')
  console.log('New skills added:', newCount)
  console.log('Skipped (already exist):', skippedCount)
  console.log('Final skill count:', finalCount.count)
  console.log('')

  db.close()
  console.log('Merge complete!')
}

main().catch(console.error)
