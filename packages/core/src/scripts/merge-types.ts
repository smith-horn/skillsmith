/**
 * Types for the merge-skills script
 *
 * Extracted from merge-skills.ts for file size compliance.
 */

export interface Skill {
  id?: string
  name: string
  description?: string | null
  author?: string | null
  repo_url?: string | null
  repoUrl?: string | null
  quality_score?: number
  qualityScore?: number
  trust_tier?: string
  trustTier?: string
  tags?: string[]
  source?: string
  stars?: number
  created_at?: string
}

export interface SafeSkillRef {
  skillId: string
  skillName: string
  author: string
  source: string
  riskScore: number
}

export interface SafeSkillsFile {
  skills?: SafeSkillRef[]
  metadata?: {
    scannedAt?: string
    totalScanned?: number
    safeCount?: number
    [key: string]: unknown
  }
}

export interface ImportedSkillsFile {
  skills?: Skill[]
  metadata?: {
    importedAt?: string
    totalCount?: number
    [key: string]: unknown
  }
}

export interface MergeOptions {
  safeSkillsPath: string
  importedSkillsPath: string
  databasePath: string
  dryRun: boolean
  verbose: boolean
}

export interface MergeReport {
  success: boolean
  timestamp: string
  options: MergeOptions
  stats: {
    safeSkillsLoaded: number
    importedSkillsLoaded: number
    skillsWithFullData: number
    existingInDatabase: number
    newSkillsAdded: number
    skippedDuplicates: number
    errors: number
  }
  errors: Array<{
    skillId: string
    error: string
  }>
  duration: number
}
