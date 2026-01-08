# Anti-Gaming Measures

> **Navigation**: [Scoring Index](./index.md) | [Technical Index](../index.md) | [Algorithm](./algorithm.md)

---

## Gaming Vectors and Mitigations

| Gaming Vector | Detection | Mitigation |
|---------------|-----------|------------|
| Fake stars | Star velocity anomaly detection | Cap star weight, flag suspicious |
| Keyword stuffing | Description length >200 chars, repetition | Penalize score |
| Self-installs | IP/user deduplication (our telemetry) | Dedupe by user ID |
| Review bombing | Wilson score confidence interval | Low sample protection |
| Coordinated boosting | Time-correlation analysis | Flag for review |

---

## Star Velocity Anomaly Detection

```typescript
interface AnomalyDetector {
  checkStarVelocity(skill: Skill): AnomalyResult;
}

function checkStarVelocity(skill: Skill): AnomalyResult {
  // Expected daily stars based on current popularity
  const expectedDaily = Math.log10(skill.stars + 1) * 0.5;
  const actualDaily = skill.stars_7d / 7;

  if (actualDaily > expectedDaily * 10) {
    return {
      anomaly: true,
      type: 'star_velocity',
      severity: 'high',
      action: 'cap_popularity_score',
      details: {
        expected: expectedDaily,
        actual: actualDaily,
        ratio: actualDaily / expectedDaily,
      },
    };
  }

  return { anomaly: false };
}
```

### Star Velocity Thresholds

| Current Stars | Expected Daily | Suspicious If Daily > |
|---------------|----------------|----------------------|
| 0-10 | 0.5 | 5 |
| 10-100 | 1.0 | 10 |
| 100-1000 | 1.5 | 15 |
| 1000+ | 2.0 | 20 |

---

## Keyword Stuffing Detection

```typescript
function detectKeywordStuffing(skill: Skill): StuffingResult {
  const issues: string[] = [];

  // Check description length
  if (skill.description.length > 200) {
    issues.push('Description exceeds 200 characters');
  }

  // Check for repetition
  const words = skill.description.toLowerCase().split(/\s+/);
  const wordFreq = new Map<string, number>();

  for (const word of words) {
    wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
  }

  const maxFreq = Math.max(...wordFreq.values());
  if (maxFreq > 3 && maxFreq / words.length > 0.1) {
    issues.push(`Word "${getMaxKey(wordFreq)}" repeated ${maxFreq} times`);
  }

  // Check for excessive tags
  if (skill.topics && skill.topics.length > 10) {
    issues.push(`Too many topics: ${skill.topics.length}`);
  }

  return {
    detected: issues.length > 0,
    issues,
    penalty: issues.length * 0.1, // 10% penalty per issue
  };
}
```

---

## Self-Install Deduplication

```typescript
interface InstallTracker {
  trackInstall(skillId: string, userId: string): Promise<void>;
  getUniqueInstalls(skillId: string): Promise<number>;
}

// Store installs with user deduplication
async function trackInstall(
  skillId: string,
  userId: string,
  context: InstallContext
): Promise<void> {
  const existing = await db.query(`
    SELECT 1 FROM installs
    WHERE skill_id = ? AND user_id = ?
  `, [skillId, userId]);

  if (!existing) {
    await db.insert('installs', {
      skill_id: skillId,
      user_id: userId,  // Anonymized/hashed
      timestamp: new Date().toISOString(),
      ip_hash: hashIP(context.ip),  // For additional dedup
    });
  }
}

// Count unique installs only
async function getUniqueInstalls(skillId: string): Promise<number> {
  const result = await db.query(`
    SELECT COUNT(DISTINCT user_id) as count
    FROM installs
    WHERE skill_id = ?
  `, [skillId]);

  return result.count;
}
```

---

## Wilson Score Confidence Interval

For ratings with low sample sizes:

```typescript
function wilsonScore(
  positive: number,
  total: number,
  confidence: number = 0.95
): number {
  if (total === 0) return 0;

  const z = getZScore(confidence);
  const phat = positive / total;

  // Wilson score lower bound
  const denominator = 1 + z * z / total;
  const centre = phat + z * z / (2 * total);
  const spread = z * Math.sqrt((phat * (1 - phat) + z * z / (4 * total)) / total);

  return (centre - spread) / denominator;
}

// Use Wilson score for skills with few interactions
function adjustedPopularity(skill: Skill): number {
  const basePopularity = computePopularity(skill);

  // If low sample size, use Wilson lower bound
  const totalInteractions = skill.installs + skill.views;

  if (totalInteractions < 100) {
    const wilsonAdjusted = wilsonScore(skill.installs, totalInteractions);
    return Math.min(basePopularity, wilsonAdjusted);
  }

  return basePopularity;
}
```

### Wilson Score Effect

| Installs | Views | Raw Rate | Wilson Score |
|----------|-------|----------|--------------|
| 5 | 10 | 0.50 | 0.23 |
| 50 | 100 | 0.50 | 0.40 |
| 500 | 1000 | 0.50 | 0.47 |

---

## Coordinated Boosting Detection

```typescript
interface CoordinationDetector {
  detectCoordination(skill: Skill): CoordinationResult;
}

function detectCoordinatedActivity(
  skill: Skill,
  timeWindow: number = 24 * 60 * 60 * 1000 // 24 hours
): CoordinationResult {
  // Get recent activity
  const recentStars = skill.star_events.filter(
    e => Date.now() - new Date(e.timestamp).getTime() < timeWindow
  );

  // Check for burst pattern
  const burstThreshold = 10;
  if (recentStars.length >= burstThreshold) {
    // Check if stars came from related accounts
    const users = recentStars.map(e => e.user_id);
    const similarity = calculateAccountSimilarity(users);

    if (similarity > 0.7) {
      return {
        detected: true,
        type: 'coordinated_starring',
        confidence: similarity,
        action: 'flag_for_review',
      };
    }
  }

  return { detected: false };
}

function calculateAccountSimilarity(users: string[]): number {
  // Check for:
  // - Similar account creation dates
  // - Similar naming patterns
  // - Similar activity patterns
  // Returns 0-1 similarity score

  let similarityScore = 0;

  // Check creation date clustering
  const creationDates = users.map(u => getUserCreationDate(u));
  const dateClustering = calculateDateClustering(creationDates);
  similarityScore += dateClustering * 0.4;

  // Check naming patterns
  const namePatternSimilarity = checkNamingPatterns(users);
  similarityScore += namePatternSimilarity * 0.3;

  // Check activity overlap
  const activityOverlap = checkActivityOverlap(users);
  similarityScore += activityOverlap * 0.3;

  return similarityScore;
}
```

---

## Penalty Application

```typescript
interface ScoringPenalties {
  starVelocityAnomaly: number;      // 0.3 - cap popularity at 70%
  keywordStuffingPerIssue: number;  // 0.1 - 10% per issue
  lowSampleBonus: number;           // Use Wilson score
  coordinationFlag: number;         // 0.5 - pending review
}

function applyPenalties(
  baseScore: number,
  skill: Skill,
  anomalies: AnomalyResult[]
): number {
  let score = baseScore;

  for (const anomaly of anomalies) {
    switch (anomaly.type) {
      case 'star_velocity':
        // Cap popularity component
        score = score * 0.7 + 0.3 * Math.min(baseScore, 0.5);
        break;

      case 'keyword_stuffing':
        score *= (1 - anomaly.penalty);
        break;

      case 'coordinated_activity':
        // Pending review - use conservative score
        score = Math.min(score, 0.5);
        break;
    }
  }

  return Math.max(0, Math.min(1, score));
}
```

---

## Monitoring and Alerts

```typescript
interface AnomalyMonitor {
  alert(anomaly: AnomalyResult): Promise<void>;
}

async function monitorAnomalies(): Promise<void> {
  const skills = await db.getRecentlyIndexed(1000);

  for (const skill of skills) {
    const anomalies = await runAnomalyChecks(skill);

    if (anomalies.some(a => a.severity === 'high')) {
      await alertTeam({
        skill_id: skill.id,
        anomalies,
        action_required: true,
      });

      // Auto-flag for review
      await db.update('skills', skill.id, {
        review_status: 'pending',
        review_reason: anomalies.map(a => a.type).join(', '),
      });
    }
  }
}
```

---

## Related Documentation

- [Algorithm](./algorithm.md) - Scoring algorithm
- [Trust Tiers](../security/trust-tiers.md) - Trust classification
- [Static Analysis](../security/static-analysis.md) - Security scanning

---

*Back to: [Scoring Index](./index.md)*
