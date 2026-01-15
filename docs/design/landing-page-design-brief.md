# Skillsmith Landing Page Design Brief
## For Figma Make Implementation

**Document Version:** 1.0
**Created:** January 14, 2026
**Target URL:** skillsmith.app
**Purpose:** Beta user email capture for early access

---

## Executive Summary

Skillsmith is a skill discovery and recommendation system for Claude Code. The landing page must convert technical developers into beta signups by communicating professional credibility and measurable efficiency gains—all while feeling like a natural extension of the Claude ecosystem.

**Primary Goal:** Capture emails from efficiency-focused developers who want early access to smarter skill discovery.

**Design Direction:** Bold & Confident aesthetic aligned with Anthropic/Claude visual language. Professional credibility meets developer efficiency.

---

## Brand Identity

### Brand Essence

**Skillsmith = The intelligent layer between developers and the 46,000+ skill ecosystem.**

We're not a marketplace. We're not a directory. We're your **efficiency multiplier**—surfacing the right skills for your stack before you know you need them.

### Brand Personality

| Attribute | Expression |
|-----------|------------|
| **Confident** | We know this space deeply. No hedging. Clear value statements. |
| **Efficient** | Respects developer time. No fluff. Every element earns its place. |
| **Trustworthy** | Part of the Claude ecosystem. Quality signals you can rely on. |
| **Technical** | Built by developers, for developers. Understands the workflow. |
| **Forward-looking** | Early access = competitive advantage. Stay ahead. |

### Brand Voice (For Copy Direction)

**Tone:** Peer-to-peer technical conversation. A senior colleague who's already solved this.

**What we say:**
- "Find skills that fit your stack, not just the famous ones"
- "Save hours. Not someday. This week."
- "46,000+ skills. Finally discoverable."
- "Quality scores you can trust. Activation rates that don't lie."

**What we never say:**
- "Revolutionary!" / "Game-changing!" (hyperbole)
- "Easy!" / "Simple!" (dismissive)
- "Congratulations!" (patronizing)
- Marketing buzzwords or emoji

---

## Visual Identity System

### Color Palette

**Philosophy:** Warm sophistication from Claude's ecosystem + bold confidence through strategic dark foundations and sharp accents.

#### Primary Colors

```css
/* Dark Foundation - Bold confidence, reduces eye strain for developers */
--bg-primary: #0D0D0F;          /* Near-black, warmer than pure black */
--bg-secondary: #18181B;        /* Card backgrounds, elevation */
--bg-tertiary: #27272A;         /* Subtle borders, dividers */

/* Claude-Aligned Warm Accent - The hero color */
--accent-primary: #E07A5F;      /* Coral/terracotta - warm, confident */
--accent-primary-hover: #D4694E;
--accent-primary-glow: rgba(224, 122, 95, 0.15);

/* Supporting Warm Tones */
--accent-secondary: #F4A261;    /* Amber - for highlights, badges */
--accent-tertiary: #81B29A;     /* Sage green - success states, trust */

/* Text Hierarchy */
--text-primary: #FAFAFA;        /* High contrast headlines */
--text-secondary: #A1A1AA;      /* Body text, descriptions */
--text-tertiary: #71717A;       /* Captions, metadata */
--text-accent: #E07A5F;         /* Links, emphasis */
```

#### Color Usage Rules

1. **Dark mode only** for landing page (aligns with developer preference, Claude Code context)
2. **Coral accent (#E07A5F)** reserved for primary CTA and key emphasis only
3. **Warm neutrals** for backgrounds prevent the cold, corporate feel
4. **Sage green** for trust signals (quality scores, verification badges)
5. **Amber** for highlighting value propositions and beta exclusivity

#### Gradient Specifications

```css
/* Hero gradient - subtle warmth on dark */
--gradient-hero: linear-gradient(
  135deg,
  #0D0D0F 0%,
  #1A1418 50%,
  #0D0D0F 100%
);

/* CTA button gradient */
--gradient-cta: linear-gradient(
  135deg,
  #E07A5F 0%,
  #D4694E 100%
);

/* Card hover glow */
--gradient-glow: radial-gradient(
  circle at center,
  rgba(224, 122, 95, 0.08) 0%,
  transparent 70%
);
```

### Typography System

**Philosophy:** Bold confidence through weight extremes. Technical credibility through geometric forms. No generic fonts.

#### Font Selection

| Role | Font | Weight | Fallback |
|------|------|--------|----------|
| **Display/Headlines** | **Satoshi** | 900 (Black), 700 (Bold) | system-ui |
| **Body Text** | **Satoshi** | 500 (Medium), 400 (Regular) | system-ui |
| **Monospace/Code** | **JetBrains Mono** | 500, 600 | monospace |

**Why Satoshi:**
- Modern geometric sans-serif with personality
- Excellent weight range (900 for bold headlines)
- Claude-adjacent feel without copying Inter
- Strong technical credibility
- Available on Google Fonts alternative: Fontshare (free)

**Alternative if Satoshi unavailable:** Cabinet Grotesk or General Sans

#### Type Scale

```css
/* Headline hierarchy - dramatic size jumps (3x+ ratio) */
--text-hero: 4.5rem;      /* 72px - Main headline only */
--text-h1: 3rem;          /* 48px - Section headers */
--text-h2: 2rem;          /* 32px - Card titles */
--text-h3: 1.5rem;        /* 24px - Feature labels */

/* Body hierarchy */
--text-body-lg: 1.25rem;  /* 20px - Lead paragraphs */
--text-body: 1rem;        /* 16px - Standard body */
--text-caption: 0.875rem; /* 14px - Metadata, labels */
--text-small: 0.75rem;    /* 12px - Legal, fine print */

/* Line heights */
--leading-tight: 1.1;     /* Headlines */
--leading-normal: 1.5;    /* Body text */
--leading-relaxed: 1.75;  /* Long-form */

/* Letter spacing */
--tracking-tight: -0.02em;  /* Headlines */
--tracking-normal: 0;       /* Body */
--tracking-wide: 0.05em;    /* Labels, all-caps */
```

#### Typography Examples

**Hero Headline:**
```
Font: Satoshi Black (900)
Size: 72px / 4.5rem
Line-height: 1.1
Letter-spacing: -0.02em
Color: #FAFAFA
```

**Subheadline:**
```
Font: Satoshi Medium (500)
Size: 20px / 1.25rem
Line-height: 1.5
Color: #A1A1AA
```

### Spacing System

```css
/* Base unit: 4px */
--space-1: 0.25rem;   /* 4px */
--space-2: 0.5rem;    /* 8px */
--space-3: 0.75rem;   /* 12px */
--space-4: 1rem;      /* 16px */
--space-6: 1.5rem;    /* 24px */
--space-8: 2rem;      /* 32px */
--space-12: 3rem;     /* 48px */
--space-16: 4rem;     /* 64px */
--space-24: 6rem;     /* 96px */
--space-32: 8rem;     /* 128px */

/* Section padding */
--section-y: var(--space-24);  /* Vertical section padding */
--section-x: var(--space-8);   /* Horizontal content padding */
```

### Border & Shadow System

```css
/* Borders - subtle, warm-tinted */
--border-subtle: 1px solid rgba(255, 255, 255, 0.06);
--border-medium: 1px solid rgba(255, 255, 255, 0.1);
--border-accent: 1px solid rgba(224, 122, 95, 0.3);

/* Border radius */
--radius-sm: 6px;
--radius-md: 12px;
--radius-lg: 16px;
--radius-xl: 24px;
--radius-full: 9999px;

/* Shadows - warm glow aesthetic */
--shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.3);
--shadow-md: 0 4px 16px rgba(0, 0, 0, 0.4);
--shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.5);
--shadow-glow: 0 0 40px rgba(224, 122, 95, 0.15);
--shadow-cta: 0 8px 32px rgba(224, 122, 95, 0.25);
```

---

## Page Structure & Layout

### Overall Layout

```
┌─────────────────────────────────────────────────────────────┐
│                        NAVIGATION                           │
│  [Logo]                                    [API Docs] [CTA] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                      HERO SECTION                           │
│                                                             │
│     "Save Hours Finding the Right Skills."                  │
│                                                             │
│     46,000+ Claude Code skills. Finally searchable.         │
│     Get stack-aware recommendations before anyone else.     │
│                                                             │
│     [Email Input] [Get Early Access →]                      │
│                                                             │
│     ◉ 247 developers already signed up                      │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    VALUE PROPS STRIP                        │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Semantic │  │ Quality  │  │ Stack-   │  │ One-Click│   │
│  │ Search   │  │ Scores   │  │ Aware    │  │ Install  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                   PROBLEM/SOLUTION                          │
│                                                             │
│  "The skill discovery problem"                              │
│                                                             │
│  ┌─────────────────┐        ┌─────────────────┐           │
│  │    WITHOUT      │   →    │      WITH       │           │
│  │   SKILLSMITH    │        │   SKILLSMITH    │           │
│  │                 │        │                 │           │
│  │ • Manual search │        │ • Smart search  │           │
│  │ • No quality    │        │ • Quality scores│           │
│  │ • Trial/error   │        │ • Stack-aware   │           │
│  └─────────────────┘        └─────────────────┘           │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    SOCIAL PROOF                             │
│                                                             │
│     "Join 247 developers getting early access"              │
│                                                             │
│     [Email Input] [Get Early Access →]                      │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                       FOOTER                                │
│                                                             │
│  Skillsmith · api.skillsmith.app · @skillsmith              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Responsive Breakpoints

```css
/* Mobile-first approach */
--bp-sm: 640px;   /* Small tablets */
--bp-md: 768px;   /* Tablets */
--bp-lg: 1024px;  /* Small laptops */
--bp-xl: 1280px;  /* Desktop */
--bp-2xl: 1536px; /* Large screens */
```

### Grid System

- **Max content width:** 1200px
- **Column count:** 12 columns
- **Gutter:** 24px (--space-6)
- **Margin (mobile):** 16px
- **Margin (desktop):** 48px

---

## Component Specifications

### 1. Navigation Bar

```
Height: 72px
Background: --bg-primary with 80% opacity, backdrop-blur
Border: --border-subtle on bottom
Position: Fixed, top

Content:
- Logo (left): Skillsmith wordmark, coral accent on icon
- Links (right): "API Docs" (text link), "Get Early Access" (ghost button)

Behavior:
- Scroll: Slightly increase opacity, add subtle shadow
```

**Logo Concept:**
- Wordmark: "Skillsmith" in Satoshi Bold
- Icon: Abstract "S" suggesting layered skills/cards
- Color: White text, coral (#E07A5F) icon accent

### 2. Hero Section

**Layout:** Centered, single column
**Max width:** 800px
**Vertical padding:** 160px top, 96px bottom

#### Hero Headline
```
Text: "Save Hours Finding the Right Skills."
Font: Satoshi Black (900)
Size: 72px (desktop), 48px (mobile)
Color: #FAFAFA
Alignment: Center
Animation: Fade up on load (0.8s ease, 0.1s delay)
```

#### Hero Subheadline
```
Text: "46,000+ Claude Code skills. Finally searchable.
       Get stack-aware recommendations before anyone else."
Font: Satoshi Medium (500)
Size: 20px (desktop), 18px (mobile)
Color: #A1A1AA
Line-height: 1.6
Max-width: 600px
Animation: Fade up (0.8s ease, 0.2s delay)
```

#### Email Capture Form
```
Layout: Horizontal on desktop, stacked on mobile
Max-width: 500px

Input field:
- Background: #18181B
- Border: 1px solid rgba(255,255,255,0.1)
- Border-radius: 12px (left side full, right connects to button)
- Padding: 16px 20px
- Placeholder: "Enter your email"
- Font: Satoshi Regular, 16px
- Focus state: Border color #E07A5F, subtle glow

Button:
- Background: linear-gradient(135deg, #E07A5F, #D4694E)
- Text: "Get Early Access →"
- Font: Satoshi Bold, 16px
- Color: white
- Padding: 16px 32px
- Border-radius: 12px (right side full)
- Shadow: 0 8px 32px rgba(224, 122, 95, 0.25)
- Hover: Scale 1.02, increase shadow

Animation: Fade up (0.8s ease, 0.3s delay)
```

#### Social Proof Counter
```
Text: "◉ 247 developers already signed up"
Font: Satoshi Medium, 14px
Color: #71717A with coral dot
Position: Below form, 16px margin
Animation: Fade in (0.8s ease, 0.5s delay)
```

### 3. Value Props Strip

**Layout:** 4-column grid (2x2 on mobile)
**Background:** Subtle gradient or --bg-secondary
**Padding:** 48px vertical

#### Value Prop Card
```
Size: ~200px width
Background: transparent
Border: none
Padding: 24px
Alignment: Center

Icon:
- Size: 48px
- Style: Outlined, 2px stroke
- Color: #E07A5F

Title:
- Font: Satoshi Bold, 18px
- Color: #FAFAFA
- Margin-top: 16px

Description:
- Font: Satoshi Regular, 14px
- Color: #A1A1AA
- Margin-top: 8px
- Max-width: 180px
```

**Value Props Content:**

1. **Semantic Search**
   - Icon: Magnifying glass with sparkle
   - "Search by intent, not keywords. AI-powered skill discovery."

2. **Quality Scores**
   - Icon: Badge with checkmark
   - "0-100 scores based on docs, tests, maintenance, security."

3. **Stack-Aware**
   - Icon: Layers/stack
   - "Recommendations tailored to your project's tech stack."

4. **One-Click Install**
   - Icon: Download arrow
   - "Install directly to Claude Code. Uninstall just as fast."

### 4. Problem/Solution Section

**Layout:** Two-column comparison
**Background:** --bg-primary
**Padding:** 96px vertical

#### Section Header
```
Text: "The skill discovery problem"
Font: Satoshi Bold, 32px
Color: #FAFAFA
Alignment: Center
Margin-bottom: 48px
```

#### Comparison Cards

**Without Skillsmith (Left):**
```
Background: #18181B
Border: 1px solid rgba(255,255,255,0.06)
Border-radius: 16px
Padding: 32px
Opacity: 0.7 (slightly dimmed)

Header:
- Text: "Without Skillsmith"
- Font: Satoshi Medium, 14px, uppercase
- Color: #71717A
- Letter-spacing: 0.05em

List items:
- "Manual GitHub searches"
- "No quality signals"
- "Trial and error installs"
- "Miss skills you need"
- Font: Satoshi Regular, 16px
- Color: #A1A1AA
- Icon: × in #71717A
- Spacing: 12px between items
```

**With Skillsmith (Right):**
```
Background: #18181B
Border: 1px solid rgba(224, 122, 95, 0.2)
Border-radius: 16px
Padding: 32px
Box-shadow: 0 0 40px rgba(224, 122, 95, 0.08)

Header:
- Text: "With Skillsmith"
- Font: Satoshi Medium, 14px, uppercase
- Color: #E07A5F
- Letter-spacing: 0.05em

List items:
- "Semantic search across 46K+ skills"
- "Quality scores you can trust"
- "Stack-aware recommendations"
- "Discover before you need"
- Font: Satoshi Regular, 16px
- Color: #FAFAFA
- Icon: ✓ in #81B29A (sage green)
- Spacing: 12px between items
```

### 5. Final CTA Section

**Layout:** Centered
**Background:** Subtle warm gradient
**Padding:** 96px vertical

```
Headline:
- Text: "Join 247 developers getting early access"
- Font: Satoshi Bold, 32px
- Color: #FAFAFA

Subtext:
- Text: "Be first to discover skills that fit your workflow."
- Font: Satoshi Regular, 18px
- Color: #A1A1AA
- Margin: 16px top

Form: Same as hero section email capture
```

### 6. Footer

```
Background: --bg-primary
Border-top: --border-subtle
Padding: 48px vertical
Layout: Single line, centered

Content:
- "Skillsmith" (wordmark)
- "·" separator
- "api.skillsmith.app" (link)
- "·" separator
- "@skillsmith" (link)

Font: Satoshi Regular, 14px
Color: #71717A
Link hover: #E07A5F
```

---

## Motion & Animation

### Page Load Sequence

```css
/* Staggered reveal - creates confidence and polish */
.hero-headline     { animation-delay: 0.1s; }
.hero-subheadline  { animation-delay: 0.2s; }
.hero-form         { animation-delay: 0.3s; }
.hero-social-proof { animation-delay: 0.5s; }

@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(24px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.fade-up {
  animation: fadeUp 0.8s cubic-bezier(0.4, 0, 0.2, 1) forwards;
  opacity: 0;
}
```

### Interaction States

**Buttons:**
```css
.cta-button {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.cta-button:hover {
  transform: scale(1.02);
  box-shadow: 0 12px 40px rgba(224, 122, 95, 0.3);
}
.cta-button:active {
  transform: scale(0.98);
}
```

**Input Focus:**
```css
.email-input:focus {
  border-color: #E07A5F;
  box-shadow: 0 0 0 3px rgba(224, 122, 95, 0.1);
  outline: none;
}
```

**Value Prop Cards:**
```css
.value-card:hover {
  transform: translateY(-4px);
}
.value-card:hover .icon {
  transform: scale(1.1);
}
```

### Background Atmosphere

```css
/* Subtle animated gradient orbs */
.hero-bg::before {
  content: '';
  position: absolute;
  top: -20%;
  left: -10%;
  width: 600px;
  height: 600px;
  background: radial-gradient(circle, rgba(224, 122, 95, 0.08) 0%, transparent 70%);
  animation: float 20s ease-in-out infinite;
}

.hero-bg::after {
  content: '';
  position: absolute;
  bottom: -10%;
  right: -10%;
  width: 400px;
  height: 400px;
  background: radial-gradient(circle, rgba(129, 178, 154, 0.05) 0%, transparent 70%);
  animation: float 25s ease-in-out infinite reverse;
}

@keyframes float {
  0%, 100% { transform: translate(0, 0); }
  50% { transform: translate(30px, -20px); }
}
```

---

## Copy & Messaging

### Hero Section

**Headline Options (choose one):**
1. "Save Hours Finding the Right Skills." ← Recommended (Optimizer focus)
2. "Find Skills That Fit. Before You Need Them."
3. "46,000 Skills. One Smart Search."

**Subheadline:**
"46,000+ Claude Code skills. Finally searchable. Get stack-aware recommendations before anyone else."

### Value Propositions

| Feature | Headline | Description |
|---------|----------|-------------|
| Semantic Search | "Search by intent" | AI-powered discovery finds skills by what they do, not just keywords |
| Quality Scores | "Trust the numbers" | 0-100 scores based on docs, tests, maintenance, and security |
| Stack-Aware | "Built for your stack" | Recommendations tailored to your project's tech and dependencies |
| One-Click Install | "Install in seconds" | Direct installation to Claude Code. Uninstall just as fast |

### Problem/Solution Copy

**Without Skillsmith:**
- Manual searches across fragmented sources
- No quality signals or verification
- Trial and error installations
- Missing skills that would save time

**With Skillsmith:**
- Semantic search across 46,000+ skills
- Quality scores you can actually trust
- Stack-aware recommendations
- Discover skills before you need them

### CTA Copy

- Primary button: "Get Early Access →"
- Secondary: "View API Docs"
- Social proof: "◉ [count] developers already signed up"
- Final CTA headline: "Join [count] developers getting early access"

### Microcopy

- Email placeholder: "Enter your email"
- Success state: "You're on the list. We'll be in touch soon."
- Error state: "Please enter a valid email address"

---

## Technical Notes for Figma Make

### Assets Needed

1. **Logo** - Skillsmith wordmark + icon (SVG)
2. **Icons** - 4 value prop icons (outlined style, 2px stroke)
3. **Fonts** - Satoshi (from Fontshare) + JetBrains Mono (Google Fonts)

### Responsive Considerations

- Hero headline: 72px → 48px → 36px (desktop → tablet → mobile)
- Value props: 4-col → 2-col → 1-col
- Email form: Horizontal → Stacked
- Comparison cards: Side-by-side → Stacked

### Accessibility

- Minimum touch targets: 44px
- Color contrast: All text meets WCAG AA
- Focus states: Visible focus rings on all interactive elements
- Form labels: Associated with inputs (even if visually hidden)

### Performance

- Lazy load anything below the fold
- Use system fonts for initial render, swap to custom fonts
- Optimize hero gradient as CSS (no images)
- Keep page weight under 500KB

---

## Brand Guidelines Summary

### Logo Usage

- **Primary:** White wordmark on dark backgrounds
- **Accent:** Coral (#E07A5F) icon element
- **Clear space:** Minimum 1x logo height on all sides
- **Minimum size:** 100px width for wordmark

### Color Application

| Use Case | Color |
|----------|-------|
| Primary CTA buttons | Coral gradient |
| Secondary buttons | Ghost (transparent + border) |
| Links | Coral (#E07A5F) |
| Success indicators | Sage green (#81B29A) |
| Body text | Light gray (#A1A1AA) |
| Headlines | White (#FAFAFA) |

### Voice & Tone Quick Reference

| Do | Don't |
|----|-------|
| "Save hours" | "Revolutionary!" |
| "Quality scores you can trust" | "Amazing quality!" |
| "46,000+ skills" | "Tons of skills" |
| "Get early access" | "Sign up now!!!" |
| Confident statements | Hedging language |

### Claude Ecosystem Alignment

- Warm color palette (coral, amber, sage)
- Professional but approachable tone
- Generous whitespace
- Technical credibility without coldness
- Dark mode as default (developer preference)

---

## Appendix: Design Inspiration References

### Primary Inspirations

1. **Linear** (linear.app) - Bold confidence, dark theme, sharp typography
2. **Raycast** (raycast.com) - Developer-focused, command palette aesthetic
3. **Vercel** (vercel.com) - Clean gradients, professional trust
4. **Warp** (warp.dev) - Terminal-native feel, modern developer tool

### Color Inspiration

- Claude/Anthropic brand warmth (coral, peach tones)
- Linear's confident dark palette
- Stripe's gradient sophistication

### Typography Inspiration

- Linear's bold headline weight
- Raycast's monospace accents
- Notion's warm, readable body text

---

*End of Design Brief*
