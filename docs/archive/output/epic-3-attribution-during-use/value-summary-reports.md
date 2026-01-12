# Value Summary Reports Design
**Epic 3: Attribution During Use - Making Value Visible**
**Priority**: MEDIUM
**Behavioral Designer**: Phase 4 Product Strategy

## Executive Summary

Design weekly digest and monthly summary reports that showcase the value Skillsmith delivers. Reports should be data-driven, visually appealing, and make users feel proud of their productivity gains.

---

## 1. Report Design Principles

### Core Tenets
1. **Celebratory Tone**: Highlight achievements, not just statistics
2. **Actionable Insights**: Every metric suggests a next action
3. **Comparative Context**: Show trends (week-over-week, month-over-month)
4. **Visual Storytelling**: Use charts and progress bars, not just numbers
5. **Shareable**: Easy to export and share with team/manager

### Report Types
1. **Weekly Digest** (Automated, every Monday)
2. **Monthly Summary** (Automated, first of month)
3. **On-Demand Stats** (User-triggered, anytime)
4. **Team Report** (Aggregated, for team leads)

---

## 2. Weekly Digest Report

### Delivery Method
- **Push Notification**: Monday 9:00 AM local time
- **Email**: Optional opt-in (plain text + HTML)
- **In-App**: Banner in Claude Desktop/VS Code

### Format: Terminal Display
```
╔══════════════════════════════════════════════════════════════╗
║             🎯 Your Week with Skillsmith                     ║
║             December 24-30, 2025                             ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  This week you:                                              ║
║  ✓ Generated 12 files with 4 different skills                ║
║  ✓ Saved an estimated 3.5 hours of work                      ║
║  ✓ Improved code quality with 8 test suites                  ║
║                                                              ║
║  ──────────────────────────────────────────────────────────  ║
║                                                              ║
║  🏆 Top Skills This Week:                                    ║
║                                                              ║
║  1. jest-helper ━━━━━━━━━━━━━━━ 8 uses (+3 from last week)  ║
║     • 8 test files generated                                 ║
║     • 100% avg. coverage                                     ║
║     • Time saved: ~2.1 hours                                 ║
║                                                              ║
║  2. commit ━━━━━━━━ 5 uses (+1 from last week)               ║
║     • 5 semantic commits created                             ║
║     • Time saved: ~25 minutes                                ║
║                                                              ║
║  3. react-component ━━━ 2 uses (new this week!)              ║
║     • 2 components with tests                                ║
║     • Time saved: ~1 hour                                    ║
║                                                              ║
║  ──────────────────────────────────────────────────────────  ║
║                                                              ║
║  📊 Week-over-Week Trends:                                   ║
║                                                              ║
║  Skill Usage:        +40% ▲ (15 uses vs 9 last week)         ║
║  Time Saved:         +55% ▲ (3.5h vs 2.3h last week)         ║
║  Files Generated:    +50% ▲ (12 files vs 8 last week)        ║
║                                                              ║
║  ──────────────────────────────────────────────────────────  ║
║                                                              ║
║  💡 Suggestion:                                              ║
║  You've used jest-helper 8 times! Consider trying           ║
║  'vitest-helper' for faster test execution.                 ║
║                                                              ║
║  [View Detailed Report] [Share This Week] [Dismiss]          ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

### Interactive Elements
- **[View Detailed Report]**: Opens full analytics dashboard
- **[Share This Week]**: Exports as markdown/image for sharing
- **[Dismiss]**: Closes digest, won't show again this week

---

### Email Version (HTML)
```html
<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center;">
    <h1>🎯 Your Week with Skillsmith</h1>
    <p>December 24-30, 2025</p>
  </div>

  <div style="padding: 30px; background: #f7fafc;">
    <h2>This week you:</h2>
    <ul style="font-size: 18px; line-height: 1.8;">
      <li>✓ Generated 12 files with 4 different skills</li>
      <li>✓ Saved an estimated <strong>3.5 hours</strong> of work</li>
      <li>✓ Improved code quality with 8 test suites</li>
    </ul>

    <h2>🏆 Top Skills This Week</h2>

    <!-- Skill Card 1 -->
    <div style="background: white; padding: 20px; margin: 15px 0; border-left: 4px solid #3b82f6;">
      <h3 style="margin: 0;">1. jest-helper</h3>
      <div style="background: #e0e7ff; height: 10px; border-radius: 5px; margin: 10px 0;">
        <div style="background: #3b82f6; height: 10px; width: 80%; border-radius: 5px;"></div>
      </div>
      <p><strong>8 uses</strong> (+3 from last week)</p>
      <ul>
        <li>8 test files generated</li>
        <li>100% avg. coverage</li>
        <li>Time saved: ~2.1 hours</li>
      </ul>
    </div>

    <!-- Skill Card 2 -->
    <div style="background: white; padding: 20px; margin: 15px 0; border-left: 4px solid #10b981;">
      <h3 style="margin: 0;">2. commit</h3>
      <div style="background: #d1fae5; height: 10px; border-radius: 5px; margin: 10px 0;">
        <div style="background: #10b981; height: 10px; width: 50%; border-radius: 5px;"></div>
      </div>
      <p><strong>5 uses</strong> (+1 from last week)</p>
      <ul>
        <li>5 semantic commits created</li>
        <li>Time saved: ~25 minutes</li>
      </ul>
    </div>

    <h2>📊 Week-over-Week Trends</h2>
    <table style="width: 100%; border-collapse: collapse;">
      <tr style="background: #e0e7ff;">
        <th style="padding: 10px; text-align: left;">Metric</th>
        <th style="padding: 10px; text-align: right;">This Week</th>
        <th style="padding: 10px; text-align: right;">Last Week</th>
        <th style="padding: 10px; text-align: right;">Change</th>
      </tr>
      <tr>
        <td style="padding: 10px;">Skill Usage</td>
        <td style="padding: 10px; text-align: right;">15 uses</td>
        <td style="padding: 10px; text-align: right;">9 uses</td>
        <td style="padding: 10px; text-align: right; color: #10b981;">+40% ▲</td>
      </tr>
      <tr>
        <td style="padding: 10px;">Time Saved</td>
        <td style="padding: 10px; text-align: right;">3.5 hours</td>
        <td style="padding: 10px; text-align: right;">2.3 hours</td>
        <td style="padding: 10px; text-align: right; color: #10b981;">+55% ▲</td>
      </tr>
      <tr>
        <td style="padding: 10px;">Files Generated</td>
        <td style="padding: 10px; text-align: right;">12 files</td>
        <td style="padding: 10px; text-align: right;">8 files</td>
        <td style="padding: 10px; text-align: right; color: #10b981;">+50% ▲</td>
      </tr>
    </table>

    <div style="background: #fef3c7; padding: 20px; margin: 20px 0; border-radius: 8px;">
      <h3>💡 Suggestion</h3>
      <p>You've used jest-helper 8 times! Consider trying 'vitest-helper' for faster test execution.</p>
    </div>

    <div style="text-align: center; margin: 30px 0;">
      <a href="#" style="background: #3b82f6; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; margin: 0 10px;">View Detailed Report</a>
      <a href="#" style="background: #10b981; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; margin: 0 10px;">Share This Week</a>
    </div>
  </div>

  <div style="padding: 20px; text-align: center; background: #e5e7eb; font-size: 12px; color: #6b7280;">
    <p>You received this because weekly digests are enabled in your Skillsmith settings.</p>
    <p><a href="#" style="color: #3b82f6;">Unsubscribe</a> | <a href="#" style="color: #3b82f6;">Adjust Frequency</a></p>
  </div>
</body>
</html>
```

---

## 3. Monthly Summary Report

### Format: Extended Analytics
```
╔══════════════════════════════════════════════════════════════╗
║          🏆 Your Month with Skillsmith - December 2025       ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  🎉 Highlights:                                              ║
║  • 47 files generated across 6 skills                        ║
║  • 14.2 hours saved (that's almost 2 full workdays!)         ║
║  • 3,847 lines of code written by skills                     ║
║  • 100% avg. test coverage maintained                        ║
║                                                              ║
║  ──────────────────────────────────────────────────────────  ║
║                                                              ║
║  📈 Monthly Breakdown:                                       ║
║                                                              ║
║  Week 1 (Dec 1-7):    9 uses,  2.3 hours saved              ║
║  Week 2 (Dec 8-14):  12 uses,  3.1 hours saved              ║
║  Week 3 (Dec 15-21): 11 uses,  2.8 hours saved              ║
║  Week 4 (Dec 22-28): 15 uses,  3.5 hours saved              ║
║  Week 5 (Dec 29-31):  5 uses,  2.5 hours saved              ║
║                                                              ║
║  Trend: ▲ Growing usage (+67% from Dec 1 to Dec 31)         ║
║                                                              ║
║  ──────────────────────────────────────────────────────────  ║
║                                                              ║
║  🏅 Top 5 Skills This Month:                                 ║
║                                                              ║
║  1. jest-helper          ━━━━━━━━━━━━━━━━━━ 24 uses (51%)   ║
║     Files: 24 test suites | Coverage: 98% avg.              ║
║     Time saved: 6.4 hours                                    ║
║                                                              ║
║  2. commit               ━━━━━━━━━━━ 15 uses (32%)           ║
║     Commits: 15 semantic messages                            ║
║     Time saved: 1.25 hours                                   ║
║                                                              ║
║  3. react-component      ━━━━━━ 9 uses (19%)                 ║
║     Files: 9 components + 9 tests                            ║
║     Time saved: 4.5 hours                                    ║
║                                                              ║
║  4. docker-compose       ━━━ 5 uses (11%)                    ║
║     Files: 5 docker configs                                  ║
║     Time saved: 2.5 hours                                    ║
║                                                              ║
║  5. eslint-config        ━━ 3 uses (6%)                      ║
║     Files: 3 lint configs                                    ║
║     Time saved: 0.75 hours                                   ║
║                                                              ║
║  ──────────────────────────────────────────────────────────  ║
║                                                              ║
║  📊 Your Productivity Stats:                                 ║
║                                                              ║
║  Most Productive Day:   Thursday (12 skill uses)             ║
║  Most Productive Time:  2-4 PM (35% of usage)                ║
║  Favorite Skill Combo:  jest-helper + react-component        ║
║                                                              ║
║  ──────────────────────────────────────────────────────────  ║
║                                                              ║
║  🎯 December Achievements:                                   ║
║                                                              ║
║  ✓ Test Master: Generated 20+ test suites                   ║
║  ✓ Commit Pro: Created 15+ semantic commits                 ║
║  ✓ Time Saver: Saved 10+ hours in a month                   ║
║                                                              ║
║  ──────────────────────────────────────────────────────────  ║
║                                                              ║
║  💡 Recommendations for January:                             ║
║                                                              ║
║  • You love jest-helper! Try 'vitest-helper' for 2x speed   ║
║  • Automate Docker builds with 'github-actions' skill        ║
║  • Document APIs with 'api-docs' (pairs with docker!)        ║
║                                                              ║
║  [Export Full Report (PDF)] [Share on LinkedIn]              ║
║  [Compare to Team Average] [Set January Goals]               ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

---

### PDF Export Format
**Cover Page**:
```
┌────────────────────────────────────────┐
│                                        │
│        [Skillsmith Logo]               │
│                                        │
│    Your Productivity Report            │
│         December 2025                  │
│                                        │
│         John Doe                       │
│      john@example.com                  │
│                                        │
│      Generated: Dec 31, 2025           │
│                                        │
└────────────────────────────────────────┘
```

**Page 2: Executive Summary**
- Total time saved
- Files generated
- Skills used
- Key achievements

**Page 3: Skill Breakdown**
- Detailed stats per skill
- Usage charts (bar graphs)
- Trend lines

**Page 4: Time Analysis**
- Usage by day of week
- Usage by time of day
- Productivity patterns

**Page 5: Recommendations**
- Suggested skills to try
- Optimization tips
- Workflow improvements

---

## 4. On-Demand Stats Query

### CLI Interface
```bash
skillsmith stats

# Quick overview
skillsmith stats --quick

# Specific skill
skillsmith stats --skill jest-helper

# Date range
skillsmith stats --from 2025-12-01 --to 2025-12-31

# Export formats
skillsmith stats --export pdf
skillsmith stats --export csv
skillsmith stats --export json
```

### Example Output (Quick Stats)
```
$ skillsmith stats --quick

Skillsmith Quick Stats (Last 30 Days)
════════════════════════════════════════

Skills Used:        6
Total Uses:         47
Files Generated:    47
Time Saved:         14.2 hours
Avg. Daily Usage:   1.6 uses

Top 3 Skills:
1. jest-helper (24 uses)
2. commit (15 uses)
3. react-component (9 uses)

Run 'skillsmith stats' for detailed report.
```

### Example Output (Detailed Skill Stats)
```
$ skillsmith stats --skill jest-helper

jest-helper Detailed Stats (Last 30 Days)
════════════════════════════════════════════════════════════

Usage:              24 times
Files Generated:    24 test files
Total LOC:          1,847 lines of test code
Avg. File Size:     77 lines
Time Saved:         ~6.4 hours (estimated)

Test Coverage Achieved:
• 100% coverage:   18 files (75%)
• 90-99% coverage:  5 files (21%)
• <90% coverage:    1 file (4%)

Usage Breakdown by Week:
Week 1:  4 uses ━━━━
Week 2:  6 uses ━━━━━━
Week 3:  5 uses ━━━━━
Week 4:  7 uses ━━━━━━━
Week 5:  2 uses ━━

Most Common Test Types Generated:
• Component rendering: 72 tests
• Props validation:    36 tests
• Event handlers:      28 tests
• Hooks:               15 tests

Files Generated:
[List of 24 test files with timestamps...]

Run 'skillsmith stats --skill jest-helper --export pdf' to save report.
```

---

## 5. Team Report (Aggregated)

### Use Case
Team leads want to see aggregate stats for their team's Skillsmith usage.

### Format
```
╔══════════════════════════════════════════════════════════════╗
║       Team Productivity Report - Engineering Team            ║
║              December 2025 (12 members)                      ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  🏆 Team Highlights:                                         ║
║  • 234 files generated across team                           ║
║  • 87.3 hours saved (that's 10.9 workdays!)                  ║
║  • 8 different skills actively used                          ║
║  • 100% team adoption (all 12 members using Skillsmith)      ║
║                                                              ║
║  ──────────────────────────────────────────────────────────  ║
║                                                              ║
║  📊 Team Usage Stats:                                        ║
║                                                              ║
║  Avg. Uses per Member:     19.5 uses/month                   ║
║  Avg. Time Saved per Member:  7.3 hours/month                ║
║  Most Used Skills (Team):                                    ║
║    1. jest-helper (89 uses)                                  ║
║    2. commit (67 uses)                                       ║
║    3. react-component (45 uses)                              ║
║                                                              ║
║  ──────────────────────────────────────────────────────────  ║
║                                                              ║
║  🏅 Top Contributors:                                        ║
║                                                              ║
║  1. Alice (32 uses, 12.1 hours saved)                        ║
║  2. Bob (28 uses, 9.8 hours saved)                           ║
║  3. Charlie (24 uses, 8.3 hours saved)                       ║
║                                                              ║
║  ──────────────────────────────────────────────────────────  ║
║                                                              ║
║  📈 Month-over-Month Growth:                                 ║
║                                                              ║
║  November:  187 uses, 68.2 hours saved                       ║
║  December:  234 uses, 87.3 hours saved                       ║
║  Change:    +25% uses ▲, +28% time saved ▲                  ║
║                                                              ║
║  ──────────────────────────────────────────────────────────  ║
║                                                              ║
║  💡 Team Optimization Opportunities:                         ║
║                                                              ║
║  • 4 members haven't tried 'docker-compose' yet              ║
║  • Jest usage is high - consider team training session       ║
║  • commit skill adoption: 83% (10/12) - encourage 100%       ║
║                                                              ║
║  [Export Team Report (PDF)] [View Individual Reports]        ║
║  [Schedule Team Review] [Set Team Goals for January]         ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

### Privacy Considerations
- Individual names shown only to team leads (role-based access)
- Aggregates shown to team members (no individual attribution)
- Opt-out available (individuals can hide from team stats)

---

## 6. Value Estimation Algorithms

### Time Saved Calculation
```typescript
class ValueEstimator {
  /**
   * Estimate time saved for a skill output
   */
  estimateTimeSaved(skill: Skill, output: SkillOutput): number {
    // Base formula: Research time + Writing time + Testing time
    const research = this.estimateResearchTime(skill, output);
    const writing = this.estimateWritingTime(skill, output);
    const testing = this.estimateTestingTime(skill, output);

    return research + writing + testing;
  }

  private estimateResearchTime(skill: Skill, output: SkillOutput): number {
    // Heuristic: Complex skills require more research
    const complexityMap = {
      'jest-helper': 10,       // 10 min per file (documentation lookup)
      'commit': 2,             // 2 min (conventions lookup)
      'react-component': 15,   // 15 min (best practices research)
      'docker-compose': 30,    // 30 min (Docker docs + service configs)
      'eslint-config': 20,     // 20 min (rule configuration)
    };

    const baseResearch = complexityMap[skill.id] || 10;
    const fileMultiplier = output.files?.length || 1;

    return baseResearch * fileMultiplier;
  }

  private estimateWritingTime(skill: Skill, output: SkillOutput): number {
    // Heuristic: 2 minutes per 10 lines of code
    const totalLOC = output.files?.reduce((sum, f) => sum + f.lineCount, 0) || 0;
    const writingMinutes = (totalLOC / 10) * 2;

    return writingMinutes;
  }

  private estimateTestingTime(skill: Skill, output: SkillOutput): number {
    // Heuristic: 5 minutes per file for basic testing
    const fileCount = output.files?.length || 0;
    return fileCount * 5;
  }

  /**
   * Estimate monetary value (optional, for enterprise)
   */
  estimateMonetaryValue(timeSavedMinutes: number, hourlyRate: number): number {
    const hours = timeSavedMinutes / 60;
    return hours * hourlyRate;
  }
}
```

### Example Calculations

#### jest-helper (Single Test File)
```
Input: Button.test.tsx (85 lines, 7 test cases)

Research time:  10 min (lookup Jest API, testing best practices)
Writing time:   17 min (85 LOC / 10 * 2)
Testing time:    5 min (run and verify tests work)
──────────────────────
Total:          32 minutes saved
```

#### react-component (Component + Test)
```
Input: LoginForm.tsx (120 lines) + LoginForm.test.tsx (60 lines)

Research time:  30 min (15 min per file × 2)
Writing time:   36 min (180 LOC / 10 * 2)
Testing time:   10 min (2 files × 5 min)
──────────────────────
Total:          76 minutes saved (~1.25 hours)
```

#### docker-compose (Multi-Service Setup)
```
Input: docker-compose.yml (80 lines), Dockerfile (45 lines), .dockerignore (15 lines)

Research time:  90 min (30 min per file × 3)
Writing time:   28 min (140 LOC / 10 * 2)
Testing time:   15 min (3 files × 5 min)
──────────────────────
Total:          133 minutes saved (~2.2 hours)
```

---

## 7. Report Sharing & Export

### Share Options

#### 1. Export as Markdown
```markdown
# Your Week with Skillsmith
**December 24-30, 2025**

## Highlights
- Generated 12 files with 4 different skills
- Saved an estimated **3.5 hours** of work
- Improved code quality with 8 test suites

## Top Skills This Week

### 1. jest-helper
- **8 uses** (+3 from last week)
- 8 test files generated
- 100% avg. coverage
- Time saved: ~2.1 hours

[...]
```

**Use Case**: Share in GitHub issues, Slack, team wikis

---

#### 2. Export as Image (PNG)
```
[Visual card with:
- Skillsmith logo
- User name
- Key stats in large font
- Mini bar chart
- Gradient background]

Optimized for:
- LinkedIn posts
- Twitter/X shares
- Team Slack announcements
```

---

#### 3. Export as CSV
```csv
Date,Skill,Files,LOC,Time Saved (min),Coverage
2025-12-24,jest-helper,Button.test.tsx,85,32,100
2025-12-24,commit,N/A,N/A,2,N/A
2025-12-25,react-component,LoginForm.tsx,120,76,N/A
[...]
```

**Use Case**: Import into Excel/Sheets for custom analysis

---

#### 4. Export as JSON
```json
{
  "period": {
    "start": "2025-12-24",
    "end": "2025-12-30",
    "type": "week"
  },
  "summary": {
    "totalUses": 15,
    "filesGenerated": 12,
    "timeSavedMinutes": 210,
    "skillsUsed": 4
  },
  "skills": [
    {
      "id": "jest-helper",
      "name": "jest-helper",
      "uses": 8,
      "filesGenerated": 8,
      "timeSavedMinutes": 126,
      "metrics": {
        "avgCoverage": 100,
        "totalLOC": 680
      }
    }
  ],
  "trends": {
    "weekOverWeek": {
      "usesChange": 0.40,
      "timeSavedChange": 0.55
    }
  }
}
```

**Use Case**: API integrations, custom dashboards

---

## 8. Notification & Delivery Settings

### Settings Panel
```
┌─────────────────────────────────────────────┐
│ Report Delivery Settings                    │
├─────────────────────────────────────────────┤
│                                             │
│ Weekly Digest:                              │
│ [✓] Enable weekly digest                   │
│ Delivery: [Monday ▼] at [9:00 AM ▼]        │
│ Format:  [Terminal + Email ▼]              │
│                                             │
│ Monthly Summary:                            │
│ [✓] Enable monthly summary                 │
│ Delivery: [1st of month ▼] at [9:00 AM ▼]  │
│ Format:  [Terminal + Email ▼]              │
│                                             │
│ Email Address:                              │
│ john@example.com [Change]                   │
│                                             │
│ Notification Style:                         │
│ • Celebratory (highlight achievements)      │
│ ○ Neutral (just the facts)                 │
│ ○ Minimal (summary only)                   │
│                                             │
│ [Save Settings] [Test Email Delivery]      │
└─────────────────────────────────────────────┘
```

---

## 9. Gamification Integration

### Achievement Badges in Reports
```
╔══════════════════════════════════════════════════════════════╗
║  🎉 New Achievements This Month!                             ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  🏆 Test Master                                              ║
║     Generated 20+ test suites in one month                   ║
║     Unlocked: December 15, 2025                              ║
║                                                              ║
║  ⚡ Speed Demon                                              ║
║     Saved 10+ hours in one month                             ║
║     Unlocked: December 22, 2025                              ║
║                                                              ║
║  🌟 Early Adopter                                            ║
║     Used 5+ different skills                                 ║
║     Unlocked: December 10, 2025                              ║
║                                                              ║
║  [View All Achievements (12/30)] [Share Badges]              ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

---

## 10. Success Metrics

### Primary KPIs

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Report Open Rate** | ≥60% | % users who open weekly digest |
| **Report Engagement** | ≥30% | % users who interact (click buttons) |
| **Perceived Value** | ≥4.0/5.0 | "Reports help me see value" survey |
| **Share Rate** | ≥10% | % users who export/share reports |

### Secondary KPIs

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Email Opt-In** | ≥40% | % users who enable email delivery |
| **Custom Export Usage** | ≥20% | % users who export in CSV/JSON/PDF |
| **Team Report Adoption** | ≥50% | % teams using aggregated reports |

---

## 11. Integration Points

### Integration with AttributionService
```typescript
class ReportGenerator {
  async generateWeeklyDigest(userId: string): Promise<WeeklyDigest> {
    const startDate = getStartOfWeek(new Date());
    const endDate = getEndOfWeek(new Date());

    // Fetch attribution data
    const attributions = await this.attributionService.getRange(
      userId,
      startDate,
      endDate
    );

    // Calculate metrics
    const metrics = this.calculateMetrics(attributions);

    // Compare to previous week
    const previousMetrics = await this.getPreviousWeekMetrics(userId);
    const trends = this.calculateTrends(metrics, previousMetrics);

    // Generate recommendations
    const recommendations = await this.generateRecommendations(
      userId,
      attributions,
      metrics
    );

    return {
      period: { start: startDate, end: endDate },
      metrics,
      trends,
      topSkills: this.getTopSkills(attributions, 3),
      recommendations,
    };
  }

  private calculateMetrics(attributions: Attribution[]): WeekMetrics {
    return {
      totalUses: attributions.length,
      filesGenerated: attributions.filter(a => a.output_type === 'file').length,
      timeSavedMinutes: attributions.reduce(
        (sum, a) => sum + (a.estimated_time_saved_minutes || 0),
        0
      ),
      skillsUsed: new Set(attributions.map(a => a.skill_id)).size,
    };
  }
}
```

---

## 12. Accessibility Requirements

### Screen Reader Support
- Reports announced as "Skillsmith weekly digest available"
- Proper heading hierarchy (h1, h2, h3)
- ARIA labels for all interactive elements
- Table data with proper headers

### Keyboard Navigation
- `Alt+R`: Open latest report
- `Tab`: Navigate through sections
- `Enter`: Activate buttons
- `Escape`: Close report

### High Contrast Mode
- Charts use patterns (not just colors)
- Text meets WCAG AA contrast requirements (4.5:1)
- Focus indicators visible

---

**Document Version**: 1.0
**Last Updated**: December 31, 2025
**Author**: Behavioral Designer, Phase 4 Team
**Review Status**: Ready for Technical Review
