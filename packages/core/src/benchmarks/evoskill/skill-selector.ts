// EvoSkill skill selector — SMI-3270
// Conditions 1–6, 8–9; condition 7 throws NotImplementedError (Study B)

import type { BenchmarkTask } from './types.js'

/** Skill selector: given tasks, returns skill content strings to inject */
export type SkillSelectorFn = (tasks: BenchmarkTask[]) => Promise<string[]>

/** Dependency interfaces for conditions 5-6 (injected from CLI layer) */
export interface TransformationService {
  optimize(skillContent: string, tasks: BenchmarkTask[]): Promise<string>
}

export interface SkillCreateRunner {
  create(description: string): Promise<string>
}

export interface SkillsmithSearchClient {
  search(query: string, limit?: number): Promise<Array<{ content: string; score: number }>>
}

export interface SkillsmithRecommendClient {
  recommend(context: string, limit?: number): Promise<Array<{ content: string; score: number }>>
}

/** Condition 1: Baseline — empty skill set */
export function createBaselineSelector(): SkillSelectorFn {
  return async () => []
}

/** Condition 2: EvoSkill-Evolved — load pre-evolved skill from file */
export function createEvoSkillEvolvedSelector(evolvedSkillPath: string): SkillSelectorFn {
  return async () => {
    const fs = await import('fs')
    const content = fs.readFileSync(evolvedSkillPath, 'utf-8')
    return [content]
  }
}

/** Condition 3: Skillsmith-Search — best skill from registry search */
export function createSearchSelector(client: SkillsmithSearchClient): SkillSelectorFn {
  return async (tasks: BenchmarkTask[]) => {
    // Derive query from task benchmark + representative questions
    const benchmark = tasks[0]?.benchmark ?? 'general'
    const sampleQuestions = tasks
      .slice(0, 3)
      .map((t) => t.question)
      .join('; ')
    const query = `${benchmark} benchmark: ${sampleQuestions}`

    const results = await client.search(query, 5)
    if (results.length === 0) return []
    return [results[0].content]
  }
}

/** Condition 4: Skillsmith-Recommend — best skill from recommendations */
export function createRecommendSelector(client: SkillsmithRecommendClient): SkillSelectorFn {
  return async (tasks: BenchmarkTask[]) => {
    const benchmark = tasks[0]?.benchmark ?? 'general'
    const context = `Solving ${benchmark} benchmark tasks requiring data analysis and reasoning`

    const results = await client.recommend(context, 5)
    if (results.length === 0) return []
    return [results[0].content]
  }
}

/** Condition 5: Skillsmith-Optimized — search + optimize with TransformationService */
export function createOptimizedSelector(
  searchClient: SkillsmithSearchClient,
  transformService: TransformationService
): SkillSelectorFn {
  return async (tasks: BenchmarkTask[]) => {
    const searchSelector = createSearchSelector(searchClient)
    const skills = await searchSelector(tasks)
    if (skills.length === 0) return []

    const optimized = await transformService.optimize(skills[0], tasks)
    return [optimized]
  }
}

/** Condition 6: Skillsmith-Create — generate skill via CLI runner */
export function createSkillCreateSelector(runner: SkillCreateRunner): SkillSelectorFn {
  return async (tasks: BenchmarkTask[]) => {
    const benchmark = tasks[0]?.benchmark ?? 'general'
    const sampleQuestions = tasks
      .slice(0, 5)
      .map((t) => t.question)
      .join('\n')
    const description = `A skill for solving ${benchmark} benchmark tasks. Example tasks:\n${sampleQuestions}`

    const content = await runner.create(description)
    return [content]
  }
}

/** Condition 7: Skillsmith-Iterative — NOT in this plan */
export function createIterativeSelector(): SkillSelectorFn {
  return async () => {
    throw new NotImplementedError(
      'Condition 7 (Skillsmith-Iterative) is implemented in Study B (evoskill-task-accuracy-evaluator)'
    )
  }
}

/** Condition 8: Hybrid — Skillsmith search → EvoSkill evolution */
export function createHybridSelector(
  searchClient: SkillsmithSearchClient,
  evolveSkill: (baseSkill: string, tasks: BenchmarkTask[]) => Promise<string>
): SkillSelectorFn {
  return async (tasks: BenchmarkTask[]) => {
    const searchSelector = createSearchSelector(searchClient)
    const skills = await searchSelector(tasks)
    if (skills.length === 0) return []

    const evolved = await evolveSkill(skills[0], tasks)
    return [evolved]
  }
}

/** Condition 9: Skillsmith-Curated — hand-picked skill IDs */
export function createCuratedSelector(skillContents: string[]): SkillSelectorFn {
  return async () => skillContents
}

/** Error for unimplemented conditions */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

/** Registry of all condition factories */
export const CONDITIONS = {
  1: 'baseline',
  2: 'evoskill-evolved',
  3: 'skillsmith-search',
  4: 'skillsmith-recommend',
  5: 'skillsmith-optimized',
  6: 'skillsmith-create',
  7: 'skillsmith-iterative',
  8: 'hybrid',
  9: 'skillsmith-curated',
} as const

export type ConditionNumber = keyof typeof CONDITIONS
export type ConditionName = (typeof CONDITIONS)[ConditionNumber]
