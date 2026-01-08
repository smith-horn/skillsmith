# Research: Telemetry Consent Model

> **Navigation**: [Documentation Index](../index.md) > [Research](./index.md) > Telemetry Consent
>
> **Related Documents**:
> - [Technical: Observability](../technical/observability.md)
> - [Design: Progressive Disclosure](../design/progressive-disclosure.md)

---

> **Question**: What telemetry consent model do we need for our plugin?
>
> **Date**: December 26, 2025
> **Status**: Research Complete
> **Recommendation**: Implement explicit opt-in consent with granular controls

---

## Executive Summary

**Regulatory Requirement**: GDPR requires explicit opt-in consent before collecting any telemetry data. Opt-out is not sufficient.

**Industry Best Practice**: Follow VS Code's model—respect platform-level telemetry settings, provide granular controls, and make revocation as easy as consent.

**Recommendation**: Implement a three-tier consent model with full transparency about what data is collected and why.

---

## 1. Regulatory Requirements

### 1.1 GDPR (EU)

| Requirement | Our Obligation |
|-------------|----------------|
| **Lawful basis** | Consent (Art. 6(1)(a)) — must be obtained before first collection |
| **Explicit opt-in** | User must take active action (click button); pre-checked boxes prohibited |
| **Granular consent** | Allow users to consent to specific purposes separately |
| **Easy revocation** | Revocation must be as easy as giving consent (Art. 7(3)) |
| **Documentation** | Maintain records proving consent was given |
| **Transparency** | Clear description of what data is collected and why |
| **Data minimization** | Collect only what's necessary for stated purpose |

**Enforcement Context (2025)**:
- France CNIL issued record fines for dark patterns
- Spain AEPD targets pre-consent cookie loading
- Italy Garante demands bulletproof consent logs

### 1.2 CCPA (California)

| Requirement | Our Obligation |
|-------------|----------------|
| **Right to know** | Disclose categories of data collected |
| **Right to delete** | Provide mechanism to delete user data |
| **Right to opt-out** | Allow opting out of "sale" of data (if applicable) |
| **Non-discrimination** | Cannot penalize users who opt out |

### 1.3 Other Jurisdictions

| Region | Key Requirement |
|--------|-----------------|
| Brazil (LGPD) | Similar to GDPR; explicit consent required |
| Canada (PIPEDA) | Meaningful consent with clear explanations |
| UK (UK GDPR) | Same as EU GDPR post-Brexit |

---

## 2. Industry Precedents

### 2.1 VS Code Telemetry Model

**Current State** (as of 2025):
- Default: Telemetry **enabled** (opt-out model)
- Setting: `telemetry.telemetryLevel` with options: `off`, `crash`, `error`, `all`
- Notification shown on first launch explaining telemetry

**Community Criticism**:
- Open GitHub issue requesting opt-in by default
- VSCodium fork strips all telemetry
- Some data collected before user can opt out

**What We Should Learn**:
- ❌ Don't use opt-out model (GDPR non-compliant for EU users)
- ✅ Provide granular control levels
- ✅ Respect platform-level settings

### 2.2 VS Code Extension Guidelines

Microsoft requires extensions to:

```typescript
// REQUIRED: Respect user's telemetry settings
import * as vscode from 'vscode';

if (vscode.env.isTelemetryEnabled) {
  // OK to collect
} else {
  // MUST NOT collect
}

// Listen for changes
vscode.env.onDidChangeTelemetryEnabled((enabled) => {
  // Update telemetry state
});
```

**Prohibited Behaviors**:
- ❌ Custom telemetry that ignores user consent
- ❌ Collecting PII (names, emails, IP addresses)
- ❌ Collecting more data than necessary

### 2.3 Cline Extension (Best Practice Example)

**Model**:
- Uses PostHog (open-source analytics)
- **Fully transparent** — source code shows exactly what's tracked
- Respects VS Code's global telemetry settings
- Clear documentation of all events collected

**What They Track**:
- Feature usage (which commands used)
- Error events (for debugging)
- Performance metrics (latency)

**What They Don't Track**:
- Code content
- File names
- Personal identifiers

---

## 3. Recommended Consent Model

### 3.1 Three-Tier Consent

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONSENT LEVELS                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐                                                 │
│  │  ESSENTIAL  │  No consent needed                              │
│  │  (Required) │  • Error reporting for crashes                  │
│  └─────────────┘  • Security incident logging                    │
│                                                                  │
│  ┌─────────────┐                                                 │
│  │  ANALYTICS  │  Opt-in consent required                        │
│  │  (Optional) │  • Feature usage (which skills installed)       │
│  └─────────────┘  • Recommendation quality feedback              │
│                   • Activation success rates                     │
│                                                                  │
│  ┌─────────────┐                                                 │
│  │  RESEARCH   │  Explicit opt-in for beta features              │
│  │  (Optional) │  • A/B test participation                       │
│  └─────────────┘  • Detailed interaction data                    │
│                   • Survey responses                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Consent Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    FIRST RUN                                     │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                                                           │  │
│  │  🔒 Privacy Settings                                      │  │
│  │                                                           │  │
│  │  Help us improve Skill Recommender by sharing            │  │
│  │  anonymous usage data.                                    │  │
│  │                                                           │  │
│  │  What we collect:                                         │  │
│  │  • Which skills you install (not your code)               │  │
│  │  • Whether recommendations were useful                    │  │
│  │  • Error reports when things break                        │  │
│  │                                                           │  │
│  │  What we NEVER collect:                                   │  │
│  │  • Your code or file contents                             │  │
│  │  • Personal information                                   │  │
│  │  • Anything that identifies you                           │  │
│  │                                                           │  │
│  │  📖 View full privacy policy                              │  │
│  │  📊 See exactly what we track (source code)               │  │
│  │                                                           │  │
│  │  ┌─────────────────┐  ┌─────────────────┐                │  │
│  │  │  Enable         │  │  No thanks      │                │  │
│  │  │  Analytics      │  │                 │                │  │
│  │  └─────────────────┘  └─────────────────┘                │  │
│  │                                                           │  │
│  │  You can change this anytime in Settings                  │  │
│  │                                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Settings UI

```
┌─────────────────────────────────────────────────────────────────┐
│  Settings > Privacy & Telemetry                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  📊 Usage Analytics                                              │
│  ┌─────┐                                                         │
│  │ OFF │  Share anonymous usage data to improve recommendations  │
│  └─────┘                                                         │
│                                                                  │
│  🧪 Research Participation                                       │
│  ┌─────┐                                                         │
│  │ OFF │  Join experiments to test new features                  │
│  └─────┘                                                         │
│                                                                  │
│  ────────────────────────────────────────────────────────────   │
│                                                                  │
│  📋 View collected data                                          │
│  🗑️ Delete my data                                              │
│  📖 Privacy policy                                               │
│  💻 View telemetry source code                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Data Collection Specification

### 4.1 What We Collect (Analytics Tier)

| Event | Data | Purpose | Retention |
|-------|------|---------|-----------|
| `skill_impression` | skill_id, timestamp | Measure reach | 90 days |
| `skill_installed` | skill_id, source, timestamp | Track adoption | 90 days |
| `skill_activated` | skill_id, success (bool), timestamp | Measure reliability | 90 days |
| `recommendation_feedback` | skill_id, useful (bool), timestamp | Improve algorithm | 90 days |
| `error_occurred` | error_type, stack_trace (sanitized), timestamp | Fix bugs | 30 days |

### 4.2 What We NEVER Collect

| Data Type | Reason |
|-----------|--------|
| Code content | Privacy violation |
| File names/paths | Could reveal project info |
| IP addresses | PII |
| User names/emails | PII |
| Repository names | Could identify user |
| Conversation content | Privacy violation |

### 4.3 Anonymization Strategy

```typescript
interface TelemetryEvent {
  // Anonymous identifier (hashed, rotates monthly)
  user_id: string;

  // Event data
  event: string;
  properties: Record<string, unknown>;

  // Metadata
  timestamp: string;
  plugin_version: string;
  platform: 'vscode' | 'claude-code' | 'jetbrains';
}

function anonymize(userId: string): string {
  // Hash with rotating monthly salt
  const salt = getMonthlyRotatingSalt();
  return sha256(userId + salt).substring(0, 16);
}

function sanitizeStackTrace(trace: string): string {
  // Remove file paths, keep only function names and line numbers
  return trace
    .replace(/\/[^\s]+\//g, '[path]/')  // Remove paths
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/g, '[email]');  // Remove emails
}
```

---

## 5. Implementation

### 5.1 Consent Manager

```typescript
import * as vscode from 'vscode';

export enum ConsentLevel {
  NONE = 'none',
  ESSENTIAL = 'essential',
  ANALYTICS = 'analytics',
  RESEARCH = 'research'
}

export class ConsentManager {
  private static readonly STORAGE_KEY = 'skill-recommender.consent';
  private static readonly CONSENT_VERSION = 1;

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Check if user has made a consent decision.
   */
  hasConsented(): boolean {
    const consent = this.getConsent();
    return consent !== null;
  }

  /**
   * Get current consent level.
   */
  getConsentLevel(): ConsentLevel {
    // First, respect VS Code's global setting
    if (!vscode.env.isTelemetryEnabled) {
      return ConsentLevel.NONE;
    }

    const consent = this.getConsent();
    return consent?.level ?? ConsentLevel.NONE;
  }

  /**
   * Set consent level (with timestamp for audit).
   */
  async setConsentLevel(level: ConsentLevel): Promise<void> {
    const consent = {
      level,
      version: ConsentManager.CONSENT_VERSION,
      timestamp: new Date().toISOString(),
      platformTelemetryEnabled: vscode.env.isTelemetryEnabled
    };

    await this.context.globalState.update(
      ConsentManager.STORAGE_KEY,
      consent
    );

    // Log consent change for audit (essential tier, no consent needed)
    console.log(`Consent updated: ${level} at ${consent.timestamp}`);
  }

  /**
   * Show consent prompt if needed.
   */
  async promptForConsent(): Promise<ConsentLevel> {
    if (this.hasConsented()) {
      return this.getConsentLevel();
    }

    const result = await vscode.window.showInformationMessage(
      'Help improve Skill Recommender by sharing anonymous usage data?',
      { modal: true },
      'Enable Analytics',
      'View Details',
      'No Thanks'
    );

    switch (result) {
      case 'Enable Analytics':
        await this.setConsentLevel(ConsentLevel.ANALYTICS);
        return ConsentLevel.ANALYTICS;

      case 'View Details':
        // Open privacy documentation
        vscode.env.openExternal(
          vscode.Uri.parse('https://github.com/you/plugin/blob/main/PRIVACY.md')
        );
        // Re-prompt after viewing
        return this.promptForConsent();

      default:
        await this.setConsentLevel(ConsentLevel.NONE);
        return ConsentLevel.NONE;
    }
  }

  /**
   * Allow user to delete their data.
   */
  async requestDataDeletion(): Promise<void> {
    // Call backend API to delete all data for this user
    const userId = this.getAnonymousUserId();
    await fetch('https://api.your-service.com/delete-data', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId })
    });

    vscode.window.showInformationMessage('Your data has been deleted.');
  }

  private getConsent(): ConsentRecord | null {
    return this.context.globalState.get(ConsentManager.STORAGE_KEY) ?? null;
  }

  private getAnonymousUserId(): string {
    // Implementation of anonymize() from above
  }
}

interface ConsentRecord {
  level: ConsentLevel;
  version: number;
  timestamp: string;
  platformTelemetryEnabled: boolean;
}
```

### 5.2 Telemetry Client

```typescript
import { ConsentManager, ConsentLevel } from './consent';

export class TelemetryClient {
  constructor(
    private consent: ConsentManager,
    private endpoint: string
  ) {}

  /**
   * Track an event (respects consent).
   */
  async track(event: string, properties: Record<string, unknown>): Promise<void> {
    const level = this.consent.getConsentLevel();

    // Essential events always allowed (errors only)
    if (level === ConsentLevel.NONE && !this.isEssentialEvent(event)) {
      return;  // Silently drop non-essential events
    }

    // Analytics events require analytics consent
    if (this.isAnalyticsEvent(event) && level < ConsentLevel.ANALYTICS) {
      return;
    }

    // Research events require research consent
    if (this.isResearchEvent(event) && level < ConsentLevel.RESEARCH) {
      return;
    }

    // Send event
    await this.send({
      event,
      properties: this.sanitize(properties),
      user_id: this.consent.getAnonymousUserId(),
      timestamp: new Date().toISOString()
    });
  }

  private isEssentialEvent(event: string): boolean {
    return event.startsWith('error_') || event.startsWith('crash_');
  }

  private isAnalyticsEvent(event: string): boolean {
    return ['skill_impression', 'skill_installed', 'skill_activated',
            'recommendation_feedback'].includes(event);
  }

  private isResearchEvent(event: string): boolean {
    return event.startsWith('experiment_') || event.startsWith('survey_');
  }

  private sanitize(properties: Record<string, unknown>): Record<string, unknown> {
    // Remove any potential PII
    const sanitized = { ...properties };
    delete sanitized.email;
    delete sanitized.name;
    delete sanitized.ip;
    delete sanitized.path;
    delete sanitized.code;
    return sanitized;
  }

  private async send(event: TelemetryEvent): Promise<void> {
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      });
    } catch {
      // Fail silently — telemetry should never break the product
    }
  }
}
```

---

## 6. Documentation Requirements

### 6.1 Privacy Policy

Must include:
- What data is collected
- Why it's collected
- How long it's retained
- Who has access
- How to opt out
- How to request deletion
- Contact information

### 6.2 In-Repository Transparency

Following Cline's best practice:

```
/docs/
  └── PRIVACY.md           # Full privacy policy
  └── TELEMETRY.md         # Technical spec of all events
/src/
  └── telemetry/
      └── events.ts        # All event definitions (public)
      └── client.ts        # Telemetry client (public)
      └── consent.ts       # Consent management (public)
```

### 6.3 TELEMETRY.md Template

```markdown
# Telemetry Documentation

This document describes all telemetry events collected by Skill Recommender.

## Consent Levels

| Level | Events | Default |
|-------|--------|---------|
| Essential | `error_*`, `crash_*` | Always on |
| Analytics | `skill_*`, `recommendation_*` | Opt-in |
| Research | `experiment_*`, `survey_*` | Opt-in |

## Event Catalog

### skill_impression
**Consent Level**: Analytics
**Description**: Fired when a skill is shown in recommendations
**Properties**:
| Property | Type | Description |
|----------|------|-------------|
| skill_id | string | GitHub repo identifier |
| position | number | Position in recommendation list |

[... continue for all events ...]

## Data Retention

| Event Type | Retention |
|------------|-----------|
| Analytics | 90 days |
| Errors | 30 days |
| Research | 180 days |

## How to Opt Out

1. Open Settings (Cmd/Ctrl + ,)
2. Search for "Skill Recommender Telemetry"
3. Toggle off "Enable Analytics"

## Data Deletion

To request deletion of your data:
1. Open Command Palette (Cmd/Ctrl + Shift + P)
2. Run "Skill Recommender: Delete My Data"
```

---

## 7. Compliance Checklist

| Requirement | Implementation | Status |
|-------------|----------------|--------|
| Explicit opt-in | Consent prompt on first run | ⬜ TODO |
| Granular control | Three-tier consent levels | ⬜ TODO |
| Easy revocation | Settings toggle | ⬜ TODO |
| Transparency | TELEMETRY.md in repo | ⬜ TODO |
| Data minimization | Sanitization in client | ⬜ TODO |
| Retention limits | 30-90 day TTL | ⬜ TODO |
| Deletion mechanism | API endpoint + command | ⬜ TODO |
| Consent logging | Timestamp + version stored | ⬜ TODO |
| Respect platform settings | Check `isTelemetryEnabled` | ⬜ TODO |

---

## 8. Next Steps

| Action | Owner | Timeline |
|--------|-------|----------|
| Write PRIVACY.md | Legal/Product | Week 1 |
| Implement ConsentManager | Engineering | Week 1 |
| Implement TelemetryClient | Engineering | Week 1 |
| Write TELEMETRY.md | Engineering | Week 2 |
| Add Settings UI | Engineering | Week 2 |
| Legal review | Legal | Week 3 |
| User testing | Product | Week 3 |

---

## Sources

- [GDPR Telemetry Data Guide](https://www.activemind.legal/guides/telemetry-data/) - activeMind.legal
- [VS Code Telemetry](https://code.visualstudio.com/docs/configure/telemetry) - Microsoft
- [VS Code Extension Telemetry Guide](https://code.visualstudio.com/api/extension-guides/telemetry) - Microsoft
- [Cline Telemetry Documentation](https://docs.cline.bot/more-info/telemetry) - Cline
- [GDPR Consent Management Best Practices](https://secureprivacy.ai/blog/gdpr-consent-management) - SecurePrivacy

---

*Document generated: December 26, 2025*
