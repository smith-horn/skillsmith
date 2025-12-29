/**
 * Quality Scoring Algorithm (SMI-592)
 *
 * Provides a comprehensive quality scoring system for skills based on
 * repository metrics, activity signals, documentation, and trust indicators.
 */

/**
 * Input signals for quality scoring
 */
export interface QualityScoringInput {
  // Repository metrics
  stars: number
  forks: number
  watchers?: number

  // Activity signals
  updatedAt: string
  createdAt: string
  openIssues?: number
  closedIssues?: number
  contributors?: number
  recentCommits?: number // Commits in last 30 days

  // Documentation signals
  hasReadme?: boolean
  hasSkillFile?: boolean
  hasLicense?: boolean
  descriptionLength?: number
  skillFileLength?: number

  // Trust signals
  topics?: string[]
  owner?: string
  isVerifiedOwner?: boolean
  license?: string | null

  // Content signals
  hasExamples?: boolean
  hasTroubleshooting?: boolean
  hasPrerequisites?: boolean
}

/**
 * Detailed quality score breakdown
 */
export interface QualityScoreBreakdown {
  /** Total quality score (0-100) */
  total: number

  /** Repository popularity score (0-30) */
  popularity: number

  /** Activity and maintenance score (0-25) */
  activity: number

  /** Documentation quality score (0-25) */
  documentation: number

  /** Trust and credibility score (0-20) */
  trust: number

  /** Individual factor contributions */
  factors: {
    stars: number
    forks: number
    watchers: number
    recency: number
    issueHealth: number
    contributors: number
    readme: number
    skillFile: number
    license: number
    description: number
    verifiedOwner: number
    topics: number
    contentQuality: number
  }
}

/**
 * Weight configuration for scoring factors
 */
export interface ScoringWeights {
  // Popularity weights (total: 30)
  stars: number
  forks: number
  watchers: number

  // Activity weights (total: 25)
  recency: number
  issueHealth: number
  contributors: number
  recentActivity: number

  // Documentation weights (total: 25)
  readme: number
  skillFile: number
  description: number
  contentQuality: number

  // Trust weights (total: 20)
  license: number
  verifiedOwner: number
  topics: number
}

/**
 * Default scoring weights
 */
const DEFAULT_WEIGHTS: ScoringWeights = {
  // Popularity (30 points total)
  stars: 15,
  forks: 10,
  watchers: 5,

  // Activity (25 points total)
  recency: 10,
  issueHealth: 5,
  contributors: 5,
  recentActivity: 5,

  // Documentation (25 points total)
  readme: 5,
  skillFile: 10,
  description: 5,
  contentQuality: 5,

  // Trust (20 points total)
  license: 8,
  verifiedOwner: 7,
  topics: 5,
}

/**
 * Verified owners that get trust bonus
 */
const VERIFIED_OWNERS = new Set([
  'anthropics',
  'anthropic-ai',
  'claude-ai',
  'ruv',
  'ruvnet',
  'skillsmith',
])

/**
 * Approved open source licenses
 */
const APPROVED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MPL-2.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'GPL-2.0',
  'GPL-3.0',
  'Unlicense',
  'CC0-1.0',
])

/**
 * Quality scoring calculator
 *
 * @example
 * ```typescript
 * const scorer = new QualityScorer()
 *
 * const result = scorer.calculate({
 *   stars: 100,
 *   forks: 20,
 *   updatedAt: '2024-01-15T00:00:00Z',
 *   createdAt: '2023-01-01T00:00:00Z',
 *   hasReadme: true,
 *   hasSkillFile: true,
 *   license: 'MIT',
 *   topics: ['claude-skill']
 * })
 *
 * console.log(result.total) // 0-100
 * console.log(result.factors) // Individual contributions
 * ```
 */
export class QualityScorer {
  private weights: ScoringWeights

  constructor(weights: Partial<ScoringWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights }
  }

  /**
   * Calculate quality score from input signals
   */
  calculate(input: QualityScoringInput): QualityScoreBreakdown {
    const factors = {
      stars: this.scoreStars(input.stars),
      forks: this.scoreForks(input.forks),
      watchers: this.scoreWatchers(input.watchers ?? 0),
      recency: this.scoreRecency(input.updatedAt),
      issueHealth: this.scoreIssueHealth(input.openIssues, input.closedIssues),
      contributors: this.scoreContributors(input.contributors ?? 0),
      readme: this.scoreReadme(input.hasReadme ?? false),
      skillFile: this.scoreSkillFile(input.hasSkillFile ?? false, input.skillFileLength ?? 0),
      license: this.scoreLicense(input.license),
      description: this.scoreDescription(input.descriptionLength ?? 0),
      verifiedOwner: this.scoreVerifiedOwner(input.owner, input.isVerifiedOwner),
      topics: this.scoreTopics(input.topics ?? []),
      contentQuality: this.scoreContentQuality(input),
    }

    // Calculate category scores
    const popularity =
      factors.stars * (this.weights.stars / 15) +
      factors.forks * (this.weights.forks / 10) +
      factors.watchers * (this.weights.watchers / 5)

    const activity =
      factors.recency * (this.weights.recency / 10) +
      factors.issueHealth * (this.weights.issueHealth / 5) +
      factors.contributors * (this.weights.contributors / 5)

    const documentation =
      factors.readme * (this.weights.readme / 5) +
      factors.skillFile * (this.weights.skillFile / 10) +
      factors.description * (this.weights.description / 5) +
      factors.contentQuality * (this.weights.contentQuality / 5)

    const trust =
      factors.license * (this.weights.license / 8) +
      factors.verifiedOwner * (this.weights.verifiedOwner / 7) +
      factors.topics * (this.weights.topics / 5)

    const total = Math.min(100, Math.round(popularity + activity + documentation + trust))

    return {
      total,
      popularity: Math.round(popularity),
      activity: Math.round(activity),
      documentation: Math.round(documentation),
      trust: Math.round(trust),
      factors,
    }
  }

  /**
   * Calculate trust tier from score and signals
   */
  calculateTrustTier(
    input: QualityScoringInput,
    score: number
  ): 'verified' | 'community' | 'experimental' | 'unknown' {
    // Check for verified owner
    if (input.isVerifiedOwner || VERIFIED_OWNERS.has(input.owner ?? '')) {
      return 'verified'
    }

    // Check for official topic
    if (input.topics?.includes('claude-code-official')) {
      return 'verified'
    }

    // Score-based tiers
    if (score >= 70 && input.stars >= 50 && input.hasLicense) {
      return 'community'
    }

    if (score >= 40 && input.stars >= 5) {
      return 'experimental'
    }

    return 'unknown'
  }

  /**
   * Score stars (logarithmic scale, max weight points)
   */
  private scoreStars(stars: number): number {
    if (stars === 0) return 0
    // Log scale: 1 star = 2 points, 10 stars = 6.6, 100 stars = 13.3, 1000 stars = 15
    return Math.min(this.weights.stars, Math.log10(stars + 1) * 5)
  }

  /**
   * Score forks
   */
  private scoreForks(forks: number): number {
    if (forks === 0) return 0
    return Math.min(this.weights.forks, Math.log10(forks + 1) * 4)
  }

  /**
   * Score watchers
   */
  private scoreWatchers(watchers: number): number {
    if (watchers === 0) return 0
    return Math.min(this.weights.watchers, Math.log10(watchers + 1) * 2)
  }

  /**
   * Score recency (how recently updated)
   */
  private scoreRecency(updatedAt: string): number {
    const updated = new Date(updatedAt)
    const now = new Date()
    const daysSinceUpdate = (now.getTime() - updated.getTime()) / (1000 * 60 * 60 * 24)

    if (daysSinceUpdate <= 7) return this.weights.recency // Updated within a week
    if (daysSinceUpdate <= 30) return this.weights.recency * 0.9 // Within a month
    if (daysSinceUpdate <= 90) return this.weights.recency * 0.7 // Within 3 months
    if (daysSinceUpdate <= 180) return this.weights.recency * 0.5 // Within 6 months
    if (daysSinceUpdate <= 365) return this.weights.recency * 0.3 // Within a year
    return this.weights.recency * 0.1 // Older than a year
  }

  /**
   * Score issue health (ratio of closed to total issues)
   */
  private scoreIssueHealth(openIssues?: number, closedIssues?: number): number {
    if (openIssues === undefined || closedIssues === undefined) {
      return this.weights.issueHealth * 0.5 // Unknown, give partial credit
    }

    const total = openIssues + closedIssues
    if (total === 0) return this.weights.issueHealth * 0.7 // No issues, decent score

    const closeRate = closedIssues / total
    return this.weights.issueHealth * closeRate
  }

  /**
   * Score contributors
   */
  private scoreContributors(contributors: number): number {
    if (contributors === 0) return 0
    if (contributors === 1) return this.weights.contributors * 0.3
    if (contributors <= 3) return this.weights.contributors * 0.6
    if (contributors <= 10) return this.weights.contributors * 0.9
    return this.weights.contributors
  }

  /**
   * Score README presence
   */
  private scoreReadme(hasReadme: boolean): number {
    return hasReadme ? this.weights.readme : 0
  }

  /**
   * Score SKILL.md presence and quality
   */
  private scoreSkillFile(hasSkillFile: boolean, length: number): number {
    if (!hasSkillFile) return 0
    if (length === 0) return this.weights.skillFile * 0.5

    // Score based on content length (more comprehensive is better)
    if (length < 500) return this.weights.skillFile * 0.6
    if (length < 1000) return this.weights.skillFile * 0.8
    if (length < 3000) return this.weights.skillFile * 0.9
    return this.weights.skillFile
  }

  /**
   * Score license
   */
  private scoreLicense(license: string | null | undefined): number {
    if (!license) return 0
    if (APPROVED_LICENSES.has(license)) return this.weights.license
    return this.weights.license * 0.5 // Unknown license gets partial credit
  }

  /**
   * Score description quality
   */
  private scoreDescription(length: number): number {
    if (length === 0) return 0
    if (length < 20) return this.weights.description * 0.3
    if (length < 50) return this.weights.description * 0.6
    if (length < 150) return this.weights.description * 0.9
    return this.weights.description
  }

  /**
   * Score verified owner
   */
  private scoreVerifiedOwner(owner?: string, isVerified?: boolean): number {
    if (isVerified) return this.weights.verifiedOwner
    if (owner && VERIFIED_OWNERS.has(owner)) return this.weights.verifiedOwner
    return 0
  }

  /**
   * Score topics
   */
  private scoreTopics(topics: string[]): number {
    if (topics.length === 0) return 0

    let score = 0
    const relevantTopics = ['claude-skill', 'claude-code', 'claude-code-skill', 'mcp', 'anthropic']

    for (const topic of topics) {
      if (relevantTopics.some((rt) => topic.toLowerCase().includes(rt))) {
        score += 1
      }
    }

    return Math.min(this.weights.topics, score * 1.5)
  }

  /**
   * Score content quality based on presence of key sections
   */
  private scoreContentQuality(input: QualityScoringInput): number {
    let score = 0

    if (input.hasExamples) score += this.weights.contentQuality * 0.4
    if (input.hasTroubleshooting) score += this.weights.contentQuality * 0.3
    if (input.hasPrerequisites) score += this.weights.contentQuality * 0.3

    return score
  }
}

/**
 * Quick score calculation with minimal inputs
 */
export function quickScore(stars: number, forks: number, updatedAt: string): number {
  const scorer = new QualityScorer()
  const result = scorer.calculate({
    stars,
    forks,
    updatedAt,
    createdAt: updatedAt, // Use same as updated if unknown
    hasReadme: true,
    hasSkillFile: true,
  })
  return result.total
}

/**
 * Calculate score from GitHub repository data
 */
export function scoreFromRepository(repo: {
  stars: number
  forks: number
  watchers?: number
  updatedAt: string
  createdAt: string
  topics?: string[]
  owner?: string
  license?: string | null
  description?: string | null
  openIssues?: number
}): QualityScoreBreakdown {
  const scorer = new QualityScorer()
  return scorer.calculate({
    stars: repo.stars,
    forks: repo.forks,
    watchers: repo.watchers,
    updatedAt: repo.updatedAt,
    createdAt: repo.createdAt,
    topics: repo.topics,
    owner: repo.owner,
    license: repo.license,
    descriptionLength: repo.description?.length ?? 0,
    hasReadme: true, // Assume true for GitHub repos
    hasSkillFile: true, // Assume true if we're scoring it
    hasLicense: !!repo.license,
    openIssues: repo.openIssues,
  })
}
