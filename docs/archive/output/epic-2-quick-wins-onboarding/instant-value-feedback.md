# Instant Value Feedback Design
**Epic 2: Quick Wins Onboarding - First Value in 60 Seconds**
**Priority**: HIGH
**Behavioral Designer**: Phase 4 Product Strategy

## Executive Summary

Design activation confirmation messages and first-use detection systems that ensure users see immediate value after skill activation. Every skill interaction should provide clear feedback on what happened and encourage continued use.

---

## 1. Feedback Design Principles

### Core Tenets
1. **Immediate Confirmation**: Users know within 2 seconds that skill activated
2. **Value Attribution**: Clearly show WHAT the skill did (not just "success")
3. **Next Step Guidance**: Suggest what to do next
4. **Progressive Complexity**: Start simple, reveal advanced features later
5. **Celebratory Tone**: Make users feel accomplished, not overwhelmed

### Feedback Timing
```
User Action → Skill Processing → Feedback Display → Next Prompt
    0s            1-10s              +2s               +5s
```

---

## 2. Activation Confirmation Messages

### Format Template
```
✓ [Skill Name] Activated!

[What it did in plain English]

💡 [Suggested next action or example]

[Optional: Learn more link]
```

### Skill-Specific Examples

#### Example 1: `jest-helper` Activation
```
✓ jest-helper Activated!

Generated comprehensive test suite for Button.tsx:
• 5 test cases covering all props and events
• 100% component coverage
• Ready to run with `npm test`

💡 Try next: "Generate tests for LoginForm.tsx"

File created: src/components/Button.test.tsx (127 lines)
```

**Why This Works**:
- **Specific Output**: "5 test cases" (not just "tests created")
- **Actionable Next Step**: Exact filename to try next
- **Tangible Result**: Shows file path and size

---

#### Example 2: `commit` Activation
```
✓ Commit Message Generated!

Created semantic commit following Conventional Commits:

┌─────────────────────────────────────────────┐
│ feat(auth): add OAuth2 login flow           │
│                                             │
│ Implements Google OAuth2 authentication    │
│ with secure token storage and refresh      │
│ logic. Adds tests for auth middleware.     │
└─────────────────────────────────────────────┘

💡 Run `git commit` to use this message, or ask me to
   "Commit with this message" for instant execution.
```

**Why This Works**:
- **Preview Box**: Shows exact commit message user will get
- **Next Action Choice**: Manual git command OR automated
- **Professional Polish**: Highlights quality improvement

---

#### Example 3: `react-component` Activation
```
✓ Component Created!

Generated LoginForm.tsx with:
• TypeScript interface for props
• Form validation with React Hook Form
• Accessible ARIA labels
• Styled with Tailwind CSS (detected in your project)

Files created:
- src/components/LoginForm.tsx (89 lines)
- src/components/LoginForm.test.tsx (45 lines)

💡 Import it: import { LoginForm } from './components/LoginForm'

[View Component] [Generate Another]
```

**Why This Works**:
- **Context-Aware**: Mentions detected Tailwind CSS
- **Bonus Value**: Also generated test file (unexpected delight)
- **Quick Actions**: Buttons for immediate next steps

---

## 3. First-Use Detection System

### Detection Logic
```typescript
interface FirstUseDetector {
  // Track skill usage per user
  isFirstUse(userId: string, skillId: string): Promise<boolean>;

  // Mark skill as used
  markUsed(userId: string, skillId: string): Promise<void>;

  // Get usage count
  getUsageCount(userId: string, skillId: string): Promise<number>;

  // Check if user is in "onboarding window" (first 24 hours)
  isInOnboardingWindow(userId: string, skillId: string): Promise<boolean>;
}
```

### Implementation
```typescript
// SQLite schema
CREATE TABLE skill_usage (
  user_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  first_used_at DATETIME NOT NULL,
  last_used_at DATETIME NOT NULL,
  usage_count INTEGER DEFAULT 1,
  PRIMARY KEY (user_id, skill_id)
);

CREATE INDEX idx_first_use_window ON skill_usage(
  user_id,
  skill_id,
  first_used_at
) WHERE julianday('now') - julianday(first_used_at) < 1.0;
```

### First-Use Triggers

| Trigger Event | Special Feedback | Duration |
|--------------|------------------|----------|
| **Absolute First Use** | Extended confirmation + tutorial hint | Once per skill |
| **First Successful Output** | Celebration message + share prompt | Once per skill |
| **Onboarding Window (24h)** | Extra help hints in responses | 24 hours post-install |
| **Second Use** | "You're getting the hang of it!" | Once per skill |
| **10th Use** | "Power user unlocked!" + advanced tips | Once per skill |

---

## 4. Example Prompt Suggestions

### Context-Aware Prompt Generation

After skill activation, suggest 3 prompts tailored to user's project:

```typescript
interface PromptSuggestion {
  skillId: string;
  prompt: string;
  category: 'beginner' | 'intermediate' | 'advanced';
  estimatedTime: number; // seconds
  expectedOutput: string;
}

async function generatePromptSuggestions(
  skillId: string,
  projectContext: CodebaseContext
): Promise<PromptSuggestion[]> {
  // Example for jest-helper in React project
  return [
    {
      skillId: 'jest-helper',
      prompt: 'Generate tests for Button.tsx',
      category: 'beginner',
      estimatedTime: 15,
      expectedOutput: '1 test file with 3-5 test cases'
    },
    {
      skillId: 'jest-helper',
      prompt: 'Generate integration tests for LoginFlow',
      category: 'intermediate',
      estimatedTime: 30,
      expectedOutput: 'Multi-step test suite with mocked API calls'
    },
    {
      skillId: 'jest-helper',
      prompt: 'Create snapshot tests for all components in /dashboard',
      category: 'advanced',
      estimatedTime: 45,
      expectedOutput: '10+ snapshot tests with update scripts'
    }
  ];
}
```

### Prompt Suggestion Display

#### Display Mode 1: Inline After Activation
```
✓ jest-helper Activated!

Try these prompts to explore what it can do:

1️⃣ Beginner (15s)
   "Generate tests for Button.tsx"
   → Creates basic component tests

2️⃣ Intermediate (30s)
   "Generate integration tests for LoginFlow"
   → Multi-step test suite with API mocks

3️⃣ Advanced (45s)
   "Create snapshot tests for all /dashboard components"
   → Bulk test generation across folder

[Copy Prompt 1] [Copy Prompt 2] [Copy Prompt 3]
```

**Interaction**:
- User clicks [Copy Prompt 1]
- Prompt auto-pastes into Claude's input field
- User presses Enter
- Skill executes
- Show success feedback (see Section 2)

---

#### Display Mode 2: Progressive Disclosure
```
✓ jest-helper Activated!

Generated tests for Button.tsx (5 test cases).

💡 Ready to try more? [Show Me What Else]

[If user clicks "Show Me What Else":]

┌─────────────────────────────────────────────┐
│ jest-helper Can Also:                       │
├─────────────────────────────────────────────┤
│ • Generate integration tests               │
│   "Test the entire checkout flow"          │
│                                             │
│ • Create snapshot tests                     │
│   "Snapshot all components in /ui"         │
│                                             │
│ • Update existing tests                     │
│   "Add error case tests to UserList"       │
│                                             │
│ [View Full Capabilities]                    │
└─────────────────────────────────────────────┘
```

---

## 5. Value Attribution Display

### Attribution Format
Show users exactly what the skill contributed:

```
Generated by [Skill Name]:
[Output summary]

[Detailed breakdown]
```

### Real Examples

#### Example 1: Code Generation
```
──────────────────────────────────────────
Generated by react-component skill:

✓ LoginForm.tsx (89 lines)
  • TypeScript component with full typing
  • Form validation (email, password strength)
  • Loading states and error handling
  • Accessibility attributes (ARIA)

✓ LoginForm.test.tsx (45 lines)
  • 8 test cases (100% coverage)

💾 Total: 134 lines of production-ready code
⏱️  Would take ~30 minutes to write manually
──────────────────────────────────────────
```

**Value Calculation**:
- Lines of code: Countable metric
- Time saved: Estimated based on LOC × 2 (research) + typing time
- Quality indicators: "production-ready", "100% coverage"

---

#### Example 2: Content Generation
```
──────────────────────────────────────────
Generated by commit skill:

Commit Message:
┌───────────────────────────────────────┐
│ feat(auth): implement password reset  │
│                                       │
│ Add email-based password reset flow  │
│ with secure token generation. Tokens │
│ expire after 1 hour. Includes email  │
│ templates and user notification.     │
│                                       │
│ BREAKING CHANGE: Updates User model  │
│ schema to include resetToken field.  │
└───────────────────────────────────────┘

✓ Follows Conventional Commits standard
✓ Includes BREAKING CHANGE notice
✓ Clearly describes scope and impact

[Commit Now] [Edit Message] [Copy]
──────────────────────────────────────────
```

---

#### Example 3: Configuration Generation
```
──────────────────────────────────────────
Generated by docker-compose skill:

✓ docker-compose.yml (67 lines)
  Services configured:
  • Node.js app (multi-stage build)
  • PostgreSQL 15 (with volume persistence)
  • Redis 7 (for caching)
  • Nginx (reverse proxy)

✓ Dockerfile (43 lines)
  • Production-optimized
  • Layer caching for fast rebuilds
  • Security: non-root user

✓ .dockerignore (12 lines)

💡 Run `docker-compose up` to start all services

⏱️  Manual setup time saved: ~2 hours
──────────────────────────────────────────
```

---

## 6. Feedback Variations by Skill Type

### Type 1: Code Generators
**Characteristics**: Create files, write code
**Feedback Focus**: Files created, LOC, features included

```
✓ [Files Created]

[List of files with line counts]

Features:
• [Feature 1]
• [Feature 2]

💡 [Next suggested action]
```

---

### Type 2: Analyzers/Reviewers
**Characteristics**: Inspect code, provide insights
**Feedback Focus**: Issues found, recommendations made

```
✓ Analysis Complete!

Reviewed: [File/PR/Codebase]

Findings:
• [Number] issues found
• [Number] recommendations
• [Number] security concerns

[View Detailed Report]

💡 [Suggested fix action]
```

**Example**:
```
✓ Code Review Complete!

Reviewed: PR #42 (12 files, 347 additions, 89 deletions)

Findings:
• 3 potential bugs (memory leaks)
• 5 style improvements
• 0 security concerns ✓
• Test coverage: 78% → needs improvement

[View Full Report] [Start Fixing Issues]

💡 Try: "Fix the memory leak in UserCache.ts"
```

---

### Type 3: Automators
**Characteristics**: Execute actions, modify state
**Feedback Focus**: Action taken, state changed

```
✓ Action Completed!

[What was done]

Result:
• [State before]
• [State after]

💡 [Next action in workflow]
```

**Example** (git commit skill):
```
✓ Committed!

Commit: feat(auth): add OAuth2 login
SHA: a3f7c2b

Changes committed:
• 4 files changed
• 127 additions, 23 deletions

💡 Next: "Push to origin" or "Create a pull request"
```

---

## 7. Onboarding Window Special Behaviors

### Enhanced Help (First 24 Hours)

During the onboarding window, Claude provides extra context:

**Normal Mode** (after 24 hours):
```
USER: Generate tests for Button.tsx

CLAUDE: [Generates tests without explanation]
```

**Onboarding Mode** (first 24 hours):
```
USER: Generate tests for Button.tsx

CLAUDE: Great choice! The jest-helper skill will:
1. Analyze Button.tsx to understand props and events
2. Generate test cases for all code paths
3. Include accessibility tests

[Generates tests]

✓ Test file created! Notice how it covers:
• Prop validation (3 tests)
• Event handlers (2 tests)
• Rendering edge cases (2 tests)

This ensures your component works correctly in all scenarios.

💡 Want to add more tests? Try:
   "Add edge case tests for invalid props"
```

**Differences**:
- Explains WHAT will happen before execution
- Annotates output to teach
- Proactive suggestions for follow-up

---

### Tooltip Hints

In onboarding window, show tooltip hints on first interaction:

```
[User hovers over skill name in response]

┌─────────────────────────────────────┐
│ 💡 Skill Tip                        │
├─────────────────────────────────────┤
│ jest-helper generated this output.  │
│                                     │
│ You can:                            │
│ • Ask it to modify tests            │
│ • Generate tests for other files   │
│ • Update tests when code changes    │
│                                     │
│ [Learn More] [Dismiss]              │
└─────────────────────────────────────┘
```

---

## 8. Error Feedback (Failure Cases)

### When Skill Activation Fails

```
⚠️ jest-helper encountered an issue

Problem: Couldn't find Button.tsx in your project

Suggestions:
• Check file path: "Generate tests for src/components/Button.tsx"
• List files: "Show me all component files"
• Try another: "Generate tests for LoginForm.tsx"

[Show All Components] [Retry]
```

**Design Principles**:
- Don't blame user ("You entered wrong path" ❌)
- Explain WHAT went wrong
- Offer 2-3 concrete next steps
- Provide recovery actions

---

### When Output is Partial

```
✓ Partial Success

Generated tests for Button.tsx, but:

⚠️ Skipped 2 complex event handlers (requires manual testing)

Created:
• 5 basic test cases ✓
• 2 prop validation tests ✓

Still needed:
• onAsyncClick handler test (complex promise chain)
• useEffect cleanup test

💡 I can help write those manually. Try:
   "Help me test the onAsyncClick handler"

[View Generated Tests] [Continue Manually]
```

---

## 9. Gamification & Milestones

### Milestone Triggers

| Milestone | Trigger | Feedback Message |
|-----------|---------|------------------|
| **First Output** | First successful skill use | "🎉 First [Skill] creation! You're off to a great start." |
| **Speed Demon** | Skill use within 30s of install | "⚡ That was fast! You saved ~15 minutes already." |
| **Power User** | 10 uses of same skill | "🔥 10 [Skill] outputs created! You're a pro." |
| **Polyglot** | Used 5 different skills | "🌟 Skill collector! You've mastered 5 skills." |
| **Time Saver** | Cumulative 2 hours saved | "⏱️  You've saved 2 hours with Skillsmith!" |

### Milestone Display Format
```
╔═══════════════════════════════════════╗
║  🎉 Milestone Achieved!               ║
╠═══════════════════════════════════════╣
║  Power User: 10 test files generated  ║
║                                       ║
║  You've saved an estimated 5 hours    ║
║  of manual testing work!              ║
║                                       ║
║  [Share Achievement] [Dismiss]        ║
╚═══════════════════════════════════════╝
```

**Frequency Control**: Max 1 milestone notification per day

---

## 10. Integration Points

### Integration with SkillRepository
```typescript
class ValueFeedbackService {
  constructor(
    private skillRepo: SkillRepository,
    private usageTracker: SkillUsageTracker,
    private promptGenerator: PromptSuggestionGenerator
  ) {}

  async generateActivationFeedback(
    skillId: string,
    output: SkillOutput,
    context: ProjectContext
  ): Promise<FeedbackMessage> {

    const skill = await this.skillRepo.findById(skillId);
    const isFirstUse = await this.usageTracker.isFirstUse(userId, skillId);

    // Generate value metrics
    const metrics = this.calculateValueMetrics(output);

    // Generate next prompts
    const suggestions = await this.promptGenerator.generate(
      skillId,
      context,
      isFirstUse ? 'beginner' : 'intermediate'
    );

    // Build feedback message
    return {
      title: `✓ ${skill.name} Activated!`,
      summary: this.summarizeOutput(output),
      metrics: metrics,
      suggestions: suggestions,
      celebrationLevel: isFirstUse ? 'high' : 'normal'
    };
  }

  private calculateValueMetrics(output: SkillOutput): ValueMetrics {
    return {
      filesCreated: output.files?.length || 0,
      linesOfCode: output.files?.reduce((sum, f) => sum + f.lineCount, 0) || 0,
      estimatedTimeSaved: this.estimateTimeSaved(output),
      qualityIndicators: this.extractQualityIndicators(output)
    };
  }

  private estimateTimeSaved(output: SkillOutput): number {
    // Heuristic: 2 minutes per 10 LOC + research time
    const loc = output.files?.reduce((sum, f) => sum + f.lineCount, 0) || 0;
    const writingTime = (loc / 10) * 2; // minutes
    const researchTime = output.files?.length * 5 || 0; // 5 min per file
    return writingTime + researchTime;
  }
}
```

---

### Integration with FirstUseDetector
```typescript
class FirstUseDetector {
  async recordUsage(userId: string, skillId: string): Promise<UsageRecord> {
    const existing = await this.db.get(
      'SELECT * FROM skill_usage WHERE user_id = ? AND skill_id = ?',
      [userId, skillId]
    );

    if (!existing) {
      // First use!
      await this.db.run(
        'INSERT INTO skill_usage (user_id, skill_id, first_used_at, last_used_at, usage_count) VALUES (?, ?, ?, ?, ?)',
        [userId, skillId, new Date(), new Date(), 1]
      );

      return { isFirstUse: true, usageCount: 1 };
    } else {
      // Subsequent use
      const newCount = existing.usage_count + 1;
      await this.db.run(
        'UPDATE skill_usage SET last_used_at = ?, usage_count = ? WHERE user_id = ? AND skill_id = ?',
        [new Date(), newCount, userId, skillId]
      );

      return { isFirstUse: false, usageCount: newCount };
    }
  }

  async checkMilestone(userId: string, skillId: string, count: number): Promise<Milestone | null> {
    const milestones = [
      { count: 1, type: 'first_use' },
      { count: 2, type: 'second_use' },
      { count: 10, type: 'power_user' }
    ];

    const milestone = milestones.find(m => m.count === count);
    return milestone || null;
  }
}
```

---

## 11. Success Metrics

### Primary KPIs

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Activation Success Rate** | ≥95% | % of skill uses that produce output |
| **Time to First Value** | ≤60 seconds | Install → first successful output |
| **Onboarding Completion** | ≥80% | % who try suggested prompts in first 24h |
| **Second Use Rate** | ≥70% | % who use skill again within 7 days |

### Secondary KPIs

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Prompt Suggestion Click Rate** | ≥40% | % who click suggested prompts |
| **Value Perception Score** | ≥4.0/5.0 | User survey: "I saw value immediately" |
| **Celebration Engagement** | ≥60% | % who interact with milestone messages |
| **Error Recovery Rate** | ≥85% | % who successfully recover from errors |

---

## 12. Accessibility Requirements

### Screen Reader Announcements
```
// First use
"jest-helper skill activated. Generated 5 test cases for Button component.
File created: Button.test.tsx. Next suggestion: Generate tests for LoginForm.tsx.
Press Tab to navigate actions."

// Milestone
"Achievement unlocked: Power user. You've created 10 test files with jest-helper,
saving an estimated 5 hours of work."
```

### Keyboard Shortcuts
- `Alt+V`: View last skill output
- `Alt+N`: Copy next suggested prompt
- `Alt+M`: View milestones/achievements
- `Ctrl+/`: Show skill capabilities

### High Contrast Mode
- Success checkmark: Bright green with bold outline
- Warning icon: Amber with thick border
- Celebration emojis: Replaced with text icons ("SUCCESS", "MILESTONE")

---

## 13. User Testing Protocol

### Phase 1: Activation Feedback Testing (Week 1)
**Participants**: 25 users installing first skill
**Method**: Remote usability testing

**Tasks**:
1. Install jest-helper
2. Try the suggested prompt
3. Read feedback message
4. Rate clarity (1-5)

**Metrics**:
- % who understand what skill did
- % who try suggested next prompt
- Clarity rating average

**Success Criteria**:
- ≥90% comprehension
- ≥50% try next prompt
- ≥4.0/5.0 clarity rating

---

### Phase 2: Value Perception Study (Weeks 2-3)
**Participants**: 30 active users
**Method**: Post-use surveys + interviews

**Questions**:
1. "Did you immediately understand what the skill did?" (Yes/No)
2. "How much time did this save you?" (Open-ended)
3. "Rate value delivered: 1-5"
4. "What would improve the feedback?"

**Success Criteria**:
- ≥85% immediate understanding
- ≥70% can estimate time saved
- ≥4.0/5.0 value rating

---

### Phase 3: Error Recovery Testing (Week 4)
**Participants**: 20 users
**Method**: Controlled environment with intentional errors

**Scenarios**:
1. File not found error
2. Partial generation (complex code)
3. Skill timeout

**Metrics**:
- % who successfully recover
- Time to recovery
- Help-seeking behavior

**Success Criteria**:
- ≥80% successful recovery
- <2 minutes median recovery time

---

**Document Version**: 1.0
**Last Updated**: December 31, 2025
**Author**: Behavioral Designer, Phase 4 Team
**Review Status**: Ready for Technical Review
