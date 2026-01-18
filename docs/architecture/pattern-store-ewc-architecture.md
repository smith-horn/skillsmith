# PatternStore with EWC++ Architecture

**Issue**: SMI-1522: Add EWC++ pattern storage for successful matches
**Target**: 95%+ pattern preservation during updates
**Date**: January 2026

## Executive Summary

PatternStore implements Elastic Weight Consolidation++ (EWC++) to store successful recommendation patterns without catastrophic forgetting. Unlike traditional storage that overwrites old patterns, EWC++ preserves important learned patterns while integrating new ones.

### Key Capabilities

- **storePattern()**: Encodes successful matches with Fisher Information tracking
- **findSimilarPatterns()**: Retrieves relevant patterns using importance-weighted similarity
- **consolidate()**: Updates Fisher Information matrix without forgetting important patterns
- **95%+ pattern preservation**: New patterns do not overwrite important historical patterns

---

## 1. Class Diagram

```
+============================================================================+
|                              PatternStore                                   |
+============================================================================+
| - config: PatternStoreConfig                                                |
| - db: Database (better-sqlite3)                                             |
| - fisherMatrix: FisherInformationMatrix                                     |
| - patternEncoder: PatternEncoder                                            |
| - consolidationState: ConsolidationState                                    |
| - metrics: PatternMetrics                                                   |
+============================================================================+
| + initialize(): Promise<void>                                               |
| + storePattern(pattern: Pattern, outcome: PatternOutcome): Promise<string>  |
| + findSimilarPatterns(query: PatternQuery, limit?: number): SimilarPattern[]|
| + consolidate(): Promise<ConsolidationResult>                               |
| + getPatternImportance(patternId: string): number                           |
| + getMetrics(): PatternStoreMetrics                                         |
| + close(): void                                                             |
+============================================================================+
           |                    |                      |
           v                    v                      v
+-------------------+  +------------------------+  +----------------------+
|  PatternEncoder   |  | FisherInformationMatrix|  |  ConsolidationState  |
+-------------------+  +------------------------+  +----------------------+
| - dimensions: 384 |  | - diagonal: Float32[]  |  | - lastConsolidation  |
| - model: MiniLM   |  | - runningSum: Float32[]|  | - totalPatterns      |
+-------------------+  | - decayFactor: number  |  | - preservationRate   |
| + encode(ctx)     |  +------------------------+  +----------------------+
| + similarity()    |  | + update(gradient)     |  | + shouldConsolidate()|
| + interpolate()   |  | + getImportance(idx)   |  | + recordOutcome()    |
+-------------------+  | + decay()              |  +----------------------+
                       | + serialize/deserialize|
                       +------------------------+

+============================================================================+
|                          Integration Layer                                  |
+============================================================================+

+------------------------+    +------------------------+    +----------------+
| ReasoningBankIntegration|    |       SONARouter       |    | SignalCollector|
+------------------------+    +------------------------+    +----------------+
         |                              |                           |
         | trajectories                 | routing decisions         | signals
         |                              |                           |
         +--------------------+  +------+---------------------------+
                              |  |
                              v  v
                    +-----------------------+
                    |     PatternStore      |
                    +-----------------------+
                    | Successful patterns   |
                    | with EWC++ protection |
                    +-----------------------+

+============================================================================+
|                         Storage Layer (SQLite)                              |
+============================================================================+

+------------------------+    +------------------------+    +----------------+
|    patterns table      |    |  fisher_info table     |    | consolidation_ |
+------------------------+    +------------------------+    | history table  |
| pattern_id TEXT PK     |    | dimension_idx INTEGER  |    +----------------+
| context_embedding BLOB |    | importance REAL        |    | timestamp INT  |
| skill_id TEXT          |    | running_sum REAL       |    | patterns_count |
| skill_features JSON    |    | updated_at INTEGER     |    | preservation   |
| outcome_type TEXT      |    +------------------------+    +----------------+
| outcome_reward REAL    |
| importance REAL        |
| created_at INTEGER     |
| access_count INTEGER   |
+------------------------+
```

---

## 2. TypeScript Interface Definitions

### 2.1 Core Configuration

```typescript
/**
 * @fileoverview PatternStore with EWC++ for catastrophic forgetting prevention
 * @module @skillsmith/core/learning/PatternStore
 * @see SMI-1522: Add EWC++ pattern storage for successful matches
 */

/**
 * EWC++ algorithm configuration
 *
 * @see https://arxiv.org/abs/1801.10112 (Progress & Compress)
 */
export interface EWCConfig {
  /**
   * Lambda (regularization strength).
   * Higher values = stronger preservation of old patterns.
   *
   * - 0.1-1.0: Allows more plasticity (learning new patterns)
   * - 1.0-10.0: Balanced preservation and learning
   * - 10.0-100.0: Strong preservation (minimal forgetting)
   *
   * @default 5.0
   */
  lambda: number;

  /**
   * Decay factor for online Fisher Information updates.
   * Applied to running sum before adding new gradient squared.
   *
   * - 0.9: Fast decay, recent patterns dominate
   * - 0.99: Slow decay, historical patterns preserved longer
   * - 1.0: No decay (original EWC, not recommended)
   *
   * @default 0.95
   */
  fisherDecay: number;

  /**
   * Minimum importance threshold for pattern preservation.
   * Patterns below this threshold are eligible for overwriting.
   *
   * @default 0.01
   */
  importanceThreshold: number;

  /**
   * Number of patterns to sample for Fisher Information estimation.
   * Higher values = more accurate importance estimates but slower.
   *
   * @default 100
   */
  fisherSampleSize: number;

  /**
   * Consolidation trigger threshold.
   * Consolidate when (new_patterns / total_patterns) exceeds this.
   *
   * @default 0.1 (10%)
   */
  consolidationThreshold: number;

  /**
   * Maximum patterns to retain before pruning low-importance ones.
   *
   * @default 10000
   */
  maxPatterns: number;
}

/**
 * PatternStore configuration
 */
export interface PatternStoreConfig {
  /**
   * Path to SQLite database for pattern storage.
   * If not provided, uses in-memory database.
   */
  dbPath?: string;

  /**
   * EWC++ algorithm parameters.
   */
  ewc?: Partial<EWCConfig>;

  /**
   * Embedding dimensions (must match embedding model).
   * @default 384 (all-MiniLM-L6-v2)
   */
  dimensions?: number;

  /**
   * Enable automatic consolidation on pattern insertion.
   * @default true
   */
  autoConsolidate?: boolean;

  /**
   * Enable pattern access tracking for importance boosting.
   * @default true
   */
  trackAccess?: boolean;

  /**
   * Enable V3 ReasoningBank integration.
   * @default true (auto-detect)
   */
  useV3Integration?: boolean;
}

/**
 * Default EWC++ configuration
 */
export const DEFAULT_EWC_CONFIG: EWCConfig = {
  lambda: 5.0,
  fisherDecay: 0.95,
  importanceThreshold: 0.01,
  fisherSampleSize: 100,
  consolidationThreshold: 0.1,
  maxPatterns: 10000,
};

/**
 * Default PatternStore configuration
 */
export const DEFAULT_PATTERN_STORE_CONFIG: Required<PatternStoreConfig> = {
  dbPath: undefined as unknown as string,
  ewc: DEFAULT_EWC_CONFIG,
  dimensions: 384,
  autoConsolidate: true,
  trackAccess: true,
  useV3Integration: true,
};
```

### 2.2 Pattern Definition Interface

```typescript
/**
 * Pattern outcome types aligned with ReasoningBankIntegration rewards
 *
 * @see ReasoningBankIntegration.TRAJECTORY_REWARDS
 */
export type PatternOutcomeType =
  | 'accept'      // User accepted recommendation (+1.0)
  | 'usage'       // User actively uses skill (+0.3)
  | 'frequent'    // User uses skill frequently (+0.5)
  | 'dismiss'     // User dismissed recommendation (-0.5)
  | 'abandonment' // Skill installed but unused (-0.3)
  | 'uninstall';  // User removed skill (-0.7)

/**
 * Outcome result for a pattern
 */
export interface PatternOutcome {
  /** Type of outcome */
  type: PatternOutcomeType;

  /** Reward value [-1.0, 1.0] */
  reward: number;

  /** Confidence in this outcome (for partial observations) */
  confidence?: number;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Reward values for pattern outcomes
 * Matches ReasoningBankIntegration.TRAJECTORY_REWARDS
 */
export const PATTERN_REWARDS: Record<PatternOutcomeType, number> = {
  accept: 1.0,
  usage: 0.3,
  frequent: 0.5,
  dismiss: -0.5,
  abandonment: -0.3,
  uninstall: -0.7,
};

/**
 * Context that led to a recommendation
 */
export interface RecommendationContext {
  /** User's current installed skills */
  installedSkills: string[];

  /** Frameworks/languages detected in project */
  frameworks?: string[];

  /** Keywords from user query or context */
  keywords?: string[];

  /** Time of day (for temporal patterns) */
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';

  /** Day type (for usage patterns) */
  dayType?: 'weekday' | 'weekend';

  /** Session duration in minutes */
  sessionDuration?: number;

  /** Number of recommendations shown in session */
  recommendationsShown?: number;
}

/**
 * Skill features used in pattern matching
 */
export interface SkillFeatures {
  /** Skill identifier (author/name format) */
  skillId: string;

  /** Skill category */
  category?: string;

  /** Trust tier (verified, community, experimental) */
  trustTier?: string;

  /** Skill keywords/tags */
  keywords?: string[];

  /** Trigger phrases */
  triggerPhrases?: string[];

  /** Quality score [0-100] */
  qualityScore?: number;

  /** Install count */
  installCount?: number;
}

/**
 * Complete pattern definition
 */
export interface Pattern {
  /** Unique pattern identifier (auto-generated if not provided) */
  id?: string;

  /** Recommendation context that led to this match */
  context: RecommendationContext;

  /** Skill that was recommended */
  skill: SkillFeatures;

  /** Original recommendation score [0-1] */
  originalScore: number;

  /** Source of the recommendation (search, recommend, install) */
  source: 'search' | 'recommend' | 'install' | 'compare';
}

/**
 * Stored pattern with computed fields
 */
export interface StoredPattern extends Pattern {
  /** Pattern ID (guaranteed after storage) */
  id: string;

  /** Context embedding vector */
  contextEmbedding: Float32Array;

  /** Pattern outcome */
  outcome: PatternOutcome;

  /** Pattern importance (from Fisher Information) */
  importance: number;

  /** Number of times this pattern was accessed */
  accessCount: number;

  /** Creation timestamp */
  createdAt: Date;

  /** Last access timestamp */
  lastAccessedAt: Date;
}

/**
 * Pattern query for similarity search
 */
export interface PatternQuery {
  /** Context to match against */
  context: RecommendationContext;

  /** Optional skill to filter by */
  skillId?: string;

  /** Optional category filter */
  category?: string;

  /** Minimum importance threshold */
  minImportance?: number;

  /** Outcome type filter */
  outcomeType?: PatternOutcomeType;

  /** Only positive outcomes (accept, usage, frequent) */
  positiveOnly?: boolean;
}

/**
 * Similar pattern result
 */
export interface SimilarPattern {
  /** The matched pattern */
  pattern: StoredPattern;

  /** Similarity score [0-1] */
  similarity: number;

  /** Importance-weighted similarity */
  weightedSimilarity: number;

  /** Rank in results */
  rank: number;
}
```

### 2.3 Fisher Information Matrix Interface

```typescript
/**
 * Fisher Information Matrix for EWC++
 *
 * Stores diagonal approximation of Fisher Information,
 * indicating which "weights" (pattern dimensions) are important.
 *
 * In the context of pattern storage:
 * - Each dimension of the context embedding has an importance value
 * - High importance = changing this dimension would harm prediction
 * - Low importance = safe to overwrite with new patterns
 */
export interface IFisherInformationMatrix {
  /**
   * Get importance value for a specific dimension.
   *
   * @param dimensionIndex - Index in the embedding vector
   * @returns Importance value [0, infinity)
   */
  getImportance(dimensionIndex: number): number;

  /**
   * Update Fisher Information with new gradient observation.
   *
   * For EWC++, this uses online update:
   * F_new = decay * F_old + gradient^2
   *
   * @param gradient - Gradient vector (embedding difference)
   */
  update(gradient: Float32Array): void;

  /**
   * Apply decay to all importance values.
   * Called periodically to allow new patterns to gain importance.
   *
   * @param decayFactor - Multiplier (0.9-0.99)
   */
  decay(decayFactor: number): void;

  /**
   * Get full importance vector.
   *
   * @returns Copy of importance values for all dimensions
   */
  getImportanceVector(): Float32Array;

  /**
   * Get average importance across all dimensions.
   */
  getAverageImportance(): number;

  /**
   * Serialize for persistence.
   */
  serialize(): Buffer;

  /**
   * Deserialize from persistence.
   */
  deserialize(buffer: Buffer): void;

  /**
   * Reset all importance values to zero.
   */
  reset(): void;
}

/**
 * Fisher Information Matrix implementation
 */
export class FisherInformationMatrix implements IFisherInformationMatrix {
  /** Diagonal of Fisher Information (importance per dimension) */
  private importance: Float32Array;

  /** Running sum for online updates */
  private runningSum: Float32Array;

  /** Number of updates performed */
  private updateCount: number = 0;

  constructor(dimensions: number) {
    this.importance = new Float32Array(dimensions);
    this.runningSum = new Float32Array(dimensions);
  }

  getImportance(dimensionIndex: number): number {
    return this.importance[dimensionIndex] ?? 0;
  }

  update(gradient: Float32Array): void {
    // EWC++: F = decay * F + gradient^2
    for (let i = 0; i < gradient.length; i++) {
      this.runningSum[i] += gradient[i] * gradient[i];
    }
    this.updateCount++;

    // Update importance as running mean
    for (let i = 0; i < this.importance.length; i++) {
      this.importance[i] = this.runningSum[i] / this.updateCount;
    }
  }

  decay(decayFactor: number): void {
    for (let i = 0; i < this.runningSum.length; i++) {
      this.runningSum[i] *= decayFactor;
    }
    // Recalculate importance after decay
    for (let i = 0; i < this.importance.length; i++) {
      this.importance[i] = this.runningSum[i] / Math.max(1, this.updateCount);
    }
  }

  getImportanceVector(): Float32Array {
    return new Float32Array(this.importance);
  }

  getAverageImportance(): number {
    let sum = 0;
    for (let i = 0; i < this.importance.length; i++) {
      sum += this.importance[i];
    }
    return sum / this.importance.length;
  }

  serialize(): Buffer {
    const buffer = Buffer.alloc(
      4 + // updateCount
      4 * this.importance.length + // importance
      4 * this.runningSum.length   // runningSum
    );

    buffer.writeUInt32LE(this.updateCount, 0);
    Buffer.from(this.importance.buffer).copy(buffer, 4);
    Buffer.from(this.runningSum.buffer).copy(buffer, 4 + 4 * this.importance.length);

    return buffer;
  }

  deserialize(buffer: Buffer): void {
    this.updateCount = buffer.readUInt32LE(0);
    const importanceBytes = buffer.slice(4, 4 + 4 * this.importance.length);
    const runningSumBytes = buffer.slice(4 + 4 * this.importance.length);

    this.importance = new Float32Array(
      importanceBytes.buffer.slice(
        importanceBytes.byteOffset,
        importanceBytes.byteOffset + importanceBytes.byteLength
      )
    );
    this.runningSum = new Float32Array(
      runningSumBytes.buffer.slice(
        runningSumBytes.byteOffset,
        runningSumBytes.byteOffset + runningSumBytes.byteLength
      )
    );
  }

  reset(): void {
    this.importance.fill(0);
    this.runningSum.fill(0);
    this.updateCount = 0;
  }
}
```

### 2.4 Consolidation State Interface

```typescript
/**
 * Consolidation operation result
 */
export interface ConsolidationResult {
  /** Whether consolidation was performed */
  consolidated: boolean;

  /** Patterns processed during consolidation */
  patternsProcessed: number;

  /** Patterns preserved (importance above threshold) */
  patternsPreserved: number;

  /** Patterns pruned (importance below threshold) */
  patternsPruned: number;

  /** Preservation rate (should be >= 0.95) */
  preservationRate: number;

  /** Time taken in milliseconds */
  durationMs: number;

  /** New average importance after consolidation */
  averageImportance: number;
}

/**
 * Consolidation state tracking
 */
export interface ConsolidationState {
  /** Last consolidation timestamp */
  lastConsolidation: Date | null;

  /** Total patterns since last consolidation */
  patternsSinceLastConsolidation: number;

  /** Total patterns in store */
  totalPatterns: number;

  /** Historical preservation rates */
  preservationHistory: Array<{
    timestamp: Date;
    rate: number;
    patternsProcessed: number;
  }>;
}

/**
 * PatternStore metrics for monitoring
 */
export interface PatternStoreMetrics {
  /** Total patterns stored */
  totalPatterns: number;

  /** Patterns by outcome type */
  patternsByOutcome: Record<PatternOutcomeType, number>;

  /** Average pattern importance */
  averageImportance: number;

  /** High importance patterns (above 90th percentile) */
  highImportancePatterns: number;

  /** Consolidation statistics */
  consolidation: {
    totalConsolidations: number;
    lastConsolidation: Date | null;
    averagePreservationRate: number;
    patternsPruned: number;
  };

  /** Storage statistics */
  storage: {
    sizeBytes: number;
    fisherMatrixSizeBytes: number;
  };

  /** Query performance */
  queryPerformance: {
    averageLatencyMs: number;
    cacheHitRate: number;
  };
}
```

---

## 3. EWC++ Algorithm Pseudocode

### 3.1 Core EWC++ Algorithm

```
ALGORITHM: EWC++ Pattern Consolidation

PURPOSE: Preserve important patterns while allowing new pattern learning
         Achieves 95%+ pattern preservation during updates

MATHEMATICAL FOUNDATION:
  - Original EWC loss: L_total = L_new + (lambda/2) * sum_i(F_i * (theta_i - theta*_i)^2)
  - EWC++ modification: F_online = decay * F_old + gradient^2

  Where:
  - L_new = loss for new patterns
  - F_i = Fisher Information for dimension i (importance)
  - theta_i = current parameter
  - theta*_i = optimal parameter from previous tasks
  - lambda = regularization strength

ADAPTED FOR PATTERN STORAGE:
  - "Parameters" = pattern embeddings
  - "Gradient" = embedding difference between new and stored pattern
  - "Loss" = similarity distance for retrieval
  - "Importance" = frequency * recency * outcome_strength
```

### 3.2 storePattern() Algorithm

```
ALGORITHM: storePattern

INPUT:
  - pattern: Pattern (context, skill, original score)
  - outcome: PatternOutcome (type, reward, confidence)
  - config: EWCConfig

OUTPUT:
  - patternId: string

PROCEDURE:

1. ENCODE CONTEXT
   contextEmbedding = patternEncoder.encode(pattern.context)
   // 384-dimensional vector representing the recommendation context

2. CHECK FOR SIMILAR EXISTING PATTERN
   existingPatterns = findSimilarPatterns({
     context: pattern.context,
     skillId: pattern.skill.skillId,
     positiveOnly: false
   }, limit=5)

   IF existingPatterns.length > 0 AND existingPatterns[0].similarity > 0.95:
     // Update existing pattern instead of creating new
     existingPattern = existingPatterns[0].pattern

     // Calculate gradient (difference between embeddings)
     gradient = contextEmbedding - existingPattern.contextEmbedding

     // Update Fisher Information with gradient
     fisherMatrix.update(gradient)

     // Update existing pattern's importance and access count
     newImportance = calculateImportance(existingPattern, outcome)
     updatePatternInDB(existingPattern.id, {
       importance: newImportance,
       accessCount: existingPattern.accessCount + 1,
       lastAccessedAt: now()
     })

     RETURN existingPattern.id

3. CALCULATE INITIAL IMPORTANCE
   // Base importance from outcome reward
   baseImportance = abs(outcome.reward)

   // Boost for positive outcomes (we want to remember successes)
   IF outcome.reward > 0:
     baseImportance = baseImportance * 1.5

   // Confidence adjustment
   IF outcome.confidence:
     baseImportance = baseImportance * outcome.confidence

   // Initial importance
   importance = baseImportance * config.importanceThreshold * 10

4. STORE NEW PATTERN
   patternId = generateUUID()

   INSERT INTO patterns {
     pattern_id: patternId,
     context_embedding: contextEmbedding.buffer,
     skill_id: pattern.skill.skillId,
     skill_features: JSON.stringify(pattern.skill),
     outcome_type: outcome.type,
     outcome_reward: outcome.reward,
     importance: importance,
     original_score: pattern.originalScore,
     source: pattern.source,
     created_at: unixepoch(),
     access_count: 0
   }

5. UPDATE FISHER INFORMATION
   // For new patterns, compute gradient from average stored embedding
   averageEmbedding = computeAverageEmbedding()
   gradient = contextEmbedding - averageEmbedding
   fisherMatrix.update(gradient)

6. TRIGGER CONSOLIDATION IF NEEDED
   consolidationState.patternsSinceLastConsolidation++

   IF shouldConsolidate():
     consolidate()

7. RETURN
   RETURN patternId
```

### 3.3 findSimilarPatterns() Algorithm

```
ALGORITHM: findSimilarPatterns

INPUT:
  - query: PatternQuery
  - limit: number (default: 10)

OUTPUT:
  - Array<SimilarPattern>

PROCEDURE:

1. ENCODE QUERY CONTEXT
   queryEmbedding = patternEncoder.encode(query.context)

2. BUILD SQL QUERY WITH FILTERS
   sql = "SELECT * FROM patterns WHERE 1=1"
   params = []

   IF query.skillId:
     sql += " AND skill_id = ?"
     params.push(query.skillId)

   IF query.category:
     sql += " AND json_extract(skill_features, '$.category') = ?"
     params.push(query.category)

   IF query.minImportance:
     sql += " AND importance >= ?"
     params.push(query.minImportance)

   IF query.outcomeType:
     sql += " AND outcome_type = ?"
     params.push(query.outcomeType)

   IF query.positiveOnly:
     sql += " AND outcome_reward > 0"

3. FETCH CANDIDATE PATTERNS
   candidates = db.all(sql, params)

4. CALCULATE SIMILARITY SCORES
   importanceVector = fisherMatrix.getImportanceVector()
   results = []

   FOR each candidate IN candidates:
     candidateEmbedding = deserializeEmbedding(candidate.context_embedding)

     // Standard cosine similarity
     similarity = cosineSimilarity(queryEmbedding, candidateEmbedding)

     // Importance-weighted similarity (EWC++ core concept)
     // Dimensions with high Fisher importance contribute more
     weightedSimilarity = importanceWeightedSimilarity(
       queryEmbedding,
       candidateEmbedding,
       importanceVector
     )

     results.push({
       pattern: deserializePattern(candidate),
       similarity: similarity,
       weightedSimilarity: weightedSimilarity,
       rank: 0  // Will be set after sorting
     })

5. SORT BY WEIGHTED SIMILARITY
   results.sort((a, b) => b.weightedSimilarity - a.weightedSimilarity)

   // Assign ranks
   FOR i = 0 TO results.length:
     results[i].rank = i + 1

6. UPDATE ACCESS TRACKING
   IF config.trackAccess:
     FOR each result IN results.slice(0, limit):
       updateAccessCount(result.pattern.id)

7. RETURN TOP-K RESULTS
   RETURN results.slice(0, limit)


HELPER: importanceWeightedSimilarity(a, b, importance)
  // Compute similarity with dimension weighting
  weightedDotProduct = 0
  normA = 0
  normB = 0

  FOR i = 0 TO a.length:
    weight = 1 + importance[i]  // Importance boosts dimension contribution
    weightedDotProduct += weight * a[i] * b[i]
    normA += weight * a[i] * a[i]
    normB += weight * b[i] * b[i]

  IF normA == 0 OR normB == 0:
    RETURN 0

  RETURN weightedDotProduct / (sqrt(normA) * sqrt(normB))
```

### 3.4 consolidate() Algorithm

```
ALGORITHM: consolidate

INPUT:
  - config: EWCConfig

OUTPUT:
  - ConsolidationResult

PROCEDURE:

1. CHECK IF CONSOLIDATION NEEDED
   totalPatterns = getPatternCount()
   newPatternsRatio = consolidationState.patternsSinceLastConsolidation / totalPatterns

   IF newPatternsRatio < config.consolidationThreshold:
     RETURN {
       consolidated: false,
       patternsProcessed: 0,
       patternsPreserved: 0,
       patternsPruned: 0,
       preservationRate: 1.0,
       durationMs: 0,
       averageImportance: fisherMatrix.getAverageImportance()
     }

2. START CONSOLIDATION
   startTime = now()

   // Apply Fisher decay to reduce importance of old patterns
   fisherMatrix.decay(config.fisherDecay)

3. RECALCULATE PATTERN IMPORTANCE
   // Sample patterns for Fisher estimation
   samplePatterns = getSamplePatterns(config.fisherSampleSize)

   FOR each pattern IN samplePatterns:
     // Compute gradient from pattern embedding to current average
     averageEmbedding = computeAverageEmbedding()
     gradient = pattern.contextEmbedding - averageEmbedding

     // Update Fisher with squared gradient
     fisherMatrix.update(gradient)

   // Update importance for all patterns based on new Fisher
   allPatterns = getAllPatterns()
   importanceVector = fisherMatrix.getImportanceVector()

   FOR each pattern IN allPatterns:
     newImportance = calculatePatternImportance(pattern, importanceVector)
     updatePatternImportance(pattern.id, newImportance)

4. PRUNE LOW-IMPORTANCE PATTERNS
   prunedCount = 0
   preservedCount = 0

   // Sort by importance (ascending) for pruning
   sortedPatterns = allPatterns.sortBy(p => p.importance, ASC)

   // Prune if over max patterns limit
   IF sortedPatterns.length > config.maxPatterns:
     pruneCandidates = sortedPatterns.slice(0, sortedPatterns.length - config.maxPatterns)

     FOR each candidate IN pruneCandidates:
       IF candidate.importance < config.importanceThreshold:
         deletePattern(candidate.id)
         prunedCount++
       ELSE:
         preservedCount++
   ELSE:
     // Even if under limit, prune very low importance patterns
     FOR each pattern IN sortedPatterns:
       IF pattern.importance < config.importanceThreshold * 0.1:
         deletePattern(pattern.id)
         prunedCount++
       ELSE:
         preservedCount++

5. UPDATE CONSOLIDATION STATE
   preservationRate = preservedCount / (preservedCount + prunedCount)

   consolidationState.lastConsolidation = now()
   consolidationState.patternsSinceLastConsolidation = 0
   consolidationState.totalPatterns = getPatternCount()
   consolidationState.preservationHistory.push({
     timestamp: now(),
     rate: preservationRate,
     patternsProcessed: preservedCount + prunedCount
   })

6. PERSIST FISHER MATRIX
   saveFisherMatrix()

7. RETURN RESULT
   RETURN {
     consolidated: true,
     patternsProcessed: preservedCount + prunedCount,
     patternsPreserved: preservedCount,
     patternsPruned: prunedCount,
     preservationRate: preservationRate,
     durationMs: now() - startTime,
     averageImportance: fisherMatrix.getAverageImportance()
   }


HELPER: calculatePatternImportance(pattern, importanceVector)
  // Base importance from outcome
  baseImportance = abs(pattern.outcome.reward)

  // Boost for positive outcomes
  IF pattern.outcome.reward > 0:
    baseImportance *= 1.5

  // Recency factor (exponential decay)
  ageInDays = (now() - pattern.createdAt) / (24 * 60 * 60 * 1000)
  recencyFactor = exp(-ageInDays / 30)  // Half-life of 30 days

  // Access frequency factor
  accessFactor = 1 + log(1 + pattern.accessCount)

  // Fisher dimension importance (how important are the dimensions this pattern uses)
  patternDimensionImportance = sum(
    importanceVector[i] * abs(pattern.contextEmbedding[i])
    FOR i IN 0..dimensions
  ) / dimensions

  RETURN baseImportance * recencyFactor * accessFactor * patternDimensionImportance
```

### 3.5 shouldConsolidate() Algorithm

```
ALGORITHM: shouldConsolidate

INPUT:
  - consolidationState: ConsolidationState
  - config: EWCConfig

OUTPUT:
  - boolean

PROCEDURE:

1. CHECK TIME SINCE LAST CONSOLIDATION
   IF consolidationState.lastConsolidation:
     hoursSinceLast = (now() - consolidationState.lastConsolidation) / (60 * 60 * 1000)

     // Minimum 1 hour between consolidations
     IF hoursSinceLast < 1:
       RETURN false

2. CHECK NEW PATTERNS RATIO
   IF consolidationState.totalPatterns == 0:
     RETURN false

   newPatternsRatio = consolidationState.patternsSinceLastConsolidation /
                      consolidationState.totalPatterns

   IF newPatternsRatio >= config.consolidationThreshold:
     RETURN true

3. CHECK PATTERN COUNT THRESHOLD
   // Force consolidation if approaching max patterns
   IF consolidationState.totalPatterns > config.maxPatterns * 0.9:
     RETURN true

4. DEFAULT
   RETURN false
```

---

## 4. Integration Plan

### 4.1 Integration with ReasoningBankIntegration

```typescript
/**
 * Integration between PatternStore and ReasoningBankIntegration
 *
 * ReasoningBankIntegration records trajectories (sequences of actions).
 * PatternStore stores individual patterns extracted from successful trajectories.
 *
 * Data flow:
 * 1. User accepts/uses skill -> ReasoningBankIntegration.recordAccept()
 * 2. ReasoningBankIntegration creates trajectory with verdict
 * 3. PatternStore.storePattern() extracts and stores the pattern
 * 4. On future recommendations, PatternStore.findSimilarPatterns() informs ranking
 */

// File: packages/core/src/learning/PatternStoreIntegration.ts

import type { ReasoningBankIntegration } from './ReasoningBankIntegration.js';
import type { PatternStore, Pattern, PatternOutcome } from './PatternStore.js';
import type { SignalEvent, RecommendationContext as SignalContext } from './types.js';

/**
 * Bridge between ReasoningBankIntegration and PatternStore
 */
export class PatternStoreIntegration {
  constructor(
    private patternStore: PatternStore,
    private reasoningBank: ReasoningBankIntegration
  ) {}

  /**
   * Convert a signal event to a pattern and store it
   */
  async storeSignalAsPattern(
    signal: SignalEvent,
    skillFeatures: SkillFeatures
  ): Promise<string> {
    // Convert signal context to pattern context
    const context: RecommendationContext = {
      installedSkills: signal.context?.installed_skills ?? [],
      frameworks: signal.metadata?.frameworks as string[] | undefined,
      keywords: signal.metadata?.keywords as string[] | undefined,
    };

    // Create pattern from signal
    const pattern: Pattern = {
      context,
      skill: skillFeatures,
      originalScore: signal.context?.original_score ?? 0.5,
      source: 'recommend',
    };

    // Map signal type to outcome
    const outcome = this.signalToOutcome(signal);

    // Store pattern with EWC++ protection
    return this.patternStore.storePattern(pattern, outcome);
  }

  /**
   * Query patterns to inform recommendation ranking
   */
  async getPatternBoosts(
    context: RecommendationContext,
    candidateSkillIds: string[]
  ): Promise<Map<string, number>> {
    const boosts = new Map<string, number>();

    // Query patterns for this context
    const similarPatterns = await this.patternStore.findSimilarPatterns({
      context,
      positiveOnly: true,
      minImportance: 0.1,
    }, 50);

    // Calculate boost for each candidate skill
    for (const skillId of candidateSkillIds) {
      const relevantPatterns = similarPatterns.filter(
        sp => sp.pattern.skill.skillId === skillId
      );

      if (relevantPatterns.length > 0) {
        // Weighted average of pattern outcomes
        let totalWeight = 0;
        let weightedSum = 0;

        for (const sp of relevantPatterns) {
          const weight = sp.weightedSimilarity * sp.pattern.importance;
          weightedSum += weight * sp.pattern.outcome.reward;
          totalWeight += weight;
        }

        if (totalWeight > 0) {
          const boost = weightedSum / totalWeight;
          boosts.set(skillId, boost);
        }
      }
    }

    return boosts;
  }

  private signalToOutcome(signal: SignalEvent): PatternOutcome {
    const outcomeMap: Record<string, PatternOutcome> = {
      accept: { type: 'accept', reward: 1.0 },
      dismiss: { type: 'dismiss', reward: -0.5 },
      usage: { type: 'usage', reward: 0.3 },
      abandonment: { type: 'abandonment', reward: -0.3 },
      uninstall: { type: 'uninstall', reward: -0.7 },
    };

    return outcomeMap[signal.type] ?? { type: 'usage', reward: 0 };
  }
}
```

### 4.2 Integration with SONARouter

```typescript
/**
 * Integration between PatternStore and SONARouter
 *
 * SONARouter selects optimal experts for tool requests.
 * PatternStore can inform expert selection based on historical patterns.
 *
 * Data flow:
 * 1. SONARouter receives tool request
 * 2. Query PatternStore for similar historical patterns
 * 3. Use pattern outcomes to boost/penalize expert scores
 * 4. Record routing outcome back to PatternStore
 */

// File: packages/core/src/routing/PatternAwareRouting.ts

import type { SONARouter, ToolRequest, RoutingDecision } from './SONARouter.js';
import type { PatternStore, Pattern, PatternOutcome } from '../learning/PatternStore.js';

/**
 * Enhance SONARouter with pattern-based learning
 */
export function createPatternAwareRouter(
  baseRouter: SONARouter,
  patternStore: PatternStore
): SONARouter {
  const originalRoute = baseRouter.route.bind(baseRouter);

  // Override route method to include pattern-based adjustments
  baseRouter.route = async function(request: ToolRequest): Promise<RoutingDecision> {
    // Get base routing decision
    const decision = await originalRoute(request);

    // Query patterns for similar requests
    const patterns = await patternStore.findSimilarPatterns({
      context: {
        installedSkills: [], // Could be enriched with user context
        keywords: extractKeywords(request.arguments),
      },
      positiveOnly: false,
    }, 20);

    // Calculate pattern-based confidence adjustment
    if (patterns.length > 0) {
      const patternConfidence = calculatePatternConfidence(patterns, decision.expertId);
      decision.confidence = (decision.confidence + patternConfidence) / 2;
    }

    return decision;
  };

  // Record routing outcomes as patterns
  const originalExecute = baseRouter.executeWithRouting.bind(baseRouter);
  baseRouter.executeWithRouting = async function<T>(
    request: ToolRequest,
    executor: (expertId: string, request: ToolRequest) => Promise<T>
  ) {
    const result = await originalExecute(request, executor);

    // Store routing outcome as pattern
    const pattern: Pattern = {
      context: {
        installedSkills: [],
        keywords: extractKeywords(request.arguments),
      },
      skill: {
        skillId: `${request.tool}:${request.requestId}`,
        category: request.tool,
      },
      originalScore: result.success ? 1.0 : 0.0,
      source: 'recommend',
    };

    const outcome: PatternOutcome = {
      type: result.success ? 'accept' : 'dismiss',
      reward: result.success ? 1.0 : -0.5,
      metadata: {
        expertId: result.meta.expertId,
        executionTimeMs: result.meta.executionTimeMs,
      },
    };

    await patternStore.storePattern(pattern, outcome);

    return result;
  };

  return baseRouter;
}

function extractKeywords(args: Record<string, unknown>): string[] {
  const keywords: string[] = [];

  if (typeof args.query === 'string') {
    keywords.push(...args.query.split(/\s+/).filter(w => w.length > 2));
  }

  return keywords;
}

function calculatePatternConfidence(
  patterns: SimilarPattern[],
  expertId: string
): number {
  let totalWeight = 0;
  let successWeight = 0;

  for (const sp of patterns) {
    const weight = sp.weightedSimilarity;
    totalWeight += weight;

    if (sp.pattern.outcome.reward > 0) {
      successWeight += weight;
    }
  }

  return totalWeight > 0 ? successWeight / totalWeight : 0.5;
}
```

### 4.3 Persistence Strategy

```typescript
/**
 * Persistence strategy for PatternStore
 *
 * Uses SQLite for durability with the following tables:
 * 1. patterns - Stores pattern data with embeddings
 * 2. fisher_info - Stores Fisher Information matrix state
 * 3. consolidation_history - Tracks consolidation operations
 */

// SQLite Schema
const PATTERN_STORE_SCHEMA = `
-- Patterns table: stores recommendation patterns with outcomes
CREATE TABLE IF NOT EXISTS patterns (
  pattern_id TEXT PRIMARY KEY,
  context_embedding BLOB NOT NULL,
  skill_id TEXT NOT NULL,
  skill_features TEXT NOT NULL, -- JSON
  outcome_type TEXT NOT NULL,
  outcome_reward REAL NOT NULL,
  importance REAL NOT NULL DEFAULT 0.1,
  original_score REAL NOT NULL,
  source TEXT NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_accessed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_patterns_skill_id ON patterns(skill_id);
CREATE INDEX IF NOT EXISTS idx_patterns_outcome_type ON patterns(outcome_type);
CREATE INDEX IF NOT EXISTS idx_patterns_importance ON patterns(importance DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_created_at ON patterns(created_at DESC);

-- Fisher Information matrix state
CREATE TABLE IF NOT EXISTS fisher_info (
  id INTEGER PRIMARY KEY DEFAULT 1,
  matrix_data BLOB NOT NULL,
  update_count INTEGER NOT NULL DEFAULT 0,
  last_decay_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Consolidation history for monitoring
CREATE TABLE IF NOT EXISTS consolidation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
  patterns_processed INTEGER NOT NULL,
  patterns_preserved INTEGER NOT NULL,
  patterns_pruned INTEGER NOT NULL,
  preservation_rate REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  average_importance REAL NOT NULL
);

-- Trigger to update last_accessed_at on read
-- (implemented in application code due to SQLite trigger limitations)
`;

/**
 * V3 API Integration Option
 *
 * If V3 ReasoningBank is available, PatternStore can use it as a backend:
 * - V3 provides vector similarity search
 * - V3 handles persistence automatically
 * - PatternStore adds EWC++ importance layer on top
 */
async function initializeWithV3Backend(): Promise<void> {
  try {
    const { getReasoningBank } = await import(
      'claude-flow/v3/@claude-flow/cli/dist/src/intelligence/index.js'
    );

    const reasoningBank = await getReasoningBank();

    // Use V3 for storage, EWC++ for importance tracking
    console.log('[PatternStore] Using V3 ReasoningBank backend');
  } catch {
    // Fall back to SQLite-only storage
    console.log('[PatternStore] V3 not available, using SQLite backend');
  }
}
```

---

## 5. Use Case Implementations

### 5.1 User Accepts Skill Recommendation

```typescript
/**
 * Use Case: User accepts skill recommendation -> store as positive pattern
 */
async function handleSkillAcceptance(
  skillId: string,
  context: RecommendationContext,
  originalScore: number,
  patternStore: PatternStore
): Promise<void> {
  // Fetch skill features from database
  const skillFeatures = await fetchSkillFeatures(skillId);

  // Create pattern from acceptance
  const pattern: Pattern = {
    context,
    skill: skillFeatures,
    originalScore,
    source: 'recommend',
  };

  // Store with positive outcome (high reward)
  const outcome: PatternOutcome = {
    type: 'accept',
    reward: 1.0,
    confidence: 1.0,
    metadata: {
      sessionDuration: context.sessionDuration,
      recommendationsShown: context.recommendationsShown,
    },
  };

  await patternStore.storePattern(pattern, outcome);

  // Pattern is now stored with EWC++ protection
  // Future similar contexts will boost this skill's recommendations
}
```

### 5.2 User Uses Skill Frequently

```typescript
/**
 * Use Case: User uses skill frequently -> reinforce pattern
 */
async function handleFrequentUsage(
  skillId: string,
  usageCount: number,
  patternStore: PatternStore
): Promise<void> {
  // Find existing patterns for this skill
  const existingPatterns = await patternStore.findSimilarPatterns({
    skillId,
    positiveOnly: true,
  }, 10);

  // Reinforce each pattern with usage signal
  for (const sp of existingPatterns) {
    const reinforcement: PatternOutcome = {
      type: usageCount > 10 ? 'frequent' : 'usage',
      reward: usageCount > 10 ? 0.5 : 0.3,
      metadata: { usageCount },
    };

    // Update pattern with reinforcement
    // This increases its importance in Fisher Information
    await patternStore.storePattern(sp.pattern, reinforcement);
  }

  // Patterns are reinforced without overwriting
  // EWC++ ensures original acceptance patterns preserved
}
```

### 5.3 User Dismisses Recommendation

```typescript
/**
 * Use Case: User dismisses recommendation -> negative pattern
 */
async function handleSkillDismissal(
  skillId: string,
  context: RecommendationContext,
  dismissReason: string,
  patternStore: PatternStore
): Promise<void> {
  const skillFeatures = await fetchSkillFeatures(skillId);

  const pattern: Pattern = {
    context,
    skill: skillFeatures,
    originalScore: 0.5, // Score that led to incorrect recommendation
    source: 'recommend',
  };

  // Store with negative outcome
  const outcome: PatternOutcome = {
    type: 'dismiss',
    reward: -0.5,
    confidence: 0.8, // Slightly lower confidence for dismissals
    metadata: { reason: dismissReason },
  };

  await patternStore.storePattern(pattern, outcome);

  // Pattern stored with negative importance
  // Future similar contexts will penalize this skill
  // But EWC++ ensures existing positive patterns aren't overwritten
}
```

### 5.4 New Patterns Should Not Overwrite Important Old Patterns

```typescript
/**
 * Use Case: Ensure new patterns don't overwrite important historical patterns
 *
 * This is the core EWC++ guarantee:
 * - Old patterns with high importance (frequently accessed, positive outcomes)
 *   are protected from being overwritten
 * - New patterns that would require changing important embedding dimensions
 *   get lower priority during consolidation
 */
async function demonstratePatternPreservation(
  patternStore: PatternStore
): Promise<void> {
  // Store initial important pattern
  const importantPattern: Pattern = {
    context: {
      installedSkills: ['anthropic/commit'],
      frameworks: ['react', 'typescript'],
      keywords: ['testing', 'jest'],
    },
    skill: { skillId: 'community/jest-helper', category: 'testing' },
    originalScore: 0.95,
    source: 'recommend',
  };

  await patternStore.storePattern(importantPattern, {
    type: 'accept',
    reward: 1.0,
  });

  // Simulate many accesses (increases importance via Fisher Information)
  for (let i = 0; i < 100; i++) {
    await patternStore.findSimilarPatterns({
      context: importantPattern.context,
      skillId: 'community/jest-helper',
    }, 1);
  }

  // Store many new patterns that might conflict
  for (let i = 0; i < 1000; i++) {
    const newPattern: Pattern = {
      context: {
        installedSkills: ['anthropic/commit'],
        frameworks: ['react', 'typescript'],
        keywords: [`keyword-${i}`], // Different keywords
      },
      skill: { skillId: `new-skill-${i}`, category: 'testing' },
      originalScore: 0.5,
      source: 'recommend',
    };

    await patternStore.storePattern(newPattern, {
      type: 'accept',
      reward: 0.8,
    });
  }

  // Trigger consolidation
  const result = await patternStore.consolidate();

  // Verify important pattern was preserved
  const preservedPatterns = await patternStore.findSimilarPatterns({
    skillId: 'community/jest-helper',
    minImportance: 0.5,
  }, 1);

  console.log('Preservation rate:', result.preservationRate);
  // Expected: >= 0.95 (95% preservation)

  console.log('Important pattern preserved:', preservedPatterns.length > 0);
  // Expected: true - the jest-helper pattern survives consolidation

  console.log('Pattern importance:', preservedPatterns[0]?.pattern.importance);
  // Expected: High value due to frequent access
}
```

---

## 6. File Structure

```
packages/core/src/
  learning/
    PatternStore.ts                    # Main PatternStore implementation
    types.ts                           # Type definitions (extended)
    FisherInformationMatrix.ts         # EWC++ Fisher Information implementation
    PatternEncoder.ts                  # Context to embedding conversion
    PatternStoreIntegration.ts         # Integration with ReasoningBankIntegration
    index.ts                           # Module exports
    __tests__/
      PatternStore.test.ts             # Unit tests for PatternStore
      FisherInformationMatrix.test.ts  # Unit tests for Fisher matrix
      PatternStoreIntegration.test.ts  # Integration tests
      ewc-preservation.test.ts         # EWC++ preservation guarantee tests

  routing/
    PatternAwareRouting.ts             # SONARouter + PatternStore integration
    index.ts                           # Updated exports

docs/architecture/
  pattern-store-ewc-architecture.md    # This document
```

---

## 7. Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Pattern preservation rate | >= 95% | During consolidation |
| storePattern() latency | < 10ms | P95 |
| findSimilarPatterns() latency | < 20ms | P95, for 10k patterns |
| consolidate() duration | < 5s | For 10k patterns |
| Fisher matrix size | ~1.5KB | 384 dimensions * 4 bytes |
| Pattern storage overhead | ~500 bytes/pattern | Embedding + metadata |
| Memory usage (10k patterns) | < 10MB | Patterns + Fisher matrix |

---

## 8. Testing Strategy

### 8.1 Unit Tests

```typescript
describe('PatternStore', () => {
  describe('storePattern()', () => {
    it('should store new pattern with initial importance');
    it('should update existing similar pattern instead of duplicating');
    it('should update Fisher Information on store');
    it('should trigger consolidation when threshold reached');
  });

  describe('findSimilarPatterns()', () => {
    it('should return patterns sorted by weighted similarity');
    it('should filter by skill ID when specified');
    it('should filter by minimum importance');
    it('should apply importance weighting correctly');
  });

  describe('consolidate()', () => {
    it('should achieve >= 95% preservation rate');
    it('should prune patterns below importance threshold');
    it('should apply Fisher decay correctly');
    it('should update pattern importance values');
  });
});

describe('FisherInformationMatrix', () => {
  it('should update importance on gradient observation');
  it('should apply decay to all dimensions');
  it('should serialize and deserialize correctly');
  it('should track high-importance dimensions');
});
```

### 8.2 Integration Tests

```typescript
describe('PatternStore + ReasoningBankIntegration', () => {
  it('should store patterns from signal events');
  it('should provide pattern boosts for recommendations');
  it('should handle dual-write correctly');
});

describe('PatternStore + SONARouter', () => {
  it('should inform expert selection with patterns');
  it('should record routing outcomes as patterns');
  it('should improve routing confidence over time');
});
```

### 8.3 EWC++ Preservation Tests

```typescript
describe('EWC++ Catastrophic Forgetting Prevention', () => {
  it('should preserve important patterns across 1000 new insertions');
  it('should maintain 95% preservation after 5 consolidation cycles');
  it('should protect high-access patterns from pruning');
  it('should allow low-importance patterns to be overwritten');
});
```

---

## 9. Monitoring and Alerts

```yaml
# Prometheus alerting rules for PatternStore
groups:
  - name: pattern_store_alerts
    rules:
      - alert: PatternPreservationLow
        expr: pattern_store_preservation_rate < 0.95
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Pattern preservation below 95%"
          description: "EWC++ may not be preventing catastrophic forgetting"

      - alert: PatternStoreFull
        expr: pattern_store_count / pattern_store_max_capacity > 0.9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "PatternStore approaching capacity"

      - alert: ConsolidationSlow
        expr: pattern_store_consolidation_duration_seconds > 10
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Pattern consolidation taking too long"

      - alert: FisherMatrixCorrupted
        expr: pattern_store_fisher_nan_count > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Fisher Information matrix contains NaN values"
```

---

## 10. References

- [SMI-1522: Add EWC++ pattern storage for successful matches](https://linear.app/smith-horn/issue/SMI-1522)
- [SMI-1520: ReasoningBank Integration](https://linear.app/smith-horn/issue/SMI-1520)
- [SMI-1521: SONA Routing Architecture](docs/architecture/sona-router-architecture.md)
- [Original EWC Paper](https://arxiv.org/abs/1612.00796) - Kirkpatrick et al., 2017
- [EWC++ (Progress & Compress)](https://arxiv.org/abs/1801.10112) - Schwarz et al., 2018
- [ADR-009: Embedding Service Fallback Strategy](docs/adr/009-embedding-service-fallback.md)

---

*Document created: January 16, 2026*
*Issue: SMI-1522*
