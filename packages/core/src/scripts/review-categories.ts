/**
 * SMI-1757: Refined Category Mapping for Lenny Skills
 *
 * Specific and meaningful categories for product management skills.
 * Avoids broad terms like "engineering", "AI & Technology", "Hiring & Teams"
 *
 * Extracted from review-lenny-skills.ts for file size compliance.
 */

export interface RefinedCategory {
  category: string
  tags: string[]
}

/**
 * Refined category mapping - specific and meaningful categories
 */
export const REFINED_CATEGORIES: Record<string, RefinedCategory> = {
  // Product Strategy & Planning
  'writing-north-star-metrics': {
    category: 'product-strategy',
    tags: ['metrics', 'okrs', 'alignment'],
  },
  'defining-product-vision': {
    category: 'product-strategy',
    tags: ['vision', 'roadmap', 'planning'],
  },
  'prioritizing-roadmap': {
    category: 'product-strategy',
    tags: ['prioritization', 'roadmap', 'planning'],
  },
  'setting-okrs-goals': { category: 'product-strategy', tags: ['okrs', 'goals', 'metrics'] },
  'competitive-analysis': {
    category: 'product-strategy',
    tags: ['competition', 'market-research', 'strategy'],
  },
  'working-backwards': { category: 'product-strategy', tags: ['amazon', 'planning', 'prfaq'] },
  'product-taste-intuition': {
    category: 'product-strategy',
    tags: ['taste', 'intuition', 'craft'],
  },
  'startup-ideation': { category: 'product-strategy', tags: ['ideation', 'startup', 'ideas'] },
  'startup-pivoting': { category: 'product-strategy', tags: ['pivot', 'startup', 'strategy'] },

  // Product Execution & Shipping
  'writing-prds': { category: 'product-execution', tags: ['prd', 'specs', 'documentation'] },
  'problem-definition': { category: 'product-execution', tags: ['problem-framing', 'discovery'] },
  'writing-specs-designs': {
    category: 'product-execution',
    tags: ['specs', 'design-docs', 'documentation'],
  },
  'scoping-cutting': { category: 'product-execution', tags: ['scoping', 'mvp', 'prioritization'] },
  'shipping-products': {
    category: 'product-execution',
    tags: ['shipping', 'launches', 'execution'],
  },
  'managing-timelines': {
    category: 'product-execution',
    tags: ['timelines', 'project-management', 'deadlines'],
  },
  'product-operations': {
    category: 'product-execution',
    tags: ['product-ops', 'operations', 'process'],
  },
  dogfooding: {
    category: 'product-execution',
    tags: ['dogfooding', 'internal-testing', 'feedback'],
  },

  // User Research & Discovery
  'conducting-user-interviews': {
    category: 'user-research',
    tags: ['interviews', 'discovery', 'qualitative'],
  },
  'designing-surveys': { category: 'user-research', tags: ['surveys', 'quantitative', 'research'] },
  'analyzing-user-feedback': { category: 'user-research', tags: ['feedback', 'analysis', 'voc'] },
  'usability-testing': { category: 'user-research', tags: ['usability', 'testing', 'ux-research'] },
  'behavioral-product-design': {
    category: 'user-research',
    tags: ['behavioral', 'psychology', 'nudges'],
  },

  // Team Leadership & Management
  'running-effective-1-1s': {
    category: 'team-leadership',
    tags: ['one-on-ones', 'management', 'coaching'],
  },
  'having-difficult-conversations': {
    category: 'team-leadership',
    tags: ['feedback', 'difficult-conversations', 'management'],
  },
  'delegating-work': {
    category: 'team-leadership',
    tags: ['delegation', 'leverage', 'management'],
  },
  'managing-up': {
    category: 'team-leadership',
    tags: ['managing-up', 'stakeholders', 'influence'],
  },
  'coaching-pms': {
    category: 'team-leadership',
    tags: ['coaching', 'mentoring', 'pm-development'],
  },
  'building-team-culture': {
    category: 'team-leadership',
    tags: ['culture', 'team-building', 'values'],
  },
  'team-rituals': {
    category: 'team-leadership',
    tags: ['rituals', 'ceremonies', 'team-practices'],
  },
  'energy-management': {
    category: 'team-leadership',
    tags: ['energy', 'burnout', 'sustainability'],
  },

  // Talent & Recruiting (more specific than "Hiring & Teams")
  'writing-job-descriptions': {
    category: 'talent-recruiting',
    tags: ['job-descriptions', 'recruiting', 'hiring'],
  },
  'conducting-interviews': {
    category: 'talent-recruiting',
    tags: ['interviewing', 'hiring', 'assessment'],
  },
  'evaluating-candidates': {
    category: 'talent-recruiting',
    tags: ['evaluation', 'hiring', 'assessment'],
  },
  'onboarding-new-hires': {
    category: 'talent-recruiting',
    tags: ['onboarding', 'new-hires', 'ramping'],
  },

  // Decision Making & Execution
  'running-decision-processes': {
    category: 'decision-making',
    tags: ['decisions', 'frameworks', 'process'],
  },
  'planning-under-uncertainty': {
    category: 'decision-making',
    tags: ['uncertainty', 'risk', 'planning'],
  },
  'evaluating-trade-offs': {
    category: 'decision-making',
    tags: ['trade-offs', 'analysis', 'decisions'],
  },
  'post-mortems-retrospectives': {
    category: 'decision-making',
    tags: ['retrospectives', 'learning', 'post-mortems'],
  },
  'systems-thinking': { category: 'decision-making', tags: ['systems', 'complexity', 'thinking'] },

  // Cross-functional & Org Design
  'cross-functional-collaboration': {
    category: 'org-effectiveness',
    tags: ['cross-functional', 'collaboration', 'alignment'],
  },
  'organizational-design': {
    category: 'org-effectiveness',
    tags: ['org-design', 'structure', 'scaling'],
  },
  'organizational-transformation': {
    category: 'org-effectiveness',
    tags: ['transformation', 'change-management', 'culture'],
  },

  // Communication & Influence
  'giving-presentations': {
    category: 'communication',
    tags: ['presentations', 'public-speaking', 'storytelling'],
  },
  'written-communication': {
    category: 'communication',
    tags: ['writing', 'documentation', 'async'],
  },
  'stakeholder-alignment': {
    category: 'communication',
    tags: ['stakeholders', 'alignment', 'influence'],
  },
  'running-offsites': { category: 'communication', tags: ['offsites', 'team-events', 'planning'] },
  'running-effective-meetings': {
    category: 'communication',
    tags: ['meetings', 'facilitation', 'efficiency'],
  },

  // Growth & Metrics
  'measuring-product-market-fit': {
    category: 'growth-metrics',
    tags: ['pmf', 'product-market-fit', 'validation'],
  },
  'designing-growth-loops': {
    category: 'growth-metrics',
    tags: ['growth-loops', 'virality', 'acquisition'],
  },
  'pricing-strategy': { category: 'growth-metrics', tags: ['pricing', 'monetization', 'strategy'] },
  'retention-engagement': {
    category: 'growth-metrics',
    tags: ['retention', 'engagement', 'churn'],
  },
  'marketplace-liquidity': {
    category: 'growth-metrics',
    tags: ['marketplace', 'liquidity', 'supply-demand'],
  },
  'user-onboarding': {
    category: 'growth-metrics',
    tags: ['onboarding', 'activation', 'first-run'],
  },

  // Go-to-Market & Sales
  'positioning-messaging': {
    category: 'go-to-market',
    tags: ['positioning', 'messaging', 'branding'],
  },
  'brand-storytelling': { category: 'go-to-market', tags: ['storytelling', 'brand', 'narrative'] },
  'launch-marketing': { category: 'go-to-market', tags: ['launches', 'marketing', 'gtm'] },
  'content-marketing': { category: 'go-to-market', tags: ['content', 'marketing', 'distribution'] },
  'community-building': { category: 'go-to-market', tags: ['community', 'engagement', 'advocacy'] },
  'media-relations': { category: 'go-to-market', tags: ['pr', 'media', 'press'] },
  'founder-sales': { category: 'go-to-market', tags: ['sales', 'founder-led', 'b2b'] },
  'building-sales-team': { category: 'go-to-market', tags: ['sales-team', 'hiring', 'scaling'] },
  'enterprise-sales': { category: 'go-to-market', tags: ['enterprise', 'sales', 'b2b'] },
  'partnership-bd': { category: 'go-to-market', tags: ['partnerships', 'bd', 'alliances'] },
  'product-led-sales': { category: 'go-to-market', tags: ['pls', 'product-led', 'sales'] },
  'sales-compensation': { category: 'go-to-market', tags: ['compensation', 'incentives', 'sales'] },
  'sales-qualification': {
    category: 'go-to-market',
    tags: ['qualification', 'discovery', 'sales'],
  },

  // Career Development
  'building-a-promotion-case': {
    category: 'career-development',
    tags: ['promotions', 'career', 'growth'],
  },
  'negotiating-offers': {
    category: 'career-development',
    tags: ['negotiation', 'offers', 'compensation'],
  },
  'finding-mentors-sponsors': {
    category: 'career-development',
    tags: ['mentorship', 'sponsorship', 'networking'],
  },
  'career-transitions': {
    category: 'career-development',
    tags: ['transitions', 'career-change', 'job-search'],
  },
  'managing-imposter-syndrome': {
    category: 'career-development',
    tags: ['imposter-syndrome', 'confidence', 'mindset'],
  },
  'personal-productivity': {
    category: 'career-development',
    tags: ['productivity', 'time-management', 'efficiency'],
  },
  fundraising: { category: 'career-development', tags: ['fundraising', 'vc', 'startup'] },

  // LLM & AI Products (specific, not generic "AI")
  'ai-product-strategy': {
    category: 'llm-products',
    tags: ['ai-strategy', 'ml-products', 'ai-roadmap'],
  },
  'building-with-llms': { category: 'llm-products', tags: ['llm', 'gpt', 'ai-development'] },
  'evaluating-new-technology': {
    category: 'llm-products',
    tags: ['tech-evaluation', 'adoption', 'innovation'],
  },
  'platform-strategy': { category: 'llm-products', tags: ['platform', 'ecosystem', 'api'] },
  'vibe-coding': { category: 'llm-products', tags: ['vibe-coding', 'ai-assisted', 'no-code'] },
  'ai-evals': { category: 'llm-products', tags: ['evals', 'ai-testing', 'benchmarks'] },

  // Technical Leadership (specific, not generic "engineering")
  'technical-roadmaps': {
    category: 'technical-leadership',
    tags: ['tech-roadmap', 'architecture', 'planning'],
  },
  'managing-tech-debt': {
    category: 'technical-leadership',
    tags: ['tech-debt', 'refactoring', 'maintenance'],
  },
  'platform-infrastructure': {
    category: 'technical-leadership',
    tags: ['infrastructure', 'platform', 'scalability'],
  },
  'engineering-culture': {
    category: 'technical-leadership',
    tags: ['eng-culture', 'practices', 'excellence'],
  },
  'design-engineering': {
    category: 'technical-leadership',
    tags: ['design-engineering', 'craft', 'frontend'],
  },

  // Design Excellence (specific, not generic "design")
  'design-systems': {
    category: 'design-excellence',
    tags: ['design-systems', 'components', 'consistency'],
  },
  'running-design-reviews': {
    category: 'design-excellence',
    tags: ['design-reviews', 'critique', 'quality'],
  },
}

/**
 * Author attribution for Lenny skills
 */
export const AUTHOR_INFO = {
  author: 'sidbharath',
  authorName: 'Sid Bharath',
  organization: 'Refound AI',
  githubUrl: 'https://github.com/sidbharath',
  blogUrl: 'https://sidbharath.com/blog/building-lenny-skills-database/',
  sourceUrl: 'https://refoundai.com/lenny-skills/',
  license: 'CC BY 4.0', // Assuming - Lenny's transcripts are public
}

/**
 * Approval criteria for auto-approving skills
 */
export const APPROVAL_CRITERIA = {
  minGuestCount: 10, // Auto-approve skills with 10+ expert guests
  minInsightCount: 15, // Or 15+ insights
  minQualityScore: 0.85, // Or high quality score
}

/**
 * Get refined category and tags for a skill
 */
export function getRefinedCategoryAndTags(slug: string): RefinedCategory {
  const refined = REFINED_CATEGORIES[slug]
  if (refined) {
    return refined
  }
  // Fallback
  return { category: 'product-management', tags: ['product', 'strategy'] }
}
