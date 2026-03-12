// EvoSkill dataset loader — SMI-3269
// Parses EvoSkill CSV (DABStep, SEAL-QA) and BrowseComp JSON
// Applies train/val/test splits with configurable seed

import type { BenchmarkTask } from './types.js'
import { EVOSKILL_DEFAULTS } from './types.js'

/** Seeded PRNG (Mulberry32) for deterministic shuffles */
function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates shuffle with seeded PRNG */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = [...arr]
  const rng = mulberry32(seed)
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/** Parse a CSV line, handling quoted fields with commas */
function parseCSVLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

export interface DatasetLoadResult {
  tasks: BenchmarkTask[]
  train: BenchmarkTask[]
  val: BenchmarkTask[]
  test: BenchmarkTask[]
}

/**
 * Load a CSV dataset (OfficeQA / SEAL-QA format).
 * Expected columns: question, answer (ground truth).
 * Column order detected from header row.
 */
export function loadCSVDataset(
  csvContent: string,
  benchmark: 'officeqa' | 'sealqa',
  options: { seed?: number; trainRatio?: number; valRatio?: number } = {}
): DatasetLoadResult {
  const lines = csvContent.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < 2) {
    throw new Error(`Dataset ${benchmark} has fewer than 2 lines (no data rows)`)
  }

  const header = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase())
  const qIdx = header.indexOf('question')
  const aIdx = header.findIndex((h) => h === 'answer' || h === 'ground_truth' || h === 'groundtruth')

  if (qIdx === -1 || aIdx === -1) {
    throw new Error(
      `Dataset ${benchmark} missing required columns. Found: ${header.join(', ')}. Need: question, answer/ground_truth`
    )
  }

  const tasks: BenchmarkTask[] = []
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i])
    if (fields.length <= Math.max(qIdx, aIdx)) continue

    tasks.push({
      id: `${benchmark}-${i}`,
      question: fields[qIdx].trim(),
      groundTruth: fields[aIdx].trim(),
      split: 'test', // placeholder — assigned below
      benchmark,
    })
  }

  return splitDataset(tasks, benchmark, options)
}

/**
 * Load BrowseComp JSON dataset.
 * Expected format: array of { question: string, answer: string }
 */
export function loadJSONDataset(
  jsonContent: string,
  benchmark: 'browsecomp',
  options: { seed?: number; trainRatio?: number; valRatio?: number } = {}
): DatasetLoadResult {
  const parsed: unknown = JSON.parse(jsonContent)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `Dataset ${benchmark} is empty or not an array (got ${typeof parsed})`
    )
  }

  const tasks: BenchmarkTask[] = []
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as Record<string, unknown>
    if (typeof item?.question !== 'string' || typeof item?.answer !== 'string') {
      throw new Error(
        `Dataset ${benchmark} item ${i} missing required string fields: question=${typeof item?.question}, answer=${typeof item?.answer}`
      )
    }
    if (!item.question.trim() || !item.answer.trim()) {
      throw new Error(`Dataset ${benchmark} item ${i} has empty question or answer`)
    }
    tasks.push({
      id: `${benchmark}-${i + 1}`,
      question: item.question,
      groundTruth: item.answer,
      split: 'test' as const,
      benchmark,
    })
  }

  return splitDataset(tasks, benchmark, options)
}

/** Apply train/val/test split with seeded shuffle */
function splitDataset(
  tasks: BenchmarkTask[],
  benchmark: string,
  options: { seed?: number; trainRatio?: number; valRatio?: number } = {}
): DatasetLoadResult {
  const seed = options.seed ?? EVOSKILL_DEFAULTS.SEED
  const trainRatio = options.trainRatio ?? EVOSKILL_DEFAULTS.TRAIN_RATIO
  const valRatio = options.valRatio ?? EVOSKILL_DEFAULTS.VAL_RATIO

  if (trainRatio + valRatio >= 1) {
    throw new Error(`train + val ratios must be < 1 (got ${trainRatio} + ${valRatio})`)
  }

  const shuffled = seededShuffle(tasks, seed)
  const n = shuffled.length
  const trainEnd = Math.round(n * trainRatio)
  const valEnd = Math.round(n * (trainRatio + valRatio))

  const train = shuffled.slice(0, trainEnd).map((t) => ({ ...t, split: 'train' as const }))
  const val = shuffled.slice(trainEnd, valEnd).map((t) => ({ ...t, split: 'val' as const }))
  const test = shuffled.slice(valEnd).map((t) => ({ ...t, split: 'test' as const }))

  if (test.length === 0) {
    throw new Error(`Dataset ${benchmark} has 0 test tasks after split (${n} total)`)
  }

  const allTasks = [...train, ...val, ...test]
  return { tasks: allTasks, train, val, test }
}

/** Load dataset from file content, auto-detecting format */
export function loadDataset(
  content: string,
  benchmark: 'officeqa' | 'sealqa' | 'browsecomp',
  options: { seed?: number; trainRatio?: number; valRatio?: number } = {}
): DatasetLoadResult {
  if (benchmark === 'browsecomp') {
    return loadJSONDataset(content, benchmark, options)
  }
  return loadCSVDataset(content, benchmark, options)
}
