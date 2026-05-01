/**
 * SMI-4586 Goal #6 — Templated edit-suggestion reviewer harness.
 *
 * SETUP ONLY — do NOT score. The orchestrator hard-stop requires generating
 * the CSV (≥10 cases × 3 templates), then surfacing to reviewers (Ryan + 1).
 *
 * Process:
 *   1. Find top semantic-overlap pairs in the fixture inventory using
 *      OverlapDetector (real ONNX, default thresholds).
 *   2. Take top 10 pairs by overlap score.
 *   3. For each pair × 3 templates (add_domain_qualifier, narrow_scope,
 *      reword_trigger_verb), generate the suggestion text.
 *   4. Emit CSV with reviewer score columns blank.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OverlapDetector, type TriggerPhraseSkill } from '@skillsmith/core'

const FIXTURE_ROOT = process.env.SPIKE_FIXTURE_DIR ?? '/tmp/smi-4586-fixture'
const OUTPUT_PATH = process.env.SPIKE_GOAL6_OUTPUT ?? join(import.meta.dirname ?? '.', 'goal6-review-harness.csv')

interface FixtureSkill {
  id: string
  author: string
  name: string
  description: string
  triggerPhrases: string[]
}

function loadSkills(): FixtureSkill[] {
  const skillsDir = join(FIXTURE_ROOT, 'skills')
  const out: FixtureSkill[] = []
  for (const entry of readdirSync(skillsDir)) {
    const skillMd = join(skillsDir, entry, 'SKILL.md')
    let content: string
    try { content = readFileSync(skillMd, 'utf8') } catch { continue }
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
    if (!fmMatch) continue
    const fm = fmMatch[1]
    const author = fm.match(/^author:\s*(.+)$/m)?.[1].trim() ?? 'unknown'
    const name = fm.match(/^name:\s*(.+)$/m)?.[1].trim() ?? entry
    let description = fm.match(/^description:\s*(.+)$/m)?.[1].trim() ?? ''
    if (description.startsWith('"') && description.endsWith('"')) {
      try { description = JSON.parse(description) } catch { /* */ }
    }
    const phrases = description
      .split(/[.!?]\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 5)
    out.push({
      id: entry,
      author,
      name,
      description,
      triggerPhrases: phrases.length > 0 ? phrases : [name],
    })
  }
  return out
}

function applyTemplate(
  template: 'add_domain_qualifier' | 'narrow_scope' | 'reword_trigger_verb',
  skill: FixtureSkill,
  overlappingPhrase: string,
): string {
  switch (template) {
    case 'add_domain_qualifier': {
      const domain = skill.author.split(/[-_/]/)[0] || 'local'
      return `Rename "${skill.name}" to "${domain}-${skill.name}" so its trigger phrases unambiguously belong to the ${domain} domain. (Original: "${overlappingPhrase}".)`
    }
    case 'narrow_scope': {
      return `Narrow the description of "${skill.name}" to specify a concrete sub-task. The phrase "${overlappingPhrase}" is too generic; replace with a phrase that includes the specific artifact, e.g. "${overlappingPhrase} a Stripe webhook" or "${overlappingPhrase} the migrations folder".`
    }
    case 'reword_trigger_verb': {
      const verb = overlappingPhrase.split(/\s+/)[0]?.toLowerCase() ?? 'do'
      const synonyms: Record<string, string[]> = {
        review: ['audit', 'inspect', 'evaluate'],
        ship: ['publish', 'release', 'deploy'],
        plan: ['draft', 'outline', 'architect'],
        spec: ['specify', 'document', 'design'],
        build: ['compile', 'assemble', 'package'],
        test: ['validate', 'assert', 'verify'],
        deploy: ['ship', 'roll out', 'promote'],
      }
      const replacement = synonyms[verb]?.[0] ?? `${verb}-specific`
      return `Replace the trigger verb "${verb}" in "${overlappingPhrase}" with "${replacement}" to disambiguate from sibling skills. Updated description: "${skill.description.replace(new RegExp(`\\b${verb}\\b`, 'i'), replacement)}".`
    }
  }
}

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

async function main(): Promise<void> {
  const skills = loadSkills()
  const tpSkills: TriggerPhraseSkill[] = skills.map((s) => ({
    id: s.id,
    name: s.name,
    triggerPhrases: s.triggerPhrases,
  }))

  // Lower phraseThreshold so we can surface candidate pairs for reviewer harness.
  // Production audit will use defaults; this is just for harness population.
  const detector = new OverlapDetector({ useFallback: false, phraseThreshold: 0.5, overlapThreshold: 0.3 })
  const overlaps = await detector.findAllOverlaps(tpSkills)
  detector.close()

  const top = overlaps.slice(0, 10)
  if (top.length < 10) {
    console.error(`WARNING: only ${top.length} overlap pairs found at phraseThreshold=0.5; expected ≥10.`)
  }

  const skillById = new Map(skills.map((s) => [s.id, s]))
  const templates: Array<'add_domain_qualifier' | 'narrow_scope' | 'reword_trigger_verb'> = [
    'add_domain_qualifier',
    'narrow_scope',
    'reword_trigger_verb',
  ]

  const headers = [
    'case_id',
    'pair_skill_a',
    'pair_skill_b',
    'overlap_score',
    'overlapping_phrase_a',
    'overlapping_phrase_b',
    'template_kind',
    'suggestion_text',
    'reviewer_1_actionability_1to5',
    'reviewer_1_preservation_1to5',
    'reviewer_2_actionability_1to5',
    'reviewer_2_preservation_1to5',
    'reviewer_notes',
  ]
  const rows: string[][] = [headers]

  let caseId = 0
  for (const pair of top) {
    caseId++
    const skillA = skillById.get(pair.skillId1)!
    const skillB = skillById.get(pair.skillId2)!
    const sample = pair.overlappingPhrases[0]
    for (const template of templates) {
      const suggestion = applyTemplate(template, skillA, sample.phrase1)
      rows.push([
        `case-${caseId.toString().padStart(2, '0')}`,
        skillA.id,
        skillB.id,
        pair.overlapScore.toFixed(2),
        sample.phrase1,
        sample.phrase2,
        template,
        suggestion,
        '', '', '', '', '',
      ])
    }
  }

  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n'
  writeFileSync(OUTPUT_PATH, csv)

  const result = {
    goal: 6,
    fixture_dir: FIXTURE_ROOT,
    output_path: OUTPUT_PATH,
    case_count: top.length,
    template_count: templates.length,
    total_rows: top.length * templates.length,
    top_pair_overlap_scores: top.map((p) => p.overlapScore),
    criterion: 'mean reviewer score ≥ 3.5/5 across (actionability + preservation), 2 reviewers',
    verdict: 'blocked: awaiting reviewers',
    reviewer_instructions:
      'Open the CSV; for each row score actionability (1-5: would the user know what to change?) and preservation (1-5: does the suggestion keep the original intent?). Two reviewers required (Ryan + 1).',
  }

  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('generate-goal6-harness failed:', err)
  process.exit(1)
})
