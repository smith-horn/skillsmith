# Security Implementation Plan

**Document Type:** Implementation Plan
**Version:** 1.0
**Date:** December 26, 2025
**Owner:** Security Specialist
**Status:** Ready for Review

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Security Architecture Reference](#2-security-architecture-reference)
3. [Phase 0: POC/Validation Security Stories](#3-phase-0-pocvalidation-security-stories)
4. [Phase 1: Foundation Security Stories](#4-phase-1-foundation-security-stories)
5. [Phase 2: Advanced Security Stories](#5-phase-2-advanced-security-stories)
6. [Story Dependencies Map](#6-story-dependencies-map)
7. [Security Artifacts Reference](#7-security-artifacts-reference)
8. [Definition of Done](#8-definition-of-done)

---

## 1. Executive Summary

### Security Vision

Skillsmith operates at a critical trust boundary between untrusted external skill sources and the trusted Claude Code runtime. Our security implementation follows a **defense-in-depth** strategy with multiple protective layers.

**Core Security Principles:**
1. **Trust by Verification** - Skills are untrusted until verified
2. **Transparency Over Obscurity** - Users see security signals clearly
3. **Fail Safe** - When uncertain, block or warn rather than proceed
4. **Defense in Depth** - Multiple overlapping protection layers
5. **Privacy by Design** - Collect minimum necessary data with consent

### Phase Security Objectives

| Phase | Security Focus | Key Deliverables |
|-------|---------------|------------------|
| **Phase 0** | Baseline Safety | Opt-out telemetry, basic trust display, privacy notice |
| **Phase 1** | Core Protection | Static analysis, typosquatting, blocklist, trust tiers |
| **Phase 2** | Advanced Security | Publisher verification, conflict detection, priority resolution |

### Risk Matrix Summary

```
                      LIKELIHOOD
        HIGH    |  [Typosquatting]
                |
        MEDIUM  |  [Malicious SKILL.md]  [Prompt Injection]
                |  [Dependency Hijack]
        LOW     |  [Key Compromise]
                |
                +------------------------------------------>
                    LOW      MEDIUM      HIGH      CRITICAL
                                   IMPACT

Priority: Upper-right quadrant = highest implementation priority
```

---

## 2. Security Architecture Reference

> **Primary Reference:** [Security Architecture](/docs/architecture/security.md)
>
> **Supporting References:**
> - [Threat Model](/docs/technical/security/threat-model.md)
> - [Trust Tiers](/docs/technical/security/trust-tiers.md)
> - [Static Analysis](/docs/technical/security/static-analysis.md)
> - [Conflict Detection](/docs/technical/security/conflict-detection.md)

### Trust Tier Hierarchy

```
OFFICIAL (Green)     anthropic/* namespace, full review, auto-trusted
    |
VERIFIED (Blue)      Publisher verified, 10+ stars, 30+ days, scan passed
    |
COMMUNITY (Yellow)   Scan passed, has license/README/SKILL.md
    |
UNVERIFIED (Red)     No verification, explicit opt-in required
```

### Security Control Scope

| Control | Discovery Hub Scope | Requires Anthropic |
|---------|--------------------|--------------------|
| Trust tier display | Yes | No |
| Static analysis | Yes | No |
| Typosquatting detection | Yes | No |
| Blocklist enforcement | Yes | No |
| Publisher verification | Yes | No |
| Conflict detection | Yes | No |
| Runtime sandboxing | No | Yes |
| Permission model | No | Yes |
| Network isolation | No | Yes |

---

## 3. Phase 0: POC/Validation Security Stories

### Epic: Privacy Foundation (PRIV)

#### SEC-001: Opt-Out Telemetry Infrastructure

**As a** privacy-conscious user
**I want** telemetry to be transparent and easily disabled
**So that** I maintain control over my data

**Description:**
Implement opt-out telemetry with clear privacy notices, local queuing, and single-command disable functionality.

**Acceptance Criteria:**
```gherkin
Given I am installing Discovery Hub
When installation completes
Then I see a clear privacy notice explaining what is collected
And I am given the option to disable telemetry immediately

Given telemetry is enabled (default)
When I perform actions (search, install, view)
Then only anonymized events are queued locally
And no PII, codebase content, or credentials are ever collected
And events are batched before transmission

Given I want to disable telemetry
When I execute "/discover telemetry off"
Then telemetry collection stops immediately
And no further events are sent
And I receive confirmation of the change
```

**Priority:** P0
**Story Points:** 5

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-001-T1 | Implement TelemetryManager class with enable/disable | 4h |
| SEC-001-T2 | Create local event queue with SQLite storage | 3h |
| SEC-001-T3 | Implement anonymization pipeline (hash IDs, strip PII) | 4h |
| SEC-001-T4 | Build telemetry settings UI in CLI | 2h |
| SEC-001-T5 | Create privacy notice display at installation | 2h |
| SEC-001-T6 | Implement batch transmission with retry logic | 3h |
| SEC-001-T7 | Write unit tests for telemetry components | 4h |

**TypeScript Implementation:**

```typescript
// src/security/telemetry/TelemetryManager.ts
export interface TelemetryConfig {
  enabled: boolean;
  endpoint: string;
  batchSize: number;
  flushIntervalMs: number;
}

export interface TelemetryEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
  anonymousId: string; // Hashed, rotates monthly
}

export class TelemetryManager {
  private config: TelemetryConfig;
  private queue: TelemetryEvent[] = [];

  constructor(config: TelemetryConfig) {
    this.config = config;
  }

  async track(event: string, properties: Record<string, unknown>): Promise<void> {
    if (!this.config.enabled) {
      return; // Silently drop when disabled
    }

    const sanitized = this.sanitize(properties);
    const telemetryEvent: TelemetryEvent = {
      event,
      properties: sanitized,
      timestamp: new Date().toISOString(),
      anonymousId: await this.getAnonymousId(),
    };

    this.queue.push(telemetryEvent);

    if (this.queue.length >= this.config.batchSize) {
      await this.flush();
    }
  }

  private sanitize(properties: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...properties };
    // Remove any potential PII
    const piiKeys = ['email', 'name', 'ip', 'path', 'code', 'content', 'password'];
    for (const key of piiKeys) {
      delete sanitized[key];
    }
    return sanitized;
  }

  private async getAnonymousId(): Promise<string> {
    // Monthly rotating hash for anonymity
    const salt = this.getMonthlyRotatingSalt();
    const machineId = await this.getMachineId();
    return this.hash(machineId + salt).substring(0, 16);
  }

  async disable(): Promise<void> {
    this.config.enabled = false;
    this.queue = []; // Clear any pending events
    await this.persistConfig();
  }

  async enable(): Promise<void> {
    this.config.enabled = true;
    await this.persistConfig();
  }
}
```

---

#### SEC-002: Privacy Notice Display

**As a** new user
**I want** to see a clear privacy notice at installation
**So that** I understand what data is collected before using the product

**Description:**
Display a formatted privacy notice during first run that clearly explains data collection practices.

**Acceptance Criteria:**
```gherkin
Given I am running Discovery Hub for the first time
When the initialization completes
Then I see a privacy notice explaining:
  - What data is collected (anonymized search, installs, errors)
  - What is NEVER collected (code, credentials, PII)
  - How to disable telemetry
And the notice does not block me from using the product

Given I have seen the privacy notice
When I run Discovery Hub again
Then the privacy notice is not shown again

Given I want to review the privacy notice later
When I execute "/discover privacy"
Then I see the full privacy notice again
```

**Priority:** P0
**Story Points:** 2

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-002-T1 | Create privacy notice content markdown | 1h |
| SEC-002-T2 | Implement first-run detection | 1h |
| SEC-002-T3 | Build formatted notice display in terminal | 2h |
| SEC-002-T4 | Add "/discover privacy" command | 1h |

---

#### SEC-003: Basic Trust Tier Display

**As a** user evaluating skills
**I want** to see basic trust indicators
**So that** I can make informed decisions about skill trustworthiness

**Description:**
Display trust tier badges (Official, Verified, Community, Unverified) in search results and skill detail views.

**Acceptance Criteria:**
```gherkin
Given a skill is in the index
When I view it in search results
Then I see a trust tier badge next to the name
And the badge is color-coded (green/blue/yellow/red)
And I understand the trust level at a glance

Given I view skill details
When I execute "/discover info <skill-id>"
Then I see the full trust tier name
And I see a brief explanation of what the tier means

Given a skill has UNVERIFIED tier
When I view it in any context
Then the badge includes a warning icon
And additional risk context is provided
```

**Priority:** P0
**Story Points:** 3

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-003-T1 | Define TrustTier enum and display mappings | 1h |
| SEC-003-T2 | Implement badge rendering for terminal output | 2h |
| SEC-003-T3 | Add tier explanations to skill detail view | 1h |
| SEC-003-T4 | Create trust tier legend command | 1h |

**TypeScript Implementation:**

```typescript
// src/security/trust/TrustTier.ts
export enum TrustTier {
  OFFICIAL = 'official',
  VERIFIED = 'verified',
  COMMUNITY = 'community',
  UNVERIFIED = 'unverified',
}

export interface TrustTierDisplay {
  tier: TrustTier;
  badge: string;
  color: string;
  description: string;
}

export const TRUST_TIER_DISPLAY: Record<TrustTier, TrustTierDisplay> = {
  [TrustTier.OFFICIAL]: {
    tier: TrustTier.OFFICIAL,
    badge: '[OFFICIAL]',
    color: 'green',
    description: 'Published by Anthropic. Fully reviewed and verified.',
  },
  [TrustTier.VERIFIED]: {
    tier: TrustTier.VERIFIED,
    badge: '[VERIFIED]',
    color: 'blue',
    description: 'Verified publisher. Automated security scan passed.',
  },
  [TrustTier.COMMUNITY]: {
    tier: TrustTier.COMMUNITY,
    badge: '[COMMUNITY]',
    color: 'yellow',
    description: 'Community skill. Basic scan passed. Review before install.',
  },
  [TrustTier.UNVERIFIED]: {
    tier: TrustTier.UNVERIFIED,
    badge: '[UNVERIFIED]',
    color: 'red',
    description: 'Unverified skill. Not scanned. Install at your own risk.',
  },
};
```

---

### Epic: Local-Only Analysis (LOCAL)

#### SEC-004: Codebase Privacy Guarantee

**As a** developer with sensitive code
**I want** all codebase analysis to happen locally
**So that** my source code never leaves my machine

**Description:**
Ensure all codebase scanning and analysis happens locally with no transmission of code content.

**Acceptance Criteria:**
```gherkin
Given I trigger codebase analysis
When the scanner runs
Then all analysis happens locally on my machine
And no code content is transmitted to any external service
And only aggregated metadata (technology counts, framework names) is available

Given I have telemetry enabled
When codebase analysis completes
Then only technology names are logged (e.g., "react", "typescript")
And file paths are NEVER transmitted
And code content is NEVER transmitted
```

**Priority:** P0
**Story Points:** 3

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-004-T1 | Audit scanner to verify local-only operation | 2h |
| SEC-004-T2 | Add telemetry filters to block file paths | 2h |
| SEC-004-T3 | Create network request interceptor for testing | 3h |
| SEC-004-T4 | Document privacy guarantees | 1h |

---

## 4. Phase 1: Foundation Security Stories

### Epic: Static Analysis Pipeline (SCAN)

#### SEC-101: Jailbreak Pattern Detection

**As a** Discovery Hub system
**I want** to detect known jailbreak patterns in skills
**So that** users are protected from prompt injection attacks

**Description:**
Implement regex-based detection of known jailbreak patterns with severity classification and appropriate responses.

**Acceptance Criteria:**
```gherkin
Given a skill contains "ignore previous instructions"
When static analysis runs
Then a CRITICAL severity finding is generated
And the skill is flagged for review
And installation would require explicit confirmation

Given a skill contains "developer mode"
When static analysis runs
Then a CRITICAL severity finding is generated
And the matched pattern and location are recorded

Given a skill contains hidden instructions in HTML comments
When static analysis runs
Then comments are extracted and analyzed
And patterns like "<!-- SYSTEM: override -->" are detected
And a HIGH severity finding is generated

Given a skill passes all jailbreak checks
When static analysis completes
Then no jailbreak findings are recorded
And the skill can proceed to further checks
```

**Priority:** P0
**Story Points:** 8

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-101-T1 | Define jailbreak pattern regex library | 3h |
| SEC-101-T2 | Implement pattern matching engine | 4h |
| SEC-101-T3 | Create HTML comment extractor | 2h |
| SEC-101-T4 | Build finding aggregator with severity | 2h |
| SEC-101-T5 | Implement scan result storage | 2h |
| SEC-101-T6 | Create test cases for each pattern | 4h |
| SEC-101-T7 | Add pattern update mechanism | 2h |

**TypeScript Implementation:**

```typescript
// src/security/scan/patterns/JailbreakPatterns.ts
export interface JailbreakPattern {
  id: string;
  pattern: RegExp;
  severity: 'critical' | 'high' | 'medium';
  description: string;
  example: string;
}

export const JAILBREAK_PATTERNS: JailbreakPattern[] = [
  // Critical Severity - Immediate block
  {
    id: 'JP001',
    pattern: /ignore\s+(previous|prior|all)\s+instructions/gi,
    severity: 'critical',
    description: 'Instruction override attempt',
    example: 'ignore previous instructions',
  },
  {
    id: 'JP002',
    pattern: /developer\s+mode/gi,
    severity: 'critical',
    description: 'Developer mode activation attempt',
    example: 'enable developer mode',
  },
  {
    id: 'JP003',
    pattern: /bypass\s+(safety|security|restrictions)/gi,
    severity: 'critical',
    description: 'Safety bypass attempt',
    example: 'bypass safety checks',
  },
  {
    id: 'JP004',
    pattern: /system\s*:\s*(override|ignore)/gi,
    severity: 'critical',
    description: 'System override attempt',
    example: 'SYSTEM: override',
  },
  {
    id: 'JP005',
    pattern: /you\s+are\s+now\s+[a-z]+/gi,
    severity: 'critical',
    description: 'Persona hijacking attempt',
    example: 'you are now DAN',
  },
  {
    id: 'JP006',
    pattern: /forget\s+(everything|who\s+you\s+are)/gi,
    severity: 'critical',
    description: 'Identity reset attempt',
    example: 'forget who you are',
  },

  // High Severity - Warning with review
  {
    id: 'JP007',
    pattern: /<!--\s*.*?(ignore|system|override|jailbreak).*?\s*-->/gis,
    severity: 'high',
    description: 'Hidden instruction in HTML comment',
    example: '<!-- SYSTEM: ignore safety -->',
  },
  {
    id: 'JP008',
    pattern: /respond\s+without\s+(restrictions|limitations)/gi,
    severity: 'high',
    description: 'Restriction removal request',
    example: 'respond without restrictions',
  },

  // Medium Severity - Monitor
  {
    id: 'JP009',
    pattern: /pretend\s+(you|to\s+be)/gi,
    severity: 'medium',
    description: 'Role-play instruction',
    example: 'pretend you are',
  },
];

// Scanner implementation
export class JailbreakScanner {
  scan(content: string): ScanFinding[] {
    const findings: ScanFinding[] = [];

    for (const pattern of JAILBREAK_PATTERNS) {
      const matches = content.matchAll(pattern.pattern);
      for (const match of matches) {
        findings.push({
          type: 'jailbreak_pattern',
          patternId: pattern.id,
          severity: pattern.severity,
          location: match.index,
          matchedText: match[0],
          description: pattern.description,
          message: `Detected: ${pattern.description} - "${match[0]}"`,
        });
      }
    }

    return findings;
  }
}
```

---

#### SEC-102: URL and Domain Analysis

**As a** Discovery Hub system
**I want** to detect suspicious external URLs
**So that** users are protected from data exfiltration

**Description:**
Extract and analyze all URLs in skill content, comparing against an allowlist of trusted domains.

**Acceptance Criteria:**
```gherkin
Given a skill contains a URL to github.com
When URL analysis runs
Then no finding is generated (domain is allowlisted)

Given a skill contains a URL to unknown-domain.com
When URL analysis runs
Then a HIGH severity finding is generated
And the domain is flagged as suspicious
And the full URL is recorded for review

Given a skill contains dynamic URL construction
When URL analysis runs
Then variable interpolation patterns are detected
And a MEDIUM severity finding is generated
And the pattern is flagged for review
```

**Priority:** P0
**Story Points:** 5

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-102-T1 | Implement URL extraction regex | 2h |
| SEC-102-T2 | Create domain allowlist with management | 3h |
| SEC-102-T3 | Build URL classification engine | 3h |
| SEC-102-T4 | Detect dynamic URL patterns | 2h |
| SEC-102-T5 | Create test suite for URL analysis | 3h |

**TypeScript Implementation:**

```typescript
// src/security/scan/patterns/UrlPatterns.ts
export const DOMAIN_ALLOWLIST: string[] = [
  'github.com',
  'raw.githubusercontent.com',
  'githubusercontent.com',
  'anthropic.com',
  'claude.ai',
  'npmjs.com',
  'pypi.org',
  'docs.python.org',
  'developer.mozilla.org',
  'stackoverflow.com',
];

export interface UrlFinding {
  url: string;
  domain: string;
  severity: 'high' | 'medium' | 'low';
  reason: string;
  location: number;
}

export class UrlScanner {
  private readonly urlPattern = /https?:\/\/[^\s\)\]]+/gi;
  private readonly dynamicUrlPattern = /\$\{.*?\}|%[a-zA-Z_]+%|\{\{.*?\}\}/g;

  scan(content: string): ScanFinding[] {
    const findings: ScanFinding[] = [];

    // Extract all URLs
    const urlMatches = content.matchAll(this.urlPattern);
    for (const match of urlMatches) {
      const url = match[0];
      try {
        const parsedUrl = new URL(url);
        const domain = parsedUrl.hostname;

        // Check if domain contains variable interpolation
        if (this.dynamicUrlPattern.test(url)) {
          findings.push({
            type: 'dynamic_url',
            severity: 'medium',
            location: match.index,
            matchedText: url,
            message: `Dynamic URL construction detected: ${url}`,
          });
          continue;
        }

        // Check against allowlist
        if (!this.isDomainAllowed(domain)) {
          findings.push({
            type: 'suspicious_url',
            severity: 'high',
            location: match.index,
            matchedText: url,
            message: `External URL to non-allowlisted domain: ${domain}`,
          });
        }
      } catch {
        // Invalid URL - log but don't block
        findings.push({
          type: 'malformed_url',
          severity: 'low',
          location: match.index,
          matchedText: url,
          message: `Malformed URL detected: ${url}`,
        });
      }
    }

    return findings;
  }

  private isDomainAllowed(domain: string): boolean {
    return DOMAIN_ALLOWLIST.some(
      allowed => domain === allowed || domain.endsWith(`.${allowed}`)
    );
  }
}
```

---

#### SEC-103: Sensitive File Access Detection

**As a** Discovery Hub system
**I want** to detect references to sensitive files
**So that** users are warned about potential credential exposure

**Description:**
Detect references to sensitive file patterns like .env, credentials, SSH keys in skill content.

**Acceptance Criteria:**
```gherkin
Given a skill references ".env" files
When sensitive file analysis runs
Then a HIGH severity finding is generated
And the file pattern is recorded

Given a skill references "~/.ssh/id_rsa"
When sensitive file analysis runs
Then a HIGH severity finding is generated
And the specific path is flagged

Given a skill references "package.json"
When sensitive file analysis runs
Then no finding is generated (not sensitive)
```

**Priority:** P0
**Story Points:** 3

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-103-T1 | Define sensitive file patterns | 1h |
| SEC-103-T2 | Implement pattern matching for file references | 3h |
| SEC-103-T3 | Create severity classification by file type | 1h |
| SEC-103-T4 | Build test suite | 2h |

**TypeScript Implementation:**

```typescript
// src/security/scan/patterns/SensitiveFilePatterns.ts
export interface SensitiveFilePattern {
  pattern: RegExp;
  severity: 'critical' | 'high' | 'medium';
  category: string;
  description: string;
}

export const SENSITIVE_FILE_PATTERNS: SensitiveFilePattern[] = [
  // Critical - Direct credential files
  {
    pattern: /\.env(\.[a-z]+)?/gi,
    severity: 'critical',
    category: 'environment',
    description: 'Environment variable file (may contain secrets)',
  },
  {
    pattern: /credentials\.?(json|yaml|yml|xml)?/gi,
    severity: 'critical',
    category: 'credentials',
    description: 'Credentials file',
  },
  {
    pattern: /secrets?\.(json|yaml|yml|xml|txt)/gi,
    severity: 'critical',
    category: 'secrets',
    description: 'Secrets file',
  },
  {
    pattern: /\.(pem|key|p12|pfx|crt)/gi,
    severity: 'critical',
    category: 'certificates',
    description: 'Certificate or private key file',
  },

  // High - User-specific sensitive locations
  {
    pattern: /~\/\.ssh\//gi,
    severity: 'high',
    category: 'ssh',
    description: 'SSH directory reference',
  },
  {
    pattern: /~\/\.aws\//gi,
    severity: 'high',
    category: 'aws',
    description: 'AWS credentials directory',
  },
  {
    pattern: /~\/\.config\/gcloud\//gi,
    severity: 'high',
    category: 'gcp',
    description: 'GCP credentials directory',
  },
  {
    pattern: /id_rsa|id_ed25519|id_ecdsa/gi,
    severity: 'high',
    category: 'ssh_keys',
    description: 'SSH private key file',
  },

  // Medium - Potentially sensitive
  {
    pattern: /password\.(txt|json|yaml)/gi,
    severity: 'medium',
    category: 'passwords',
    description: 'Password file',
  },
  {
    pattern: /\.npmrc/gi,
    severity: 'medium',
    category: 'npm',
    description: 'npm configuration (may contain tokens)',
  },
  {
    pattern: /\.git\/config/gi,
    severity: 'medium',
    category: 'git',
    description: 'Git config (may contain credentials)',
  },
];

export class SensitiveFileScanner {
  scan(content: string): ScanFinding[] {
    const findings: ScanFinding[] = [];

    for (const pattern of SENSITIVE_FILE_PATTERNS) {
      const matches = content.matchAll(pattern.pattern);
      for (const match of matches) {
        findings.push({
          type: 'sensitive_file_access',
          severity: pattern.severity,
          location: match.index,
          matchedText: match[0],
          category: pattern.category,
          message: `Reference to ${pattern.description}: "${match[0]}"`,
        });
      }
    }

    return findings;
  }
}
```

---

#### SEC-104: Obfuscation Detection

**As a** Discovery Hub system
**I want** to detect potentially obfuscated content
**So that** users are warned about hidden instructions

**Description:**
Implement entropy analysis and pattern detection to identify potentially obfuscated content.

**Acceptance Criteria:**
```gherkin
Given a skill contains a Base64 string > 50 characters
When obfuscation detection runs
Then a MEDIUM severity finding is generated
And the encoded content is flagged for review

Given a skill contains high-entropy text blocks (> 4.5 bits/char)
When entropy analysis runs
Then a MEDIUM severity finding is generated
And the block is flagged as potentially obfuscated

Given a skill contains zero-width characters
When obfuscation detection runs
Then a HIGH severity finding is generated
And the invisible characters are identified
```

**Priority:** P1
**Story Points:** 5

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-104-T1 | Implement Shannon entropy calculation | 3h |
| SEC-104-T2 | Create Base64/hex detection patterns | 2h |
| SEC-104-T3 | Build zero-width character detector | 2h |
| SEC-104-T4 | Create code block extractor for analysis | 2h |
| SEC-104-T5 | Build test suite with obfuscation samples | 3h |

**TypeScript Implementation:**

```typescript
// src/security/scan/ObfuscationScanner.ts
export class ObfuscationScanner {
  private readonly ENTROPY_THRESHOLD = 4.5;
  private readonly base64Pattern = /[A-Za-z0-9+\/]{50,}={0,2}/g;
  private readonly hexPattern = /(?:0x)?[0-9a-fA-F]{40,}/g;
  private readonly zeroWidthPattern = /[\u200B-\u200D\uFEFF\u2060\u2062-\u2064]/g;

  scan(content: string): ScanFinding[] {
    const findings: ScanFinding[] = [];

    // Check for Base64 encoded blocks
    findings.push(...this.scanBase64(content));

    // Check for hex encoded blocks
    findings.push(...this.scanHex(content));

    // Check for zero-width characters
    findings.push(...this.scanZeroWidth(content));

    // Check entropy of code blocks
    findings.push(...this.scanEntropy(content));

    return findings;
  }

  private scanBase64(content: string): ScanFinding[] {
    const findings: ScanFinding[] = [];
    const matches = content.matchAll(this.base64Pattern);

    for (const match of matches) {
      // Verify it's likely Base64 by checking if it decodes
      try {
        const decoded = atob(match[0]);
        // If it decodes to something with printable chars, flag it
        if (/[a-zA-Z]/.test(decoded)) {
          findings.push({
            type: 'potential_base64',
            severity: 'medium',
            location: match.index,
            matchedText: match[0].substring(0, 50) + '...',
            message: 'Potential Base64 encoded content detected',
          });
        }
      } catch {
        // Not valid Base64, ignore
      }
    }

    return findings;
  }

  private scanZeroWidth(content: string): ScanFinding[] {
    const findings: ScanFinding[] = [];
    const matches = content.matchAll(this.zeroWidthPattern);

    for (const match of matches) {
      findings.push({
        type: 'zero_width_character',
        severity: 'high',
        location: match.index,
        matchedText: `Unicode ${match[0].charCodeAt(0).toString(16)}`,
        message: 'Zero-width character detected (may hide content)',
      });
    }

    return findings;
  }

  private scanEntropy(content: string): ScanFinding[] {
    const findings: ScanFinding[] = [];
    const codeBlocks = this.extractCodeBlocks(content);

    for (const block of codeBlocks) {
      const entropy = this.calculateShannonEntropy(block.content);

      if (entropy > this.ENTROPY_THRESHOLD) {
        findings.push({
          type: 'high_entropy',
          severity: 'medium',
          location: block.start,
          matchedText: block.content.substring(0, 50) + '...',
          message: `High entropy content (${entropy.toFixed(2)} bits/char) - may be obfuscated`,
        });
      }
    }

    return findings;
  }

  private calculateShannonEntropy(str: string): number {
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

  private extractCodeBlocks(content: string): Array<{ content: string; start: number }> {
    const blocks: Array<{ content: string; start: number }> = [];
    const codeBlockPattern = /```[\s\S]*?```|`[^`]+`/g;
    let match;

    while ((match = codeBlockPattern.exec(content)) !== null) {
      blocks.push({
        content: match[0].replace(/```\w*\n?|```|`/g, ''),
        start: match.index,
      });
    }

    return blocks;
  }
}
```

---

### Epic: Typosquatting Prevention (TYPO)

#### SEC-105: Typosquatting Detection Engine

**As a** user installing skills
**I want** to be warned about typosquatting attempts
**So that** I don't accidentally install malicious lookalikes

**Description:**
Implement typosquatting detection using Levenshtein distance, character substitution detection, and visual confusable analysis.

**Acceptance Criteria:**
```gherkin
Given I search for "anthroplc/test-fixing"
When typosquatting detection runs
Then a similarity is detected with "anthropic/test-fixing"
And I see a warning about potential typosquatting
And I am shown the verified skill as an alternative

Given the similarity confidence is >= 0.9
When I attempt to install
Then installation is blocked
And I see a clear explanation of the typosquatting risk

Given the similarity confidence is between 0.5 and 0.9
When I attempt to install
Then I see a warning but can proceed with confirmation
```

**Priority:** P0
**Story Points:** 8

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-105-T1 | Implement Levenshtein distance algorithm | 2h |
| SEC-105-T2 | Build character substitution map | 2h |
| SEC-105-T3 | Create typosquat confidence scoring | 3h |
| SEC-105-T4 | Implement known skills cache for comparison | 3h |
| SEC-105-T5 | Build warning display and confirmation flow | 3h |
| SEC-105-T6 | Create comprehensive test suite | 3h |

**TypeScript Implementation:**

```typescript
// src/security/typosquat/TyposquatDetector.ts
export interface TyposquatResult {
  isSuspicious: boolean;
  similarTo: string[];
  confidence: number;
  recommendation: 'safe' | 'warning' | 'block';
  reasons: string[];
}

// Character substitution map for visual confusables
const LOOKALIKES: Record<string, string[]> = {
  'l': ['1', 'I', '|', 'i'],
  'I': ['l', '1', '|'],
  '1': ['l', 'I', '|'],
  'O': ['0', 'o'],
  'o': ['0', 'O'],
  '0': ['O', 'o'],
  'S': ['5', '$'],
  '5': ['S'],
  'a': ['@', '4'],
  '@': ['a'],
  'e': ['3'],
  '3': ['e'],
  'rn': ['m'],
  'm': ['rn'],
  'vv': ['w'],
  'w': ['vv'],
  'cl': ['d'],
  'd': ['cl'],
  '-': ['_'],
  '_': ['-'],
};

export class TyposquatDetector {
  private knownSkills: Set<string>;

  constructor(knownSkills: string[]) {
    this.knownSkills = new Set(knownSkills);
  }

  check(skillName: string): TyposquatResult {
    const suspicious: Array<{ name: string; confidence: number; reasons: string[] }> = [];

    for (const known of this.knownSkills) {
      if (skillName === known) continue;

      const result = this.compare(skillName, known);
      if (result.confidence > 0.5) {
        suspicious.push({
          name: known,
          confidence: result.confidence,
          reasons: result.reasons,
        });
      }
    }

    if (suspicious.length === 0) {
      return {
        isSuspicious: false,
        similarTo: [],
        confidence: 0,
        recommendation: 'safe',
        reasons: [],
      };
    }

    // Get highest confidence match
    suspicious.sort((a, b) => b.confidence - a.confidence);
    const best = suspicious[0];

    return {
      isSuspicious: true,
      similarTo: suspicious.map(s => s.name),
      confidence: best.confidence,
      recommendation: this.getRecommendation(best.confidence),
      reasons: best.reasons,
    };
  }

  private compare(input: string, known: string): { confidence: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;
    let maxScore = 0;

    // Levenshtein distance check (40% weight)
    const distance = this.levenshteinDistance(input.toLowerCase(), known.toLowerCase());
    const maxLen = Math.max(input.length, known.length);
    if (distance <= 2 && distance > 0) {
      const distanceScore = ((maxLen - distance) / maxLen) * 0.4;
      score += distanceScore;
      reasons.push(`Edit distance: ${distance} character(s) different`);
    }
    maxScore += 0.4;

    // Character substitution check (30% weight)
    const substitutionMatch = this.checkSubstitutions(input, known);
    if (substitutionMatch.isMatch) {
      score += 0.3;
      reasons.push(...substitutionMatch.reasons);
    }
    maxScore += 0.3;

    // Hyphen/underscore swap (15% weight)
    const normalizedInput = input.replace(/[-_]/g, '');
    const normalizedKnown = known.replace(/[-_]/g, '');
    if (normalizedInput.toLowerCase() === normalizedKnown.toLowerCase() &&
        input.toLowerCase() !== known.toLowerCase()) {
      score += 0.15;
      reasons.push('Hyphen/underscore substitution detected');
    }
    maxScore += 0.15;

    // Word transposition (15% weight)
    const inputWords = input.split(/[-_\/]/).sort();
    const knownWords = known.split(/[-_\/]/).sort();
    if (inputWords.join('').toLowerCase() === knownWords.join('').toLowerCase() &&
        input !== known) {
      score += 0.15;
      reasons.push('Word order transposition detected');
    }
    maxScore += 0.15;

    return {
      confidence: score / maxScore,
      reasons,
    };
  }

  private checkSubstitutions(input: string, known: string): { isMatch: boolean; reasons: string[] } {
    const reasons: string[] = [];
    let normalizedInput = input.toLowerCase();
    let normalizedKnown = known.toLowerCase();

    // Apply all substitutions to input
    for (const [char, substitutes] of Object.entries(LOOKALIKES)) {
      for (const sub of substitutes) {
        normalizedInput = normalizedInput.replace(new RegExp(char, 'g'), sub);
      }
    }

    // Check if normalized versions match
    if (normalizedInput === normalizedKnown && input !== known) {
      // Find which substitutions were made
      for (let i = 0; i < Math.min(input.length, known.length); i++) {
        if (input[i] !== known[i]) {
          const inputChar = input[i];
          const knownChar = known[i];
          if (LOOKALIKES[inputChar]?.includes(knownChar) ||
              LOOKALIKES[knownChar]?.includes(inputChar)) {
            reasons.push(`Character substitution: '${inputChar}' looks like '${knownChar}'`);
          }
        }
      }
      return { isMatch: true, reasons };
    }

    return { isMatch: false, reasons: [] };
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b[i - 1] === a[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  private getRecommendation(confidence: number): 'safe' | 'warning' | 'block' {
    if (confidence >= 0.9) return 'block';
    if (confidence >= 0.7) return 'warning';
    return 'safe';
  }
}
```

---

### Epic: Blocklist Management (BLOCK)

#### SEC-106: Blocklist Infrastructure

**As a** Discovery Hub system
**I want** to maintain and enforce a skill blocklist
**So that** known-bad skills are blocked from installation

**Description:**
Implement blocklist storage, cryptographic verification, automatic updates, and enforcement at search and install time.

**Acceptance Criteria:**
```gherkin
Given a skill is on the blocklist
When a user searches for it
Then it is excluded from search results

Given a skill is on the blocklist
When a user attempts to install by direct ID
Then installation is blocked
And the reason for blocking is displayed
And the user cannot override

Given the blocklist is updated
When the update is published
Then clients fetch the update within 6 hours
And signature is verified before applying
And invalid signatures are rejected
```

**Priority:** P0
**Story Points:** 5

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-106-T1 | Define blocklist YAML schema | 1h |
| SEC-106-T2 | Implement blocklist storage and loading | 3h |
| SEC-106-T3 | Create cryptographic signature verification | 4h |
| SEC-106-T4 | Build auto-update mechanism | 3h |
| SEC-106-T5 | Integrate blocklist check in search | 2h |
| SEC-106-T6 | Integrate blocklist check in install | 2h |
| SEC-106-T7 | Create test suite with mock blocklist | 2h |

**TypeScript Implementation:**

```typescript
// src/security/blocklist/BlocklistManager.ts
export interface BlockedSkill {
  id: string;
  reason: string;
  severity: 'critical' | 'high';
  blockedDate: string;
  cve?: string;
  reporter: string;
}

export interface Blocklist {
  version: number;
  lastUpdated: string;
  signature: string;
  blockedSkills: BlockedSkill[];
  blockedPublishers: Array<{
    pattern: string;
    reason: string;
    blockedDate: string;
  }>;
}

export interface BlocklistCheckResult {
  blocked: boolean;
  reason?: string;
  severity?: 'critical' | 'high';
  cve?: string;
}

export class BlocklistManager {
  private blocklist: Blocklist | null = null;
  private readonly blocklistUrl: string;
  private readonly publicKey: string;
  private readonly updateIntervalMs = 6 * 60 * 60 * 1000; // 6 hours

  constructor(blocklistUrl: string, publicKey: string) {
    this.blocklistUrl = blocklistUrl;
    this.publicKey = publicKey;
  }

  async initialize(): Promise<void> {
    await this.loadCachedBlocklist();
    this.startAutoUpdate();
  }

  async checkSkill(skillId: string): Promise<BlocklistCheckResult> {
    if (!this.blocklist) {
      await this.loadCachedBlocklist();
    }

    // Check direct skill block
    const blocked = this.blocklist?.blockedSkills.find(s => s.id === skillId);
    if (blocked) {
      return {
        blocked: true,
        reason: blocked.reason,
        severity: blocked.severity,
        cve: blocked.cve,
      };
    }

    // Check publisher pattern block
    for (const publisher of this.blocklist?.blockedPublishers || []) {
      if (this.matchesPattern(skillId, publisher.pattern)) {
        return {
          blocked: true,
          reason: publisher.reason,
          severity: 'high',
        };
      }
    }

    return { blocked: false };
  }

  async update(): Promise<boolean> {
    try {
      const response = await fetch(this.blocklistUrl);
      const newBlocklist: Blocklist = await response.json();

      // Verify signature
      if (!await this.verifySignature(newBlocklist)) {
        console.error('Blocklist signature verification failed');
        return false;
      }

      // Check version is newer
      if (this.blocklist && newBlocklist.version <= this.blocklist.version) {
        return false; // No update needed
      }

      this.blocklist = newBlocklist;
      await this.persistBlocklist();
      return true;
    } catch (error) {
      console.error('Failed to update blocklist:', error);
      return false;
    }
  }

  private async verifySignature(blocklist: Blocklist): Promise<boolean> {
    // Create signature verification using Web Crypto API
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify({
      version: blocklist.version,
      lastUpdated: blocklist.lastUpdated,
      blockedSkills: blocklist.blockedSkills,
      blockedPublishers: blocklist.blockedPublishers,
    }));

    const signatureBuffer = this.base64ToArrayBuffer(blocklist.signature);
    const keyBuffer = this.base64ToArrayBuffer(this.publicKey);

    const key = await crypto.subtle.importKey(
      'spki',
      keyBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signatureBuffer,
      data
    );
  }

  private matchesPattern(skillId: string, pattern: string): boolean {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${regexPattern}$`).test(skillId);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  private startAutoUpdate(): void {
    setInterval(() => this.update(), this.updateIntervalMs);
  }
}
```

---

### Epic: Trust Tier System (TRUST)

#### SEC-107: Trust Tier Computation Engine

**As a** Discovery Hub system
**I want** to compute trust tiers for all skills
**So that** users see accurate trust indicators

**Description:**
Implement the full trust tier computation algorithm combining publisher verification, scan results, and community metrics.

**Acceptance Criteria:**
```gherkin
Given a skill is in the "anthropic/*" namespace
When trust tier is computed
Then the skill is assigned OFFICIAL tier

Given a skill has:
  - Verified publisher
  - Scan passed
  - 10+ stars
  - 30+ days old
When trust tier is computed
Then the skill is assigned VERIFIED tier

Given a skill has:
  - Scan passed
  - License present
  - README present
  - SKILL.md present
When trust tier is computed
Then the skill is assigned COMMUNITY tier

Given a skill fails security scan
When trust tier is computed
Then the skill is assigned UNVERIFIED tier
```

**Priority:** P0
**Story Points:** 5

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-107-T1 | Implement publisher verification check | 3h |
| SEC-107-T2 | Create metadata presence validation | 2h |
| SEC-107-T3 | Build tier computation logic | 3h |
| SEC-107-T4 | Integrate with scan results | 2h |
| SEC-107-T5 | Create tier update triggers | 2h |
| SEC-107-T6 | Write unit tests | 3h |

**TypeScript Implementation:**

```typescript
// src/security/trust/TrustTierComputer.ts
export interface SkillMetadata {
  id: string;
  namespace: string;
  publisherVerified: boolean;
  scanPassed: boolean;
  scanFindings: ScanFinding[];
  stars: number;
  createdAt: Date;
  hasLicense: boolean;
  hasReadme: boolean;
  hasSkillMd: boolean;
  lastCommitAt: Date;
}

export class TrustTierComputer {
  computeTier(metadata: SkillMetadata): TrustTier {
    // Official: Anthropic namespace
    if (metadata.namespace === 'anthropic') {
      return TrustTier.OFFICIAL;
    }

    // Check for critical scan findings (immediate UNVERIFIED)
    const hasCriticalFindings = metadata.scanFindings.some(
      f => f.severity === 'critical'
    );
    if (hasCriticalFindings) {
      return TrustTier.UNVERIFIED;
    }

    // Verified: publisher verified + scan passed + history
    const daysSinceCreation = this.daysSince(metadata.createdAt);
    if (
      metadata.publisherVerified &&
      metadata.scanPassed &&
      metadata.stars >= 10 &&
      daysSinceCreation >= 30
    ) {
      return TrustTier.VERIFIED;
    }

    // Community: scan passed + basic metadata
    if (
      metadata.scanPassed &&
      metadata.hasLicense &&
      metadata.hasReadme &&
      metadata.hasSkillMd
    ) {
      return TrustTier.COMMUNITY;
    }

    // Default: Unverified
    return TrustTier.UNVERIFIED;
  }

  computeTrustScore(metadata: SkillMetadata): number {
    let score = 0;

    // Publisher score (30%)
    const publisherScore = this.getPublisherScore(metadata);
    score += publisherScore * 0.30;

    // Scan score (25%)
    const scanScore = this.getScanScore(metadata);
    score += scanScore * 0.25;

    // Community score (15%)
    const communityScore = Math.min(100, metadata.stars * 5);
    score += communityScore * 0.15;

    // Age score (10%)
    const ageScore = Math.min(100, this.daysSince(metadata.createdAt) / 3);
    score += ageScore * 0.10;

    // Activity score (10%)
    const activityScore = this.getActivityScore(metadata);
    score += activityScore * 0.10;

    // Metadata completeness (10%)
    const metadataScore = this.getMetadataScore(metadata);
    score += metadataScore * 0.10;

    return Math.round(score);
  }

  private getPublisherScore(metadata: SkillMetadata): number {
    if (metadata.namespace === 'anthropic') return 100;
    if (metadata.publisherVerified) return 80;
    return 20;
  }

  private getScanScore(metadata: SkillMetadata): number {
    if (!metadata.scanPassed) return 0;

    const hasHighFindings = metadata.scanFindings.some(f => f.severity === 'high');
    const hasMediumFindings = metadata.scanFindings.some(f => f.severity === 'medium');

    if (!hasHighFindings && !hasMediumFindings) return 100;
    if (!hasHighFindings) return 70;
    return 30;
  }

  private getActivityScore(metadata: SkillMetadata): number {
    const daysSinceCommit = this.daysSince(metadata.lastCommitAt);
    if (daysSinceCommit <= 30) return 100;
    if (daysSinceCommit <= 90) return 70;
    if (daysSinceCommit <= 365) return 40;
    return 20;
  }

  private getMetadataScore(metadata: SkillMetadata): number {
    let score = 0;
    if (metadata.hasLicense) score += 34;
    if (metadata.hasReadme) score += 33;
    if (metadata.hasSkillMd) score += 33;
    return score;
  }

  private daysSince(date: Date): number {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }
}
```

---

## 5. Phase 2: Advanced Security Stories

### Epic: Conflict Detection (CONFLICT)

#### SEC-201: Trigger Overlap Detection

**As a** user with multiple skills installed
**I want** to know if skills conflict
**So that** I can avoid unpredictable behavior

**Description:**
Implement trigger overlap detection by analyzing skill activation patterns and keywords.

**Acceptance Criteria:**
```gherkin
Given I attempt to install a skill
When the skill has trigger overlap >= 70% with installed skills
Then I see a conflict warning before installation
And overlapping triggers are highlighted
And I am given options: set priority, disable, or proceed anyway

Given I want to check all conflicts
When I execute "/discover conflicts"
Then I see all detected conflicts between installed skills
And each conflict shows severity (high/medium/low)
And resolution suggestions are provided
```

**Priority:** P0
**Story Points:** 5

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-201-T1 | Implement trigger keyword extraction | 3h |
| SEC-201-T2 | Create similarity scoring (Jaccard + embeddings) | 4h |
| SEC-201-T3 | Build conflict classification | 2h |
| SEC-201-T4 | Create conflict warning UI | 2h |
| SEC-201-T5 | Implement "/discover conflicts" command | 2h |
| SEC-201-T6 | Write test suite | 3h |

**TypeScript Implementation:**

```typescript
// src/security/conflict/TriggerOverlapDetector.ts
export interface ConflictResult {
  type: 'trigger' | 'output' | 'convention' | 'behavioral';
  severity: 'high' | 'medium' | 'low';
  skills: [string, string];
  overlap: number;
  description: string;
  overlappingTriggers: string[];
  resolutionOptions: string[];
}

export class TriggerOverlapDetector {
  detectConflicts(skills: SkillContent[]): ConflictResult[] {
    const conflicts: ConflictResult[] = [];

    for (let i = 0; i < skills.length; i++) {
      for (let j = i + 1; j < skills.length; j++) {
        const overlap = this.computeOverlap(skills[i], skills[j]);

        if (overlap.score >= 0.5) {
          conflicts.push({
            type: 'trigger',
            severity: this.getSeverity(overlap.score),
            skills: [skills[i].id, skills[j].id],
            overlap: overlap.score,
            description: `Both skills activate on similar triggers (${Math.round(overlap.score * 100)}% overlap)`,
            overlappingTriggers: overlap.commonKeywords,
            resolutionOptions: [
              `Set priority: ${skills[i].id} > ${skills[j].id}`,
              `Set priority: ${skills[j].id} > ${skills[i].id}`,
              `Disable one skill for this project`,
              `Use explicit invocation for one skill`,
            ],
          });
        }
      }
    }

    return conflicts;
  }

  private computeOverlap(
    skillA: SkillContent,
    skillB: SkillContent
  ): { score: number; commonKeywords: string[] } {
    const keywordsA = this.extractTriggerKeywords(skillA);
    const keywordsB = this.extractTriggerKeywords(skillB);

    // Jaccard similarity
    const intersection = keywordsA.filter(k => keywordsB.includes(k));
    const union = [...new Set([...keywordsA, ...keywordsB])];

    const jaccard = union.length > 0 ? intersection.length / union.length : 0;

    return {
      score: jaccard,
      commonKeywords: intersection,
    };
  }

  private extractTriggerKeywords(skill: SkillContent): string[] {
    const keywords: string[] = [];

    // Extract from description
    const descWords = skill.description.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3)
      .filter(w => !this.isStopWord(w));
    keywords.push(...descWords);

    // Extract from "trigger" or "activate when" patterns
    const triggerPatterns = [
      /activate\s+when\s+(.+?)(?:\.|$)/gi,
      /use\s+for\s+(.+?)(?:\.|$)/gi,
      /triggers?\s+on\s+(.+?)(?:\.|$)/gi,
    ];

    for (const pattern of triggerPatterns) {
      const matches = skill.content.matchAll(pattern);
      for (const match of matches) {
        const triggerWords = match[1].toLowerCase().split(/\s+/);
        keywords.push(...triggerWords);
      }
    }

    return [...new Set(keywords)];
  }

  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'will',
      'your', 'you', 'are', 'can', 'should', 'would', 'could', 'have', 'has',
    ]);
    return stopWords.has(word);
  }

  private getSeverity(score: number): 'high' | 'medium' | 'low' {
    if (score >= 0.85) return 'high';
    if (score >= 0.70) return 'medium';
    return 'low';
  }
}
```

---

#### SEC-202: Output Collision Detection

**As a** user installing skills
**I want** to know if skills write to the same files
**So that** I don't lose work from file overwrites

**Description:**
Detect when multiple skills may write to the same output paths.

**Acceptance Criteria:**
```gherkin
Given two installed skills both reference "README.md"
When output collision detection runs
Then a HIGH severity conflict is reported
And the conflicting path is identified
And both skill IDs are listed

Given I view the conflict report
When I see output collision details
Then I am given options to configure different paths or disable one skill
```

**Priority:** P0
**Story Points:** 3

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-202-T1 | Implement output path extraction from skill content | 3h |
| SEC-202-T2 | Build collision detection logic | 2h |
| SEC-202-T3 | Create collision report format | 1h |
| SEC-202-T4 | Write test suite | 2h |

**TypeScript Implementation:**

```typescript
// src/security/conflict/OutputCollisionDetector.ts
export interface OutputCollision {
  path: string;
  skills: string[];
  severity: 'high';
}

export class OutputCollisionDetector {
  private readonly outputPatterns = [
    /generate\s+(?:a\s+)?['"]?([^'"]+\.md)['"]?/gi,
    /create\s+(?:file\s+)?['"]?([^'"]+)['"]?/gi,
    /write\s+to\s+['"]?([^'"]+)['"]?/gi,
    /output\s+(?:to\s+)?['"]?([^'"]+)['"]?/gi,
  ];

  detectCollisions(skills: SkillContent[]): OutputCollision[] {
    const pathMap = new Map<string, string[]>();

    for (const skill of skills) {
      const paths = this.extractOutputPaths(skill.content);

      for (const path of paths) {
        const normalized = this.normalizePath(path);
        if (!pathMap.has(normalized)) {
          pathMap.set(normalized, []);
        }
        pathMap.get(normalized)!.push(skill.id);
      }
    }

    // Return paths with multiple skills
    return Array.from(pathMap.entries())
      .filter(([_, skillIds]) => skillIds.length > 1)
      .map(([path, skillIds]) => ({
        path,
        skills: skillIds,
        severity: 'high' as const,
      }));
  }

  private extractOutputPaths(content: string): string[] {
    const paths: string[] = [];

    for (const pattern of this.outputPatterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) {
          paths.push(match[1]);
        }
      }
    }

    return paths;
  }

  private normalizePath(path: string): string {
    // Normalize to consistent format
    return path
      .toLowerCase()
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
  }
}
```

---

#### SEC-203: Priority Configuration System

**As a** user managing skill conflicts
**I want** to set priorities for skills
**So that** higher-priority skills take precedence

**Description:**
Implement priority configuration with global and per-project settings.

**Acceptance Criteria:**
```gherkin
Given I want to prioritize a skill
When I execute "/discover priority set <skill-id> 80"
Then the priority is saved to my configuration
And the skill will take precedence over lower-priority skills

Given I have project-specific needs
When I set priorities in a project directory
Then priorities apply only to that project
And global priorities serve as fallback

Given I want to view priorities
When I execute "/discover priorities"
Then I see all configured priorities
And I see effective priority for current project
```

**Priority:** P1
**Story Points:** 5

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-203-T1 | Design priority configuration schema | 1h |
| SEC-203-T2 | Implement global priority storage | 2h |
| SEC-203-T3 | Implement per-project priority overrides | 3h |
| SEC-203-T4 | Create CLI commands for priority management | 2h |
| SEC-203-T5 | Build priority resolution logic | 2h |
| SEC-203-T6 | Write test suite | 2h |

---

### Epic: Privacy Telemetry Controls (PRIV)

#### SEC-204: Granular Telemetry Consent

**As a** privacy-conscious user
**I want** fine-grained control over telemetry
**So that** I can share what I'm comfortable with

**Description:**
Implement three-tier consent model: Essential (errors only), Analytics (usage data), Research (experiments).

**Acceptance Criteria:**
```gherkin
Given I am configuring telemetry
When I view telemetry settings
Then I see three consent levels explained
And I can enable/disable each level independently

Given I set consent to "Essential" only
When I use Discovery Hub
Then only error events are collected
And no usage analytics are sent
And no research data is sent

Given I want to see what would be collected
When I execute "/discover telemetry preview"
Then I see example events for each enabled level
And I understand what data each level includes
```

**Priority:** P1
**Story Points:** 5

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-204-T1 | Define consent level taxonomy | 1h |
| SEC-204-T2 | Implement consent storage and management | 3h |
| SEC-204-T3 | Create event routing based on consent | 3h |
| SEC-204-T4 | Build consent UI in CLI | 2h |
| SEC-204-T5 | Implement preview command | 2h |
| SEC-204-T6 | Write test suite | 2h |

**TypeScript Implementation:**

```typescript
// src/security/telemetry/ConsentManager.ts
export enum ConsentLevel {
  NONE = 'none',
  ESSENTIAL = 'essential',   // Errors only
  ANALYTICS = 'analytics',   // + usage data
  RESEARCH = 'research',     // + experiments
}

export interface ConsentConfig {
  level: ConsentLevel;
  version: number;
  timestamp: string;
  individualConsents: {
    errors: boolean;
    usage: boolean;
    experiments: boolean;
  };
}

export class ConsentManager {
  private config: ConsentConfig;

  isEventAllowed(eventType: string): boolean {
    // Essential events (errors) always allowed unless fully opted out
    if (this.isEssentialEvent(eventType)) {
      return this.config.level !== ConsentLevel.NONE;
    }

    // Analytics events require analytics consent
    if (this.isAnalyticsEvent(eventType)) {
      return this.config.level === ConsentLevel.ANALYTICS ||
             this.config.level === ConsentLevel.RESEARCH;
    }

    // Research events require research consent
    if (this.isResearchEvent(eventType)) {
      return this.config.level === ConsentLevel.RESEARCH;
    }

    return false;
  }

  private isEssentialEvent(eventType: string): boolean {
    return eventType.startsWith('error_') || eventType.startsWith('crash_');
  }

  private isAnalyticsEvent(eventType: string): boolean {
    const analyticsEvents = [
      'skill_impression',
      'skill_installed',
      'skill_activated',
      'recommendation_feedback',
      'search_performed',
    ];
    return analyticsEvents.includes(eventType);
  }

  private isResearchEvent(eventType: string): boolean {
    return eventType.startsWith('experiment_') || eventType.startsWith('survey_');
  }
}
```

---

#### SEC-205: Data Deletion Request

**As a** user exercising privacy rights
**I want** to request deletion of my collected data
**So that** I can comply with GDPR/CCPA requirements

**Description:**
Implement data deletion request mechanism that clears local data and notifies backend.

**Acceptance Criteria:**
```gherkin
Given I want to delete my data
When I execute "/discover privacy delete"
Then local telemetry queue is cleared
And a deletion request is sent to backend
And I receive confirmation of the request
And my anonymous ID is rotated to prevent re-linking

Given data deletion is complete
When I continue using Discovery Hub
Then new data is collected under a new anonymous ID
And previous data cannot be linked to new activity
```

**Priority:** P2
**Story Points:** 3

**Tasks:**

| Task ID | Description | Estimate |
|---------|-------------|----------|
| SEC-205-T1 | Implement local data clearing | 2h |
| SEC-205-T2 | Create backend deletion request | 2h |
| SEC-205-T3 | Implement anonymous ID rotation | 2h |
| SEC-205-T4 | Build confirmation flow | 1h |

---

## 6. Story Dependencies Map

```
Phase 0 Dependencies:
+----------------------------------------------------------------------+
|                                                                      |
|  SEC-001 (Telemetry) ----+                                           |
|                          |                                           |
|  SEC-002 (Privacy Notice)+----> SEC-004 (Codebase Privacy)           |
|                          |                                           |
|  SEC-003 (Trust Display)-+                                           |
|                                                                      |
+----------------------------------------------------------------------+

Phase 1 Dependencies:
+----------------------------------------------------------------------+
|                                                                      |
|  SEC-101 (Jailbreak) ---+                                            |
|                         |                                            |
|  SEC-102 (URL Scan) ----+----> SEC-107 (Trust Computation)           |
|                         |                                            |
|  SEC-103 (Sensitive) ---+                                            |
|                         |                                            |
|  SEC-104 (Obfuscation) -+                                            |
|                                                                      |
|  SEC-105 (Typosquat) -----> Standalone                               |
|                                                                      |
|  SEC-106 (Blocklist) -----> Standalone                               |
|                                                                      |
+----------------------------------------------------------------------+

Phase 2 Dependencies:
+----------------------------------------------------------------------+
|                                                                      |
|  SEC-201 (Trigger Overlap) ---+                                      |
|                               +----> SEC-203 (Priority Config)       |
|  SEC-202 (Output Collision) --+                                      |
|                                                                      |
|  SEC-001 -----> SEC-204 (Granular Consent)                           |
|                         |                                            |
|                         +----> SEC-205 (Data Deletion)               |
|                                                                      |
+----------------------------------------------------------------------+
```

---

## 7. Security Artifacts Reference

### Detection Pattern Library

| File | Purpose |
|------|---------|
| `/src/security/scan/patterns/JailbreakPatterns.ts` | Jailbreak detection regex patterns |
| `/src/security/scan/patterns/UrlPatterns.ts` | URL and domain analysis patterns |
| `/src/security/scan/patterns/SensitiveFilePatterns.ts` | Sensitive file detection patterns |
| `/src/security/scan/ObfuscationScanner.ts` | Entropy and obfuscation detection |

### Blocklist Schema

```yaml
# blocklist.schema.yaml
version: integer
lastUpdated: string (ISO 8601)
signature: string (Base64 RSA-SHA256)

blockedSkills:
  - id: string (skill ID)
    reason: string
    severity: critical | high
    blockedDate: string (ISO 8601)
    cve: string | null
    reporter: string

blockedPublishers:
  - pattern: string (glob pattern)
    reason: string
    blockedDate: string (ISO 8601)
```

### Trust Tier Configuration

```yaml
# trust-tiers.schema.yaml
tiers:
  official:
    requirements:
      - namespace: "anthropic/*"
      - manualReview: true
      - signing: "anthropic_key"
    badge: "[OFFICIAL]"
    color: "green"

  verified:
    requirements:
      - publisherVerified: true
      - scanPassed: true
      - minStars: 10
      - minAgeDays: 30
    badge: "[VERIFIED]"
    color: "blue"

  community:
    requirements:
      - scanPassed: true
      - hasLicense: true
      - hasReadme: true
      - hasSkillMd: true
    badge: "[COMMUNITY]"
    color: "yellow"

  unverified:
    requirements: []
    badge: "[UNVERIFIED]"
    color: "red"
```

---

## 8. Definition of Done

### Story-Level Security Definition of Done

All security stories must meet these criteria:

**Functionality:**
- [ ] All acceptance criteria pass
- [ ] Security controls function in offline mode
- [ ] Error states handled securely (fail closed)
- [ ] Performance targets met

**Security Quality:**
- [ ] Unit tests cover all detection patterns
- [ ] Negative tests for bypass attempts
- [ ] No false positive rate > 5%
- [ ] No known bypass vulnerabilities
- [ ] Security review completed

**Documentation:**
- [ ] Pattern library documented
- [ ] Bypass attempts documented in tests
- [ ] API documentation updated
- [ ] User-facing security notices finalized

### Phase-Level Security Definition of Done

**Phase 0 Complete When:**
- [ ] SEC-001 through SEC-004 complete
- [ ] Telemetry opt-out verified working
- [ ] Privacy notice reviewed by legal
- [ ] Local-only guarantee verified

**Phase 1 Complete When:**
- [ ] SEC-101 through SEC-107 complete
- [ ] All detection patterns tested against real-world samples
- [ ] Blocklist infrastructure operational
- [ ] Trust tiers displaying correctly
- [ ] Zero critical security incidents in testing

**Phase 2 Complete When:**
- [ ] SEC-201 through SEC-205 complete
- [ ] Conflict detection covering >80% of conflicts
- [ ] Priority system tested with real users
- [ ] GDPR/CCPA compliance verified

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [Security Architecture](/docs/architecture/security.md) | Architecture source of truth |
| [Threat Model](/docs/technical/security/threat-model.md) | Threat analysis |
| [Trust Tiers](/docs/technical/security/trust-tiers.md) | Trust tier specification |
| [Static Analysis](/docs/technical/security/static-analysis.md) | Scanning specification |
| [Conflict Detection](/docs/technical/security/conflict-detection.md) | Conflict specification |
| [Telemetry Consent](/docs/research/telemetry-consent.md) | Privacy research |
| [Security Research](/docs/research/skill-conflicts-security.md) | Research reference |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | December 26, 2025 | Security Specialist | Initial implementation plan |

---

*Next Review: After Phase 1 Gate Decision (Week 12)*
