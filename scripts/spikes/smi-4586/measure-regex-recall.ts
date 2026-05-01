/**
 * SMI-4586 Goal #3 — CLAUDE.md regex recall.
 *
 * Pass criterion: ≥60% mean recall across the 5 CLAUDE.md fixtures.
 *
 * Candidate regex strategy:
 *   1. Find sections under headings matching /trigger phrases?/i or /use when/i
 *      or /skills/i (case-insensitive, with `:` or end-of-line).
 *   2. Within those sections (until next heading or end of file), extract bullet
 *      items: lines matching /^\s*[-*]\s+(.+)$/ — capture the bullet content.
 *   3. Strip surrounding markdown formatting (backticks, quotes, bold).
 *   4. Normalize: lowercase, trim, collapse whitespace, strip trailing punctuation.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURE_ROOT = process.env.SPIKE_FIXTURE_DIR ?? '/tmp/smi-4586-fixture'
const GOLD_PATH =
  process.env.SPIKE_GOLD_PATH ??
  join(import.meta.dirname ?? '.', 'goal3-gold-standard.json')

const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/
const TRIGGER_HEADING_RE = /(trigger phrases?|use when|skills|slash commands)\b/i
const BULLET_RE = /^\s*[-*]\s+(.+?)\s*$/

interface Gold {
  files: Record<string, { gold_phrases: string[] }>
}

function normalize(s: string): string {
  // Strip markdown formatting characters and code/quote markers, then normalize.
  return s
    .replace(/`/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^["']|["']$/g, '')
    .replace(/\s+—\s+.*$/, '') // strip after em-dash explanation
    .replace(/\s+-\s+.*$/, '') // strip after en-dash explanation (less common)
    .replace(/^[\s"'`*]+|[\s"'`*.,;:]+$/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTriggerPhrases(content: string): string[] {
  const lines = content.split('\n')
  const phrases: string[] = []
  let inTriggerSection = false

  for (const line of lines) {
    const headingMatch = line.match(HEADING_RE)
    if (headingMatch) {
      inTriggerSection = TRIGGER_HEADING_RE.test(headingMatch[1])
      continue
    }
    if (!inTriggerSection) continue
    const bulletMatch = line.match(BULLET_RE)
    if (bulletMatch) {
      const norm = normalize(bulletMatch[1])
      if (norm.length > 0) phrases.push(norm)
    }
  }
  return phrases
}

function recall(extracted: string[], gold: string[]): { recalled: string[]; missed: string[]; recallPct: number } {
  if (gold.length === 0) {
    // Convention: if gold is empty and extraction is empty, recall=100%; if gold empty and
    // extraction non-empty, recall is undefined — we report 100% (no false-negatives possible)
    // and surface precision separately.
    return { recalled: [], missed: [], recallPct: 100 }
  }
  const extractedSet = new Set(extracted.map((s) => s.toLowerCase()))
  const recalled: string[] = []
  const missed: string[] = []
  for (const g of gold) {
    const gn = g.toLowerCase()
    let hit = false
    // Match if any extracted phrase contains or equals the gold phrase
    for (const e of extractedSet) {
      if (e === gn || e.includes(gn) || gn.includes(e)) { hit = true; break }
    }
    if (hit) recalled.push(g); else missed.push(g)
  }
  return {
    recalled,
    missed,
    recallPct: (recalled.length / gold.length) * 100,
  }
}

function main(): void {
  const claudeMdDir = join(FIXTURE_ROOT, 'claude-md')
  const gold: Gold = JSON.parse(readFileSync(GOLD_PATH, 'utf8'))

  const perFile: Array<{
    file: string
    extracted: string[]
    gold: string[]
    recalled: string[]
    missed: string[]
    recall_pct: number
    extracted_not_in_gold: string[]
  }> = []

  for (const file of readdirSync(claudeMdDir)) {
    if (!file.endsWith('.md')) continue
    const content = readFileSync(join(claudeMdDir, file), 'utf8')
    const extracted = extractTriggerPhrases(content)
    const goldPhrases = gold.files[file]?.gold_phrases ?? []
    const { recalled, missed, recallPct } = recall(extracted, goldPhrases)
    const extractedNotInGold = extracted.filter(
      (e) => !goldPhrases.some((g) => g.toLowerCase() === e || g.toLowerCase().includes(e) || e.includes(g.toLowerCase())),
    )
    perFile.push({
      file,
      extracted,
      gold: goldPhrases,
      recalled,
      missed,
      recall_pct: Number(recallPct.toFixed(2)),
      extracted_not_in_gold: extractedNotInGold,
    })
  }

  // Mean across files where gold is non-empty (convention: don't dilute mean with vacuous 100%s)
  const goldedFiles = perFile.filter((p) => p.gold.length > 0)
  const meanRecall = goldedFiles.length === 0
    ? 0
    : goldedFiles.reduce((s, p) => s + p.recall_pct, 0) / goldedFiles.length

  const result = {
    goal: 3,
    fixture_dir: FIXTURE_ROOT,
    gold_path: GOLD_PATH,
    file_count: perFile.length,
    files_with_gold: goldedFiles.length,
    mean_recall_pct: Number(meanRecall.toFixed(2)),
    per_file: perFile,
    criterion: 'mean recall ≥ 60% (across files with non-empty gold)',
    verdict: meanRecall >= 60 ? 'pass' : 'no-go',
  }

  console.log(JSON.stringify(result, null, 2))
}

main()
