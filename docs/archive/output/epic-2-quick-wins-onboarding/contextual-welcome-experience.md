# Contextual Welcome Experience Design
**Epic 2: Quick Wins Onboarding - First Value in 60 Seconds**
**Priority**: HIGH
**Behavioral Designer**: Phase 4 Product Strategy

## Executive Summary

Design a welcoming first experience that delivers immediate value by matching skills to detected project context. Users should see relevant skills working within 60 seconds of installation, with zero configuration required.

---

## 1. Design Philosophy

### Core Principles
1. **Context is Everything**: Welcome message adapts to detected project type
2. **Zero Config Required**: Skills work immediately with sensible defaults
3. **Value, Then Config**: Show utility first, offer customization later
4. **Progressive Activation**: Start with 1 skill, expand to ecosystem
5. **Celebration, Not Tutorial**: Focus on what users can DO, not how it works

### User Journey Arc
```
Install → Immediate Context → Instant Demo → First Win → Expand
   ↓           ↓                  ↓           ↓         ↓
  30s         10s                15s         30s       +∞
```

**Total Time to First Value: <60 seconds**

---

## 2. Project Detection & Skill Matching

### Context Analysis Engine

When a skill is installed OR a new project is opened, analyze:

```typescript
interface ProjectContext {
  // From CodebaseAnalyzer
  frameworks: FrameworkInfo[];      // React, Vue, Express, etc.
  dependencies: DependencyInfo[];   // npm packages
  filePatterns: {
    hasTests: boolean;              // *.test.ts found
    hasDocker: boolean;             // Dockerfile found
    hasCI: boolean;                 // .github/workflows found
    hasAPI: boolean;                // API routes detected
  };

  // From file system
  projectType: 'frontend' | 'backend' | 'fullstack' | 'library' | 'unknown';
  language: 'typescript' | 'javascript' | 'python' | 'unknown';
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun';

  // Inferred metadata
  maturity: 'new' | 'growing' | 'established';  // Based on LOC + commit count
  teamSize: 'solo' | 'small' | 'large';         // Based on contributor count
}
```

### Skill-to-Context Matching Rules

| Skill | Trigger Conditions | Priority |
|-------|-------------------|----------|
| `commit` | Any git repository | Always HIGH |
| `jest-helper` | `hasTests: true` AND `dependencies.includes('jest')` | HIGH |
| `react-component` | `frameworks.includes('React')` | HIGH |
| `eslint-config` | TypeScript project WITHOUT existing ESLint | MEDIUM |
| `docker-compose` | Backend project WITHOUT Dockerfile | MEDIUM |
| `github-actions` | `hasCI: false` AND repo has remote | MEDIUM |
| `prisma-schema` | Backend + database dependency | LOW |
| `api-docs` | `hasAPI: true` | LOW |

---

## 3. Welcome Message Templates

### Template 1: Frontend React Project
**Trigger**: React + TypeScript detected
**Installed Skill**: `jest-helper`

```
╔═══════════════════════════════════════════════════════════╗
║  🎉 Welcome to Skillsmith!                                ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  I've analyzed your React + TypeScript project and       ║
║  installed 'jest-helper' to supercharge your testing.    ║
║                                                           ║
║  ✨ Try it now:                                           ║
║  "Generate tests for Button.tsx"                         ║
║                                                           ║
║  This will create a complete test file with:             ║
║  ✓ Component rendering tests                             ║
║  ✓ Props validation                                      ║
║  ✓ Event handler coverage                                ║
║                                                           ║
║  ──────────────────────────────────────────────────────  ║
║                                                           ║
║  📚 Other skills that work great with React:             ║
║  • react-component - Scaffold new components             ║
║  • eslint-config - Setup TypeScript linting              ║
║                                                           ║
║  [Explore Skills] [Dismiss]                              ║
╚═══════════════════════════════════════════════════════════╝
```

**Key Elements**:
- Acknowledges detected context ("React + TypeScript")
- Immediate example prompt users can copy/paste
- Explains WHAT will happen (not HOW it works)
- Suggests complementary skills (upsell ecosystem)

---

### Template 2: Backend Node.js Project
**Trigger**: Express detected, no Docker
**Installed Skill**: `docker-compose`

```
╔═══════════════════════════════════════════════════════════╗
║  🚀 Skillsmith Ready for Your Express API!                ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  I've set up 'docker-compose' for containerization.      ║
║                                                           ║
║  ✨ Try it now:                                           ║
║  "Create a docker-compose.yml for this Express app       ║
║   with PostgreSQL and Redis"                             ║
║                                                           ║
║  This generates a production-ready setup with:           ║
║  ✓ Multi-stage Dockerfile                                ║
║  ✓ Database containers                                   ║
║  ✓ Volume persistence                                    ║
║  ✓ Health checks                                         ║
║                                                           ║
║  ──────────────────────────────────────────────────────  ║
║                                                           ║
║  🔧 Recommended next:                                     ║
║  • github-actions - Automate Docker builds               ║
║  • api-docs - Generate OpenAPI specs                     ║
║                                                           ║
║  [Explore Skills] [Dismiss]                              ║
╚═══════════════════════════════════════════════════════════╝
```

---

### Template 3: New Empty Project
**Trigger**: <50 LOC, no frameworks detected
**Installed Skill**: `commit` (default first skill)

```
╔═══════════════════════════════════════════════════════════╗
║  👋 Welcome to Skillsmith!                                ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  I've installed the 'commit' skill to help you write     ║
║  better git commit messages automatically.               ║
║                                                           ║
║  ✨ Try it now:                                           ║
║  1. Make some changes to a file                          ║
║  2. Tell me: "Commit these changes"                      ║
║                                                           ║
║  I'll generate a semantic commit message following       ║
║  Conventional Commits format (feat:, fix:, docs:, etc.)  ║
║                                                           ║
║  ──────────────────────────────────────────────────────  ║
║                                                           ║
║  🎯 Tell me about your project to get personalized       ║
║     skill recommendations!                               ║
║                                                           ║
║  [Tell Me About This Project] [Dismiss]                  ║
╚═══════════════════════════════════════════════════════════╝
```

**Special Interaction**:
If user clicks [Tell Me About This Project]:
```
CLAUDE: I'd love to help! A few quick questions:

1. What type of project is this?
   [Frontend] [Backend] [Full-stack] [Library] [Other]

2. What framework/language?
   [React] [Vue] [Express] [Python] [Other: _____]

3. What do you want to build first?
   [Tests] [API Docs] [CI/CD] [Components] [Database]

[Prompt appears as user answers, updating recommendations in real-time]
```

---

### Template 4: Established Project (1000+ LOC)
**Trigger**: Large codebase, multiple frameworks
**Installed Skill**: User's choice from recommendations

```
╔═══════════════════════════════════════════════════════════╗
║  🏗️ Skillsmith: Enhancing Your Established Project        ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  I've analyzed your codebase:                            ║
║  • 1,247 files (React + TypeScript + Jest)               ║
║  • 8 contributors                                        ║
║  • Active for 6 months                                   ║
║                                                           ║
║  You've installed 'review-pr' to improve code quality.   ║
║                                                           ║
║  ✨ Try it now:                                           ║
║  "Review PR #42"                                         ║
║                                                           ║
║  This will analyze:                                      ║
║  ✓ Code quality & style                                  ║
║  ✓ Test coverage gaps                                    ║
║  ✓ Security vulnerabilities                              ║
║  ✓ Performance concerns                                  ║
║                                                           ║
║  ──────────────────────────────────────────────────────  ║
║                                                           ║
║  📊 Based on your team's workflow:                       ║
║  • github-actions - Automate PR checks                   ║
║  • commit - Standardize commit messages (8 devs)         ║
║                                                           ║
║  [Explore Team Skills] [Dismiss]                         ║
╚═══════════════════════════════════════════════════════════╝
```

---

## 4. Instant Demo System

### Demo Requirements
Every skill MUST provide an instant demo that:
1. **Runs without input**: Uses project context for defaults
2. **Completes in <10 seconds**: No long processing
3. **Shows visible output**: File created, message generated, etc.
4. **Is immediately useful**: Not a toy example

### Skill Demo Specifications

#### `jest-helper` Demo
```typescript
interface SkillDemo {
  trigger: 'onInstall' | 'onRequest';

  execute(): {
    // Auto-detect a component file without tests
    targetFile: string;  // e.g., "src/components/Button.tsx"

    // Generate test file
    outputFile: string;  // "src/components/Button.test.tsx"

    // Show preview before writing
    preview: {
      title: "Generated Test File Preview";
      content: string;  // Full test file content
      actions: ['Write to Disk', 'Edit First', 'Cancel'];
    };
  };
}
```

**Demo Flow**:
1. User installs `jest-helper`
2. Welcome message appears with example prompt
3. User types: "Generate tests for Button.tsx"
4. Skill shows preview:
   ```
   ┌─────────────────────────────────────────────┐
   │ Generated: Button.test.tsx                  │
   ├─────────────────────────────────────────────┤
   │ import { render, screen } from              │
   │   '@testing-library/react';                 │
   │ import { Button } from './Button';          │
   │                                             │
   │ describe('Button', () => {                  │
   │   test('renders with text', () => {         │
   │     render(<Button>Click</Button>);         │
   │     expect(screen.getByText('Click'))...    │
   │   });                                       │
   │                                             │
   │   test('handles click events', () => {      │
   │     const onClick = jest.fn();              │
   │     ...                                     │
   │   });                                       │
   │ });                                         │
   │                                             │
   │ [Write to Disk] [Edit First] [Cancel]      │
   └─────────────────────────────────────────────┘
   ```
5. User clicks [Write to Disk]
6. File created, success message: "✓ Test file created! Run `npm test` to execute."

---

#### `commit` Demo
```typescript
// Demo runs automatically after first file change + staging
const demo = {
  trigger: 'onGitAdd',

  execute() {
    // Analyze git diff
    const diff = execSync('git diff --staged').toString();

    // Generate commit message
    const message = generateConventionalCommit(diff);

    // Show preview
    return {
      title: "Suggested Commit Message",
      content: message,
      actions: ['Use This Message', 'Edit', 'Skip']
    };
  }
};
```

**Demo Flow**:
1. User edits `README.md`
2. User runs: `git add README.md`
3. User tells Claude: "Commit these changes"
4. Skill analyzes diff and shows:
   ```
   ┌─────────────────────────────────────────────┐
   │ Suggested Commit Message:                   │
   ├─────────────────────────────────────────────┤
   │ docs(readme): update installation guide     │
   │                                             │
   │ Add Docker setup instructions and clarify  │
   │ Node.js version requirements. Update        │
   │ examples to reflect latest API changes.     │
   │                                             │
   │ [Use This Message] [Edit] [Skip]           │
   └─────────────────────────────────────────────┘
   ```
5. User clicks [Use This Message]
6. Commit executes: `git commit -m "docs(readme): ..."`
7. Success: "✓ Committed! Your commit history just got more professional."

---

## 5. Response Tracking for Learning

### User Feedback Collection

Track user interactions with welcome messages to improve matching:

```typescript
interface WelcomeResponse {
  sessionId: string;
  timestamp: Date;

  context: {
    projectType: string;
    skillInstalled: string;
    templateUsed: string;
  };

  userAction: {
    type: 'tried_example' | 'dismissed' | 'explored_skills' | 'ignored';
    timeToAction?: number;  // Seconds until user acted
    exampleCopied?: boolean;
  };

  followUp?: {
    installedAdditionalSkills: string[];
    timeToContinuedUse: number;  // Time until second skill use
  };
}
```

### Learning Signals

| Signal | Interpretation | Optimization Action |
|--------|----------------|---------------------|
| **High "try example" rate (>70%)** | Good template match | Keep template as-is |
| **High dismissal rate (>50%)** | Poor context detection or messaging | Revise template or matching rules |
| **Long time to action (>2 min)** | Confusing message or unclear CTA | Simplify language, clearer prompts |
| **Low additional skill installs** | Poor upsell suggestions | Improve complementary skill recommendations |
| **Quick re-engagement (<5 min)** | Successful value demonstration | Expand to similar contexts |

### Adaptive Welcome System

After 1000+ welcome message interactions, use ML to:
1. **Predict best template** based on project features
2. **Personalize example prompts** based on user's coding patterns
3. **Optimize upsell order** (which complementary skills convert best)
4. **Tune timing** (show welcome immediately vs after 30s exploration)

---

## 6. Skill-to-Context Matching Flow Diagrams

### Diagram 1: New Project Detection
```
User Opens Project
       ↓
CodebaseAnalyzer.analyze(projectPath)
       ↓
Detect frameworks, deps, file patterns
       ↓
   ┌─────────────────────────────────┐
   │ Detected: React + TypeScript    │
   │ Has tests: true                 │
   │ Has CI: false                   │
   └─────────────────────────────────┘
       ↓
Query Skill Database:
  - jest-helper (HIGH: hasTests + React)
  - react-component (HIGH: React)
  - github-actions (MEDIUM: hasCI=false)
       ↓
Rank by: priority score × quality score
       ↓
Show Sidebar with Top 3-5 Skills
       ↓
User selects jest-helper
       ↓
Install in background
       ↓
Show Welcome Template #1 (Frontend React)
       ↓
Track user response (tried/dismissed/explored)
```

---

### Diagram 2: Multi-Skill Installation
```
User Selects 3 Skills from Sidebar:
  [✓] jest-helper
  [✓] react-component
  [✓] eslint-config
       ↓
Click [Install Selected (3)]
       ↓
   ┌──────────────────────────────┐
   │ Parallel Installation:       │
   │ ✓ jest-helper (done)         │
   │ ⟳ react-component (50%)      │
   │ ○ eslint-config (queued)     │
   └──────────────────────────────┘
       ↓
All installations complete
       ↓
Show Combined Welcome Message:
   ╔════════════════════════════════════════╗
   ║ 🎉 3 Skills Activated!                 ║
   ╠════════════════════════════════════════╣
   ║ Try these commands to get started:     ║
   ║                                        ║
   ║ 1️⃣ "Generate tests for Button.tsx"     ║
   ║    (jest-helper)                       ║
   ║                                        ║
   ║ 2️⃣ "Create a new component LoginForm"  ║
   ║    (react-component)                   ║
   ║                                        ║
   ║ 3️⃣ "Setup ESLint for TypeScript"       ║
   ║    (eslint-config)                     ║
   ║                                        ║
   ║ [Dismiss]                              ║
   ╚════════════════════════════════════════╝
       ↓
Track which commands user tries first
       ↓
Update skill usage analytics
```

---

## 7. Accessibility Requirements

### Welcome Message Accessibility

#### Screen Readers
- **Announcement**: "Skillsmith welcome message available. Press Alt+W to read."
- **Structure**: Proper heading hierarchy (h1 for title, h2 for sections)
- **ARIA Labels**: All buttons and interactive elements
- **Example Prompts**: Copyable with keyboard shortcut (Ctrl+C)

#### Keyboard Navigation
- **Tab Order**: Top-to-bottom, left-to-right
- **Shortcuts**:
  - `Alt+W`: Open/close welcome message
  - `Ctrl+C`: Copy example prompt
  - `Enter`: Activate primary action ("Try It Now")
  - `Escape`: Dismiss message
  - `1-5`: Quick-activate numbered example prompts

#### Visual Design
- **High Contrast Mode**: Welcome box outline increases to 3px
- **Font Scaling**: Supports up to 200% zoom
- **Focus Indicators**: Clear 2px outline on interactive elements
- **Color Independence**: Icons + text, never color alone

---

## 8. User Testing Protocol

### Phase 1: First-Impression Testing (Week 1)
**Participants**: 20 new Skillsmith users (mix of experience levels)
**Method**: In-person usability sessions
**Scenario**: Install Skillsmith, open a React project

**Tasks**:
1. Observe welcome message when it appears
2. Try the suggested example prompt
3. Explore recommended skills (if applicable)

**Metrics**:
- % who try example prompt within 60 seconds
- % who successfully generate output from skill
- Time to first value (welcome shown → useful output created)
- Sentiment analysis of verbal reactions

**Success Criteria**:
- ≥70% try example prompt
- ≥85% generate successful output
- Median time to first value: ≤60 seconds
- ≥80% positive sentiment ("This is cool!", "That was easy!", etc.)

---

### Phase 2: Context Matching Validation (Weeks 2-3)
**Participants**: 30 developers with diverse projects
**Method**: Remote testing with 10 project types

**Project Types Tested**:
1. React frontend (new)
2. React frontend (established)
3. Vue frontend
4. Express backend
5. NestJS backend
6. Full-stack Next.js
7. Python Flask API
8. Empty new project
9. Library/package project
10. Mobile React Native

**Metrics**:
- Accuracy of framework detection (% correct)
- Relevance of recommended skills (1-5 rating)
- Skill installation rate from welcome upsell

**Success Criteria**:
- ≥95% framework detection accuracy
- ≥4.0/5.0 skill relevance rating
- ≥30% install at least one upsell skill

---

### Phase 3: Example Prompt Effectiveness (Week 4)
**Participants**: 25 users across all tested project types
**Method**: A/B test 3 welcome message variations

**Variations**:
- **A**: Generic examples ("Try: Generate a test file")
- **B**: Context-specific examples ("Generate tests for Button.tsx")
- **C**: Progressive examples (start simple, offer advanced)

**Metrics**:
- Example prompt copy rate (% who copy/paste)
- Success rate of prompted actions
- Time to successful skill use

**Success Criteria**:
- Variation B or C outperforms A by ≥20%
- ≥80% success rate on prompted actions

---

## 9. Integration with Existing Systems

### CodebaseAnalyzer Integration
```typescript
// On project open or skill install
async function generateWelcomeMessage(
  projectPath: string,
  installedSkill: string
): Promise<WelcomeMessage> {

  // Analyze project
  const context = await codebaseAnalyzer.analyze(projectPath);
  const summary = codebaseAnalyzer.getSummary(context);

  // Determine project type
  const projectType = classifyProject(context);

  // Select template
  const template = selectWelcomeTemplate(projectType, installedSkill);

  // Generate personalized examples
  const examples = generateExamplesFromContext(context, installedSkill);

  // Recommend complementary skills
  const upsells = await getComplementarySkills(context, installedSkill);

  return {
    template,
    examples,
    upsells,
    context: {
      projectType,
      frameworks: context.frameworks.map(f => f.name),
    }
  };
}
```

### SkillMatcher Integration
```typescript
// Find complementary skills for upsell
async function getComplementarySkills(
  context: CodebaseContext,
  installedSkill: string
): Promise<SkillRecommendation[]> {

  const matcher = new SkillMatcher({ useFallback: true });

  // Build query from project context
  const query = buildContextQuery(context);

  // Get all skills
  const allSkills = await skillRepository.findAll();

  // Filter out already installed
  const candidates = allSkills.filter(s => s.id !== installedSkill);

  // Find top 3 complementary
  const recommendations = await matcher.findSimilarSkills(query, candidates, 3);

  matcher.close();

  return recommendations;
}
```

### Response Tracking Service
```typescript
// Track welcome message interactions
class WelcomeResponseTracker {
  async track(response: WelcomeResponse): Promise<void> {
    // Store in local SQLite (privacy-preserving)
    await db.insert('welcome_responses', response);

    // Update analytics aggregates
    await this.updateAggregates(response);

    // If opted in, send anonymized telemetry
    if (await userSettings.get('telemetry_enabled')) {
      await this.sendAnonymizedTelemetry(response);
    }
  }

  async getOptimizationInsights(): Promise<Insights> {
    // Analyze patterns for template improvements
    const dismissalRate = await this.getDismissalRateByTemplate();
    const conversionRate = await this.getConversionRateByContext();
    const timeToValue = await this.getMedianTimeToValue();

    return {
      highPerformingTemplates: dismissalRate.filter(r => r.rate < 0.3),
      lowPerformingTemplates: dismissalRate.filter(r => r.rate > 0.5),
      recommendedChanges: this.generateRecommendations(
        dismissalRate,
        conversionRate,
        timeToValue
      )
    };
  }
}
```

---

## 10. Success Metrics & KPIs

### Primary Metrics

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| **Time to First Value** | ≤60 seconds | welcome_shown → first_skill_output |
| **Example Prompt Try Rate** | ≥70% | % users who execute suggested prompt |
| **Welcome Message Dismissal Rate** | ≤30% | % who dismiss before trying skill |
| **Upsell Installation Rate** | ≥25% | % who install recommended skills |

### Secondary Metrics

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| **Context Detection Accuracy** | ≥95% | Manual verification of framework detection |
| **Skill Relevance Rating** | ≥4.0/5.0 | User survey after first use |
| **Multi-Skill Adoption** | ≥40% | % users with 3+ skills after 7 days |
| **Continued Usage** | ≥60% | % users who use skill again within 24 hours |

### Monitoring Dashboard
```
┌──────────────────────────────────────────────────┐
│ Welcome Experience Analytics (Last 7 Days)      │
├──────────────────────────────────────────────────┤
│ Welcome Messages Shown:       487               │
│ Median Time to First Value:    42 seconds ✓     │
│                                                  │
│ User Actions:                                    │
│ • Tried Example:              362  (74%) ✓      │
│ • Dismissed:                  109  (22%) ✓      │
│ • Ignored:                     16  ( 3%)        │
│                                                  │
│ By Project Type:                                 │
│ • React:         152 shown, 78% try rate         │
│ • Express:        98 shown, 71% try rate         │
│ • New/Empty:      67 shown, 65% try rate         │
│ • Vue:            45 shown, 82% try rate         │
│                                                  │
│ Upsell Performance:                              │
│ • Additional Skills Installed: 123  (25%) ✓     │
│ • Most Installed Upsell: react-component (38)   │
│                                                  │
│ User Satisfaction: 4.3/5.0 ⭐                    │
└──────────────────────────────────────────────────┘
```

---

## 11. Future Enhancements

### Post-Launch Iterations

1. **Interactive Onboarding**: Guided tutorial with progressive skill activation
2. **Team Onboarding**: Welcome message mentions skills used by teammates
3. **Project Templates**: "Start from template" preloads 5+ relevant skills
4. **Voice-Activated Demo**: "Alexa, demo the jest-helper skill"
5. **Gamification**: "🎯 Achievement Unlocked: First Test Generated!"

### Machine Learning Improvements

- **Predictive Context**: Suggest skills before project fully analyzed (based on first 10 files)
- **Personalized Examples**: Generate prompts matching user's coding style
- **Optimal Timing**: Learn when users are most receptive to welcome messages

---

**Document Version**: 1.0
**Last Updated**: December 31, 2025
**Author**: Behavioral Designer, Phase 4 Team
**Review Status**: Ready for Technical Review
