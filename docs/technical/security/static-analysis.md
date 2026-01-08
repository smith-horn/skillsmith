# Static Analysis Pipeline

> **Navigation**: [Security Index](./index.md) | [Technical Index](../index.md) | [Trust Tiers](./trust-tiers.md)

---

## Security Scanner Architecture

```typescript
interface SecurityScanner {
  scan(skill: SkillContent): ScanResult;
}

interface ScanChecks {
  // Known jailbreak patterns
  jailbreak_patterns: RegExp[];

  // Exfiltration indicators
  suspicious_urls: RegExp[];
  external_domains_allowlist: string[];

  // Sensitive file access
  sensitive_patterns: string[];

  // Obfuscation detection
  entropy_threshold: number;      // For detecting encoded content

  // Scope creep
  permission_keywords: string[];  // 'delete', 'remove', 'execute', etc.
}
```

---

## Scan Configuration

```typescript
const SCAN_CONFIG: ScanChecks = {
  jailbreak_patterns: [
    /ignore\s+(previous|prior|all)\s+instructions/i,
    /developer\s+mode/i,
    /bypass\s+(safety|security)/i,
    /system\s*:\s*override/i,
  ],

  suspicious_urls: [
    /https?:\/\/(?!github\.com|anthropic\.com)/i,
  ],

  external_domains_allowlist: [
    'github.com',
    'githubusercontent.com',
    'anthropic.com',
    'claude.ai',
  ],

  sensitive_patterns: [
    '*.env*',
    '*.pem',
    '*.key',
    '*credentials*',
    '*secrets*',
    '*password*',
  ],

  entropy_threshold: 4.5,        // High entropy = possible obfuscation

  permission_keywords: [
    'rm -rf',
    'delete',
    'format',
    'curl',
    'wget',
    'eval',
  ],
};
```

---

## Scan Checks

### 1. Jailbreak Pattern Detection

Detects known patterns used to manipulate Claude's behavior:

```typescript
function checkJailbreakPatterns(content: string): ScanFinding[] {
  const findings: ScanFinding[] = [];

  for (const pattern of SCAN_CONFIG.jailbreak_patterns) {
    const match = content.match(pattern);
    if (match) {
      findings.push({
        type: 'jailbreak_pattern',
        severity: 'critical',
        location: match.index,
        matched_text: match[0],
        message: `Detected potential jailbreak pattern: "${match[0]}"`,
      });
    }
  }

  return findings;
}
```

### 2. URL/Domain Analysis

Checks for suspicious external URLs:

```typescript
function checkUrls(content: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const urlPattern = /https?:\/\/[^\s)]+/g;

  let match;
  while ((match = urlPattern.exec(content)) !== null) {
    const url = new URL(match[0]);
    const domain = url.hostname;

    if (!SCAN_CONFIG.external_domains_allowlist.includes(domain)) {
      findings.push({
        type: 'suspicious_url',
        severity: 'high',
        location: match.index,
        matched_text: match[0],
        message: `External URL to non-allowlisted domain: ${domain}`,
      });
    }
  }

  return findings;
}
```

### 3. Sensitive File Access

Detects references to sensitive files:

```typescript
function checkSensitivePatterns(content: string): ScanFinding[] {
  const findings: ScanFinding[] = [];

  for (const pattern of SCAN_CONFIG.sensitive_patterns) {
    const regex = globToRegex(pattern);
    const matches = content.match(regex);

    if (matches) {
      for (const match of matches) {
        findings.push({
          type: 'sensitive_file_access',
          severity: 'high',
          matched_text: match,
          message: `Reference to potentially sensitive file: ${match}`,
        });
      }
    }
  }

  return findings;
}
```

### 4. Entropy Analysis

Detects potentially obfuscated content:

```typescript
function checkEntropy(content: string): ScanFinding[] {
  const findings: ScanFinding[] = [];

  // Check content blocks for high entropy (possible base64, encoded data)
  const blocks = extractCodeBlocks(content);

  for (const block of blocks) {
    const entropy = calculateShannonEntropy(block);

    if (entropy > SCAN_CONFIG.entropy_threshold) {
      findings.push({
        type: 'high_entropy',
        severity: 'medium',
        matched_text: block.slice(0, 50) + '...',
        message: `High entropy content detected (${entropy.toFixed(2)}). May contain obfuscated data.`,
      });
    }
  }

  return findings;
}

function calculateShannonEntropy(str: string): number {
  const freq = new Map<string, number>();
  for (const char of str) {
    freq.set(char, (freq.get(char) || 0) + 1);
  }

  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}
```

### 5. Permission Keyword Analysis

Detects potentially dangerous commands:

```typescript
function checkPermissionKeywords(content: string): ScanFinding[] {
  const findings: ScanFinding[] = [];

  for (const keyword of SCAN_CONFIG.permission_keywords) {
    const pattern = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'gi');
    const matches = content.match(pattern);

    if (matches) {
      findings.push({
        type: 'permission_keyword',
        severity: 'medium',
        matched_text: keyword,
        message: `Contains potentially dangerous keyword: "${keyword}"`,
      });
    }
  }

  return findings;
}
```

---

## Typosquatting Detection

```typescript
interface TyposquattingDetector {
  check(skill_name: string): TyposquatRisk;
}

function checkTyposquat(name: string, known_skills: string[]): TyposquatRisk {
  const suspicious: string[] = [];

  for (const known of known_skills) {
    // Levenshtein distance
    if (levenshtein(name, known) <= 2 && name !== known) {
      suspicious.push(known);
    }

    // Character substitution (l/1, O/0, etc.)
    if (looksLike(name, known) && name !== known) {
      suspicious.push(known);
    }
  }

  return {
    is_suspicious: suspicious.length > 0,
    similar_to: suspicious,
    recommendation: suspicious.length > 0 ? 'review_before_install' : 'safe',
  };
}

// Character substitution map
const LOOKALIKES: Record<string, string[]> = {
  'l': ['1', 'I', '|'],
  'O': ['0'],
  'o': ['0'],
  'S': ['5', '$'],
  'a': ['@'],
  'e': ['3'],
  // etc.
};
```

---

## Blocklist Integration

```typescript
interface Blocklist {
  blocked_skills: BlockedSkill[];
  last_updated: string;
  signature: string;             // Cryptographic signature for integrity
}

interface BlockedSkill {
  id: string;
  reason: string;
  severity: 'warning' | 'critical';
  blocked_date: string;
  cve?: string;                  // If applicable
}

// Auto-updated from central source
const BLOCKLIST_URL = 'https://claude-discovery.github.io/blocklist/v1.json';
const UPDATE_INTERVAL = '6h';
```

### Blocklist Enforcement

```typescript
async function checkBlocklist(skillId: string): Promise<BlocklistResult> {
  const blocklist = await loadBlocklist();

  const blocked = blocklist.blocked_skills.find(s => s.id === skillId);

  if (blocked) {
    return {
      blocked: true,
      reason: blocked.reason,
      severity: blocked.severity,
      cve: blocked.cve,
    };
  }

  return { blocked: false };
}
```

---

## Scan Result Format

```typescript
interface ScanResult {
  skill_id: string;
  scanned_at: string;
  passed: boolean;

  findings: ScanFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };

  recommendation: 'safe' | 'review' | 'block';
}

interface ScanFinding {
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  location?: number;
  matched_text?: string;
  message: string;
}
```

### Example Scan Output

```json
{
  "skill_id": "community/suspicious-helper",
  "scanned_at": "2025-12-26T10:30:00Z",
  "passed": false,
  "findings": [
    {
      "type": "jailbreak_pattern",
      "severity": "critical",
      "location": 1234,
      "matched_text": "ignore previous instructions",
      "message": "Detected potential jailbreak pattern"
    },
    {
      "type": "suspicious_url",
      "severity": "high",
      "matched_text": "https://evil-site.com/exfil",
      "message": "External URL to non-allowlisted domain: evil-site.com"
    }
  ],
  "summary": {
    "critical": 1,
    "high": 1,
    "medium": 0,
    "low": 0
  },
  "recommendation": "block"
}
```

---

## Related Documentation

- [Threat Model](./threat-model.md) - Security threats
- [Trust Tiers](./trust-tiers.md) - Trust classification
- [Security Research](../../research/skill-conflicts-security.md) - Detailed research

---

*Back to: [Security Index](./index.md)*
