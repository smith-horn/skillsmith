# Non-Intrusive Surfacing UX Design
**Epic 1: Contextual Recommendations - Skills Find Users**
**Priority**: HIGH
**Behavioral Designer**: Phase 4 Product Strategy

## Executive Summary

Design a non-intrusive skill surfacing system that presents recommendations at the right time, in the right context, without disrupting developer flow. The system must balance discoverability with minimal cognitive load.

---

## 1. Design Principles

### Core Tenets
1. **Flow-Preserving**: Never interrupt active coding or critical operations
2. **Context-Aware**: Only surface when genuinely relevant
3. **Dismissible**: Users control when and how they engage
4. **Progressive Disclosure**: Start minimal, expand on interest
5. **Habituation-Resistant**: Vary presentation to avoid banner blindness

### Anti-Patterns to Avoid
- ❌ Modal dialogs that block workflow
- ❌ Aggressive notifications during active typing
- ❌ Repeated suggestions for dismissed skills
- ❌ Generic "helpful tips" without context
- ❌ Interruptions during error states or builds

---

## 2. Presentation Modes

### Mode 1: Inline Subtle Hint (Primary)
**When**: After completing a task that a skill could enhance
**Where**: Terminal output, after command completion
**Visual Treatment**: Muted color, single line, right-aligned

```
✓ Tests passed (12/12)

💡 Tip: 'jest-helper' skill can auto-generate test cases  [View] [Dismiss]
```

**Characteristics**:
- Single line, non-blocking
- Icon prefix (💡, ✨, 🎯) for visual separation
- Actionable buttons in same line
- Auto-dismiss after 10 seconds or next command
- Muted text color (#8b949e in dark mode)

---

### Mode 2: Contextual Sidebar (Claude Desktop)
**When**: User requests recommendations OR 3+ skills match context
**Where**: Right sidebar in Claude Desktop UI
**Visual Treatment**: Collapsible panel with skill cards

```
┌────────────────────────────────┐
│ 🎯 Recommended for You         │
├────────────────────────────────┤
│ Based on your React project:   │
│                                │
│ [✓] jest-helper                │
│     Generate test cases        │
│     [Try Now] [Learn More]     │
│                                │
│ [ ] react-component            │
│     Scaffold components        │
│     [Try Now] [Learn More]     │
│                                │
│ [ ] eslint-config              │
│     Setup linting              │
│     [Try Now] [Learn More]     │
│                                │
│ [See All 7 Recommendations]    │
└────────────────────────────────┘
```

**Characteristics**:
- Only shown when >2 recommendations available
- Collapsible to minimize screen real estate
- Checkbox for skill selection (multi-install)
- Preview without commitment
- Intelligent ordering by relevance

---

### Mode 3: Natural Language Response (Claude Chat)
**When**: User asks open-ended question related to a skill's trigger
**Where**: Inline in Claude's response
**Visual Treatment**: Natural language with embedded action

```
USER: How do I write tests for this React component?

CLAUDE: I can help you write tests! Here are a few approaches:

1. Using Jest and React Testing Library (recommended):
   [Testing code example...]

💡 I notice you're writing React tests frequently. The 'jest-helper'
   skill can automatically generate test scaffolds for your components.

   Would you like me to [Install jest-helper] for you? It works
   immediately with zero configuration.
```

**Characteristics**:
- Embedded in natural response flow
- Explains WHY the skill is relevant
- Immediate value proposition
- One-click installation
- Optional "Learn More" for skeptical users

---

### Mode 4: Quiet Notification Badge (VS Code)
**When**: 5+ recommendations available, user hasn't checked in 7 days
**Where**: Skillsmith icon in VS Code status bar
**Visual Treatment**: Small badge count, no popup

```
Status Bar: [Skillsmith ⑤]  ← Badge shows count
```

**On Click**:
```
╔════════════════════════════════════════╗
║ 5 Skills Recommended for Your Project ║
╠════════════════════════════════════════╣
║ Based on your React + TypeScript repo  ║
║                                        ║
║ 1. jest-helper        [Try] [Dismiss]  ║
║ 2. react-component    [Try] [Dismiss]  ║
║ 3. eslint-config      [Try] [Dismiss]  ║
║ 4. github-actions     [Try] [Dismiss]  ║
║ 5. prisma-schema      [Try] [Dismiss]  ║
║                                        ║
║ [Install Selected (0)] [Dismiss All]   ║
╚════════════════════════════════════════╝
```

---

## 3. Triggering Logic

### Context Detection Matrix

| Trigger Event | Example | Suggested Presentation Mode |
|--------------|---------|----------------------------|
| **File Pattern Match** | User creates `*.test.ts` | Mode 1: Inline Subtle Hint |
| **Command Pattern** | `git commit` run 3+ times | Mode 1: Inline Subtle Hint |
| **Error Pattern** | ESLint not configured error | Mode 3: Natural Language |
| **Project Analysis** | New React project detected | Mode 2: Contextual Sidebar |
| **Time-Based** | 7 days since last check | Mode 4: Quiet Badge |
| **Direct Request** | "Find me testing skills" | Mode 2: Contextual Sidebar |

### Rate Limiting
- **Per Skill**: Max 1 suggestion per skill per 5 minutes
- **Total**: Max 3 suggestions per hour (any mode)
- **Session**: Max 10 suggestions per 24-hour period
- **Dismissed Skills**: Never re-suggest within 30 days
- **Accepted Skills**: Suggest complementary skills after 1 hour

### Dismissal Memory
```typescript
interface DismissalRecord {
  skillId: string
  dismissedAt: Date
  context: string // "inline-hint" | "sidebar" | "chat"
  reason?: "not-interested" | "later" | "already-have"
  suppressUntil: Date // Auto-calculated: 30 days default
}
```

---

## 4. Interaction Flows

### Flow A: Inline Hint → Installation
```
1. User runs: npm test
2. Tests pass successfully
3. System detects: No test generation tooling
4. Display inline hint (Mode 1):
   "💡 jest-helper can auto-generate test cases [Try] [Dismiss]"
5. User clicks [Try]
6. Show expanded preview:
   ┌─────────────────────────────────────────┐
   │ jest-helper                             │
   │ Generate Jest test cases for React      │
   │                                         │
   │ ✓ Zero configuration required           │
   │ ✓ Works with your existing setup        │
   │ ✓ 87/100 quality score                  │
   │                                         │
   │ [Install & Activate] [Learn More]       │
   └─────────────────────────────────────────┘
7. User clicks [Install & Activate]
8. Skill installs in background (progress indicator)
9. Success message:
   "✓ jest-helper activated! Try: 'Generate tests for Button.tsx'"
10. First-use prompt suggestion displayed (see Epic 2)
```

### Flow B: Sidebar Discovery → Multi-Install
```
1. User opens Claude Desktop with React project
2. CodebaseAnalyzer detects: React + TypeScript + Jest
3. Sidebar shows 7 recommendations (Mode 2)
4. User checks: [✓] jest-helper, [✓] react-component, [✓] eslint-config
5. User clicks [Install Selected (3)]
6. Parallel installation with progress:
   ┌─────────────────────────────────┐
   │ Installing 3 skills...          │
   │ ✓ jest-helper (done)            │
   │ ⟳ react-component (installing)  │
   │ ○ eslint-config (queued)        │
   └─────────────────────────────────┘
7. All complete, show welcome message (see Epic 2)
```

### Flow C: Chat Suggestion → Learn More → Install
```
1. User asks: "How do I improve my git commits?"
2. Claude responds with advice + skill suggestion (Mode 3)
3. User clicks [Learn More]
4. Skill detail modal opens:
   ╔═══════════════════════════════════════════╗
   ║ commit skill (Verified)                   ║
   ╠═══════════════════════════════════════════╣
   ║ Generate semantic commit messages         ║
   ║ following Conventional Commits standard   ║
   ║                                           ║
   ║ Trigger Phrases:                          ║
   ║ • "commit changes"                        ║
   ║ • "create commit"                         ║
   ║ • "write commit message"                  ║
   ║                                           ║
   ║ Example Output:                           ║
   ║ feat(auth): add OAuth2 login flow         ║
   ║                                           ║
   ║ Adds Google OAuth2 authentication...      ║
   ║                                           ║
   ║ Quality Score: 95/100                     ║
   ║ Trust: Verified by Anthropic              ║
   ║                                           ║
   ║ [Install commit skill] [Close]            ║
   ╚═══════════════════════════════════════════╝
5. User clicks [Install commit skill]
6. Immediate activation (see Epic 2 for onboarding)
```

---

## 5. UX Mockups

### Mockup 1: CLI Inline Hint (Mode 1)
```
Terminal Output:
──────────────────────────────────────────────────────────────
$ npm run build

> skillsmith@1.0.0 build
> tsc && vite build

✓ Built in 2.3s

                         💡 Tip: 'github-actions' skill can
                            automate your builds on every push
                                              [Try] [Not Now]
──────────────────────────────────────────────────────────────
```

**Visual Specs**:
- Font: Monospace, 90% of terminal size
- Color: Muted (#8b949e), not full white/black
- Alignment: Right-aligned to avoid left-side text collision
- Timing: Appears 500ms after command completion
- Persistence: 10 seconds or until next command

---

### Mockup 2: Sidebar Recommendations (Mode 2)
```
Claude Desktop - Right Sidebar:
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🎯 Recommended for You       ┃
┃ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━┃
┃ Based on React + TypeScript  ┃
┃                              ┃
┃ ┌──────────────────────────┐ ┃
┃ │ [✓] jest-helper          │ ┃
┃ │     Generate test cases  │ ┃
┃ │     Quality: 87/100      │ ┃
┃ │     [Try] [Info]         │ ┃
┃ └──────────────────────────┘ ┃
┃                              ┃
┃ ┌──────────────────────────┐ ┃
┃ │ [ ] react-component      │ ┃
┃ │     Scaffold components  │ ┃
┃ │     Quality: 86/100      │ ┃
┃ │     [Try] [Info]         │ ┃
┃ └──────────────────────────┘ ┃
┃                              ┃
┃ ┌──────────────────────────┐ ┃
┃ │ [ ] eslint-config        │ ┃
┃ │     Setup linting        │ ┃
┃ │     Quality: 82/100      │ ┃
┃ │     [Try] [Info]         │ ┃
┃ └──────────────────────────┘ ┃
┃                              ┃
┃ [Install Selected (1)]       ┃
┃ [See All 7 Recommendations]  ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

---

### Mockup 3: Natural Language Suggestion (Mode 3)
```
Chat Interface:
┌────────────────────────────────────────────────────┐
│ USER:                                              │
│ How do I write tests for this React component?    │
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│ CLAUDE:                                            │
│                                                    │
│ I can help you write tests! Here's how:           │
│                                                    │
│ ```typescript                                      │
│ import { render, screen } from '@testing-library   │
│   /react';                                         │
│ import { Button } from './Button';                 │
│                                                    │
│ test('renders button text', () => {               │
│   render(<Button>Click me</Button>);              │
│   expect(screen.getByText('Click me')).toBe...    │
│ });                                                │
│ ```                                                │
│                                                    │
│ ┌────────────────────────────────────────────┐    │
│ │ 💡 Helpful Skill Suggestion                │    │
│ ├────────────────────────────────────────────┤    │
│ │ I notice you're writing React tests. The  │    │
│ │ 'jest-helper' skill can automatically      │    │
│ │ generate test scaffolds like this for you. │    │
│ │                                            │    │
│ │ Would you like me to install it? It works │    │
│ │ immediately with zero configuration.       │    │
│ │                                            │    │
│ │ [Yes, Install jest-helper] [Learn More]   │    │
│ │                          [Maybe Later]     │    │
│ └────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────┘
```

---

## 6. Accessibility Requirements

### Keyboard Navigation
- **Tab Order**: All interactive elements must be keyboard-accessible
- **Shortcut Keys**:
  - `Escape`: Dismiss current suggestion
  - `Enter`: Activate primary action (Install/Try)
  - `?`: Show keyboard shortcuts help
  - `Shift+S`: Toggle sidebar recommendations

### Screen Reader Support
- **ARIA Labels**: All buttons and interactive elements
- **Role Announcements**:
  - "Skill suggestion available" when hint appears
  - "5 skills recommended" for badge notifications
  - "Installation in progress" for loading states
- **Status Updates**: Announce completion/errors

### Visual Accessibility
- **Contrast Ratios**:
  - Normal text: 4.5:1 minimum (WCAG AA)
  - Large text (18pt+): 3:1 minimum
  - Interactive elements: 3:1 minimum against background
- **Color Independence**: Never use color alone to convey information
- **Focus Indicators**: Clear 2px outline on focused elements
- **Text Scaling**: Support up to 200% zoom without breaking layout

### Motion Sensitivity
- **Reduce Motion**: Respect `prefers-reduced-motion` media query
- **No Auto-Animations**: Avoid distracting animations
- **User Control**: All animations can be disabled in settings

---

## 7. User Testing Protocol

### Phase 1: Concept Testing (Week 1)
**Participants**: 15 developers (5 junior, 5 mid, 5 senior)
**Method**: Figma prototype walkthroughs
**Goals**:
- Validate presentation modes feel non-intrusive
- Test dismissal behavior UX
- Measure comprehension of skill value propositions

**Key Questions**:
1. "When did you first notice the skill suggestion?"
2. "Did it feel like an interruption or helpful?"
3. "What would make you click [Try] vs [Dismiss]?"
4. "How many suggestions per day feels acceptable?"

### Phase 2: A/B Testing (Weeks 2-4)
**Variants**:
- **A**: Inline hints only (Mode 1)
- **B**: Inline hints + Sidebar (Modes 1 & 2)
- **C**: All modes enabled (1, 2, 3, 4)

**Metrics**:
- Skill installation rate per suggestion shown
- Dismissal rate by presentation mode
- Time to first skill activation
- User satisfaction score (CSAT)
- Interruption perception (1-5 scale)

### Phase 3: Usability Testing (Weeks 5-6)
**Participants**: 20 developers in realistic workflows
**Method**: Live environment with real projects
**Tasks**:
1. Set up new React project (expect sidebar recommendations)
2. Write a failing test (expect inline test skill hint)
3. Commit code changes (expect git skill hint)
4. Dismiss 2 skills and verify they don't reappear

**Success Criteria**:
- ≥80% can install a skill from suggestion in <30 seconds
- ≥70% find suggestions helpful (4-5 on 5-point scale)
- ≤15% feel interrupted during flow state
- 100% can successfully dismiss unwanted suggestions

### Phase 4: Accessibility Audit (Week 7)
**Participants**: 5 developers with disabilities
**Focus Areas**:
- Screen reader compatibility (JAWS, NVDA, VoiceOver)
- Keyboard-only navigation
- High contrast mode rendering
- Voice control (Dragon NaturallySpeaking)

**Pass Criteria**: WCAG 2.1 Level AA compliance verified

---

## 8. Technical Integration Points

### Integration with Existing Skillsmith Components

#### CodebaseAnalyzer
```typescript
// Trigger sidebar recommendations on project open
const context = await codebaseAnalyzer.analyze(projectPath);
const recommendations = await skillMatcher.findSimilarSkills(
  codebaseAnalyzer.getSummary(context),
  availableSkills,
  10
);

if (recommendations.length >= 3) {
  showSidebarRecommendations(recommendations);
}
```

#### SkillMatcher
```typescript
// Filter out recently dismissed skills
const dismissalRecords = await getDismissalHistory(userId);
const filteredSkills = availableSkills.filter(
  skill => !isDismissedRecently(skill.id, dismissalRecords)
);

const matches = await skillMatcher.findSimilarSkills(
  query,
  filteredSkills,
  limit
);
```

#### MCP Tool: skill_suggest (New)
```typescript
// Push-based suggestion from MCP server
interface SkillSuggestion {
  skillId: string;
  reason: string;
  mode: "inline" | "sidebar" | "chat" | "badge";
  priority: "low" | "medium" | "high";
  context: {
    trigger: string;
    timestamp: Date;
  };
}

// Rate-limited to 1 per 5 minutes
export async function sendSkillSuggestion(
  suggestion: SkillSuggestion
): Promise<void>;
```

---

## 9. Privacy & User Control

### Settings Panel
```
Skill Suggestions Settings:
┌─────────────────────────────────────────┐
│ Enable Suggestions:      [✓] On        │
│                                         │
│ Presentation Modes:                     │
│ [✓] Inline hints after commands         │
│ [✓] Sidebar recommendations             │
│ [✓] Chat suggestions                    │
│ [ ] Badge notifications                 │
│                                         │
│ Frequency:                              │
│ Max per hour:   [3  ▼]                  │
│ Max per day:    [10 ▼]                  │
│                                         │
│ Auto-dismiss after:  [10 seconds ▼]     │
│                                         │
│ [Reset Dismissed Skills]                │
│ [Export Suggestion History]             │
└─────────────────────────────────────────┘
```

### Data Collection (Local Only)
- All dismissal records stored locally (SQLite)
- No telemetry sent to external servers
- User can export/delete all history
- Opt-in for anonymous usage metrics

---

## 10. Success Metrics

### Primary KPIs
1. **Conversion Rate**: % of suggestions → installations
   - Target: ≥20% within first month
2. **Dismissal Rate**: % of suggestions dismissed
   - Target: ≤40% (balance discoverability vs noise)
3. **Re-Dismissal Rate**: % of skills dismissed twice+
   - Target: ≤5% (indicates poor targeting)

### Secondary KPIs
4. **Time to First Activation**: From suggestion shown → skill activated
   - Target: ≤60 seconds median
5. **User Satisfaction**: "Suggestions feel helpful, not annoying"
   - Target: ≥4.0/5.0 average rating
6. **Flow Interruption**: "I felt interrupted during work"
   - Target: ≤2.0/5.0 average (lower is better)

### Monitoring Dashboard
```
┌──────────────────────────────────────────────┐
│ Skill Surfacing Analytics (Last 7 Days)     │
├──────────────────────────────────────────────┤
│ Total Suggestions Shown:      1,247         │
│ Installed from Suggestions:     312  (25%)  │
│ Dismissed:                      498  (40%)  │
│ Ignored (timeout):              437  (35%)  │
│                                              │
│ By Mode:                                     │
│ • Inline Hints:       892 shown, 18% conv.  │
│ • Sidebar:            245 shown, 38% conv.  │
│ • Chat:               110 shown, 42% conv.  │
│                                              │
│ Top Converting Skills:                       │
│ 1. commit (45% conversion)                   │
│ 2. jest-helper (38% conversion)              │
│ 3. react-component (29% conversion)          │
│                                              │
│ Avg. Time to Activation: 42 seconds          │
│ User Satisfaction: 4.2/5.0 ⭐                │
└──────────────────────────────────────────────┘
```

---

## 11. Future Enhancements

### Post-Launch Iterations
1. **Contextual Animations**: Subtle glow effect on highly relevant skills
2. **Voice Suggestions**: "I noticed you're writing tests. Should I install jest-helper?"
3. **Team Recommendations**: "3 teammates use jest-helper. Try it?"
4. **Skill Combos**: "Users who installed commit also love review-pr"
5. **Seasonal Promotions**: Highlight new skills for 1 week

### Machine Learning Enhancements
- Personalized presentation mode selection based on user behavior
- Predictive triggering (suggest before user needs it)
- Dismissal reason inference (improve targeting)

---

## Appendix A: Terminology

| Term | Definition |
|------|------------|
| **Flow State** | Deep concentration during coding; must not be interrupted |
| **Banner Blindness** | Psychological phenomenon where users ignore repeated UI elements |
| **Progressive Disclosure** | Showing information gradually to reduce cognitive load |
| **Habituation** | Decreased response to repeated stimuli |
| **Semantic Zoom** | Expanding/collapsing detail levels on demand |

---

## Appendix B: Design System Colors

```css
/* Suggestion UI Colors (Dark Mode) */
--suggestion-text: #8b949e;        /* Muted gray */
--suggestion-icon: #58a6ff;        /* Blue accent */
--suggestion-border: #30363d;      /* Subtle border */
--suggestion-hover: #161b22;       /* Hover background */
--suggestion-focus: #388bfd;       /* Focus outline */

/* Suggestion UI Colors (Light Mode) */
--suggestion-text: #57606a;
--suggestion-icon: #0969da;
--suggestion-border: #d0d7de;
--suggestion-hover: #f6f8fa;
--suggestion-focus: #0969da;
```

---

**Document Version**: 1.0
**Last Updated**: December 31, 2025
**Author**: Behavioral Designer, Phase 4 Team
**Review Status**: Ready for Technical Review
