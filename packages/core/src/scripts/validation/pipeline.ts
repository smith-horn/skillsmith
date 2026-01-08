/**
 * SMI-863: Validation pipeline for skill processing
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  RawSkillInput,
  ValidatedSkill,
  ValidationReport,
  DuplicatesReport,
} from './types.js'
import { validateSkill } from './field-validators.js'
import { deduplicateByRepoUrl, detectSemanticDuplicates } from './deduplication.js'

/**
 * Run the complete validation and deduplication pipeline
 */
export async function runValidationPipeline(
  inputPath: string,
  outputDir: string
): Promise<{
  validatedSkills: ValidatedSkill[]
  validationReport: ValidationReport
  duplicatesReport: DuplicatesReport
}> {
  console.log('='.repeat(60))
  console.log('SMI-863: Skill Validation and Deduplication Pipeline')
  console.log('='.repeat(60))
  console.log()

  // Read input file
  console.log(`Reading input: ${inputPath}`)
  const inputData = JSON.parse(fs.readFileSync(inputPath, 'utf-8'))
  const rawSkills: RawSkillInput[] = Array.isArray(inputData) ? inputData : inputData.skills || []
  console.log(`Found ${rawSkills.length} skills to process`)
  console.log()

  // Validate all skills
  console.log('Phase 1: Validation')
  console.log('-'.repeat(40))
  const validationResults = rawSkills.map(validateSkill)
  const validSkills = validationResults.filter((r) => r.valid).map((r) => r.skill!)
  const invalidResults = validationResults.filter((r) => !r.valid)

  console.log(`  Valid: ${validSkills.length}`)
  console.log(`  Invalid: ${invalidResults.length}`)
  console.log(
    `  Auto-fixes applied: ${validationResults.reduce((sum, r) => sum + r.fixes.length, 0)}`
  )
  console.log()

  // Deduplicate by repo_url
  console.log('Phase 2: Deduplication by repo_url')
  console.log('-'.repeat(40))
  const repoUrlDedup = deduplicateByRepoUrl(validSkills)
  console.log(`  Before: ${validSkills.length}`)
  console.log(`  After: ${repoUrlDedup.unique.length}`)
  console.log(`  Duplicates: ${repoUrlDedup.duplicates.length}`)
  console.log()

  // Semantic similarity detection
  console.log('Phase 3: Semantic similarity detection')
  console.log('-'.repeat(40))
  const semanticDedup = await detectSemanticDuplicates(repoUrlDedup.unique)
  console.log(`  Before: ${repoUrlDedup.unique.length}`)
  console.log(`  After: ${semanticDedup.unique.length}`)
  console.log(`  Semantic duplicates: ${semanticDedup.duplicates.length}`)
  console.log()

  // Combine all duplicates
  const allDuplicates = [...repoUrlDedup.duplicates, ...semanticDedup.duplicates]

  // Build validation report
  const errorsByField: Record<string, number> = {}
  for (const result of invalidResults) {
    for (const error of result.errors) {
      errorsByField[error.field] = (errorsByField[error.field] || 0) + 1
    }
  }

  const validationReport: ValidationReport = {
    timestamp: new Date().toISOString(),
    summary: {
      total_input: rawSkills.length,
      valid_skills: validSkills.length,
      invalid_skills: invalidResults.length,
      duplicates_removed: allDuplicates.length,
      auto_fixes_applied: validationResults.reduce((sum, r) => sum + r.fixes.length, 0),
      errors_by_field: errorsByField,
    },
    errors: invalidResults.map((r) => ({
      skill_id: r.original.id,
      skill_name: r.original.name,
      errors: r.errors,
    })),
    warnings: validationResults
      .filter((r) => r.warnings.length > 0)
      .map((r) => ({
        skill_id: r.skill?.id || r.original.id,
        skill_name: r.skill?.name || r.original.name,
        warnings: r.warnings,
      })),
    fixes: validationResults
      .filter((r) => r.fixes.length > 0)
      .map((r) => ({
        skill_id: r.skill?.id || r.original.id,
        skill_name: r.skill?.name || r.original.name,
        fixes: r.fixes,
      })),
  }

  // Build duplicates report
  const duplicatesReport: DuplicatesReport = {
    timestamp: new Date().toISOString(),
    summary: {
      total_duplicates: allDuplicates.length,
      by_repo_url: repoUrlDedup.duplicates.length,
      by_semantic_similarity: semanticDedup.duplicates.length,
    },
    duplicates: allDuplicates,
  }

  // Write output files
  console.log('Phase 4: Writing output files')
  console.log('-'.repeat(40))

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  const validatedSkillsPath = path.join(outputDir, 'validated-skills.json')
  const validationReportPath = path.join(outputDir, 'validation-report.json')
  const duplicatesReportPath = path.join(outputDir, 'duplicates-report.json')

  fs.writeFileSync(validatedSkillsPath, JSON.stringify(semanticDedup.unique, null, 2))
  console.log(`  Validated skills: ${validatedSkillsPath}`)

  fs.writeFileSync(validationReportPath, JSON.stringify(validationReport, null, 2))
  console.log(`  Validation report: ${validationReportPath}`)

  fs.writeFileSync(duplicatesReportPath, JSON.stringify(duplicatesReport, null, 2))
  console.log(`  Duplicates report: ${duplicatesReportPath}`)

  console.log()
  console.log('='.repeat(60))
  console.log('Pipeline Complete')
  console.log('='.repeat(60))
  console.log(`  Final skill count: ${semanticDedup.unique.length}`)
  console.log(`  Total duplicates removed: ${allDuplicates.length}`)
  console.log(`  Validation errors: ${invalidResults.length}`)

  return {
    validatedSkills: semanticDedup.unique,
    validationReport,
    duplicatesReport,
  }
}
