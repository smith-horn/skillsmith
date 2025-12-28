/**
 * SMI-630: TTL Manager - Configurable TTL per cache type
 *
 * Default TTL values:
 * - Search results: 1 hour
 * - Skill details: 24 hours
 * - Popular queries: 4 hours
 */

export enum CacheType {
  SEARCH_RESULTS = 'search_results',
  SKILL_DETAILS = 'skill_details',
  POPULAR_QUERIES = 'popular_queries',
  SUGGESTIONS = 'suggestions',
  SIMILAR_SKILLS = 'similar_skills',
  CUSTOM = 'custom',
}

export interface TTLConfig {
  /** TTL in seconds */
  ttl: number
  /** L1 TTL in milliseconds (defaults to 5 minutes) */
  l1Ttl?: number
  /** Whether this cache type should be persisted to L2 */
  persistToL2?: boolean
}

const DEFAULT_TTL_CONFIGS: Record<CacheType, TTLConfig> = {
  [CacheType.SEARCH_RESULTS]: {
    ttl: 3600, // 1 hour
    l1Ttl: 5 * 60 * 1000, // 5 minutes
    persistToL2: true,
  },
  [CacheType.SKILL_DETAILS]: {
    ttl: 86400, // 24 hours
    l1Ttl: 30 * 60 * 1000, // 30 minutes
    persistToL2: true,
  },
  [CacheType.POPULAR_QUERIES]: {
    ttl: 14400, // 4 hours
    l1Ttl: 15 * 60 * 1000, // 15 minutes
    persistToL2: true,
  },
  [CacheType.SUGGESTIONS]: {
    ttl: 1800, // 30 minutes
    l1Ttl: 5 * 60 * 1000, // 5 minutes
    persistToL2: false,
  },
  [CacheType.SIMILAR_SKILLS]: {
    ttl: 7200, // 2 hours
    l1Ttl: 10 * 60 * 1000, // 10 minutes
    persistToL2: true,
  },
  [CacheType.CUSTOM]: {
    ttl: 3600, // 1 hour default
    l1Ttl: 5 * 60 * 1000,
    persistToL2: true,
  },
}

export class TTLManager {
  private configs: Map<CacheType, TTLConfig>
  private customConfigs: Map<string, TTLConfig>

  constructor(overrides?: Partial<Record<CacheType, Partial<TTLConfig>>>) {
    this.configs = new Map()
    this.customConfigs = new Map()

    // Initialize with defaults
    for (const [type, config] of Object.entries(DEFAULT_TTL_CONFIGS)) {
      this.configs.set(type as CacheType, { ...config })
    }

    // Apply overrides
    if (overrides) {
      for (const [type, override] of Object.entries(overrides)) {
        const existing = this.configs.get(type as CacheType)
        if (existing) {
          this.configs.set(type as CacheType, { ...existing, ...override })
        }
      }
    }
  }

  /**
   * Get TTL config for a cache type
   */
  getConfig(type: CacheType): TTLConfig {
    return this.configs.get(type) ?? DEFAULT_TTL_CONFIGS[CacheType.CUSTOM]
  }

  /**
   * Get TTL in seconds for a cache type
   */
  getTTL(type: CacheType): number {
    return this.getConfig(type).ttl
  }

  /**
   * Get L1 TTL in milliseconds for a cache type
   */
  getL1TTL(type: CacheType): number {
    return this.getConfig(type).l1Ttl ?? 5 * 60 * 1000
  }

  /**
   * Check if a cache type should persist to L2
   */
  shouldPersistToL2(type: CacheType): boolean {
    return this.getConfig(type).persistToL2 ?? true
  }

  /**
   * Check if a timestamp has expired for a cache type
   */
  isExpired(type: CacheType, createdAt: number): boolean {
    const ttlMs = this.getTTL(type) * 1000
    return Date.now() - createdAt > ttlMs
  }

  /**
   * Get expiration timestamp for a cache type
   */
  getExpirationTime(type: CacheType): number {
    return Date.now() + this.getTTL(type) * 1000
  }

  /**
   * Set custom TTL for a specific key pattern
   */
  setCustomTTL(keyPattern: string, config: TTLConfig): void {
    this.customConfigs.set(keyPattern, config)
  }

  /**
   * Get TTL for a specific key (checks custom configs first)
   */
  getTTLForKey(key: string, defaultType: CacheType = CacheType.CUSTOM): number {
    // Check custom configs by pattern matching
    for (const [pattern, config] of this.customConfigs) {
      if (key.startsWith(pattern) || key.includes(pattern)) {
        return config.ttl
      }
    }

    // Fall back to type-based TTL
    return this.getTTL(defaultType)
  }

  /**
   * Update config for a cache type
   */
  updateConfig(type: CacheType, updates: Partial<TTLConfig>): void {
    const existing = this.getConfig(type)
    this.configs.set(type, { ...existing, ...updates })
  }

  /**
   * Get all configs (for debugging/monitoring)
   */
  getAllConfigs(): Record<CacheType, TTLConfig> {
    const result: Partial<Record<CacheType, TTLConfig>> = {}
    for (const [type, config] of this.configs) {
      result[type] = config
    }
    return result as Record<CacheType, TTLConfig>
  }
}

export default TTLManager
