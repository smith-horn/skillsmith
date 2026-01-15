# Figma Make Prompt: Skillsmith Landing Page
## Variant B — Terminal Native

A code-forward aesthetic that feels like it belongs in the terminal. Monospace typography, command-line inspired UI, technical credibility maximized. Inspired by Warp, Fig, and Raycast.

---

## Prompt

```
Create a beta signup landing page for Skillsmith, a skill discovery platform for Claude Code developers.

## Brand & Aesthetic

**Style:** Terminal-native, code-first aesthetic. The page should feel like a beautifully designed CLI tool.
**Mood:** Technical credibility, hacker-friendly, insider knowledge.
**Inspiration:** Warp terminal, Fig, Raycast, Linear's dark mode.

## Color Palette

Terminal-inspired with strategic warmth:

- Background: #0C0C0C (true terminal black)
- Surface/cards: #161616
- Border: #2A2A2A
- Primary accent: #E07A5F (warm coral - prompt symbol, CTAs)
- Secondary accent: #7DD3FC (terminal cyan - for code highlights)
- Success: #4ADE80 (terminal green)
- Text primary: #E4E4E7 (off-white, easier on eyes than pure white)
- Text secondary: #71717A
- Text muted: #52525B

## Typography

**Monospace is primary:**
- Headlines: JetBrains Mono or Fira Code, weight 700
- Body: JetBrains Mono, weight 400
- UI labels: JetBrains Mono, weight 500

**Sans-serif for specific uses:**
- Navigation wordmark: Satoshi or Inter, weight 600
- Long-form descriptions: Satoshi, weight 400 (optional)

Sizing:
- Hero: 56px monospace
- Subheadline: 18px monospace
- Body: 15px (slightly smaller for mono readability)
- Code: 14px

## Page Structure

### Navigation (64px height)
- Left: "skillsmith" in sans-serif, weight 600
- Right: Links styled like terminal commands
  - "docs" (muted)
  - "api" (muted)
  - "> join waitlist" (coral colored, with prompt symbol)
- Subtle bottom border (#2A2A2A)

### Hero Section

**Layout:** Left-aligned, mimicking terminal output

**Terminal prompt indicator:**
Show a blinking cursor or prompt symbol before headline
- "❯ " or "$ " in coral color

**Headline (styled as command output):**
```
❯ skillsmith discover

Finding the right skills.
46,000+ indexed. Zero noise.
```
- Monospace, 56px for first line
- Second and third lines at 32px
- Coral prompt symbol, white text

**Description (styled as terminal comment):**
```
# Stack-aware recommendations for Claude Code
# Quality scores based on docs, tests, maintenance
# One command to search. One to install.
```
- Monospace, 16px
- Muted gray color (#71717A)
- Each line prefixed with "#"

**Email Capture (styled as command input):**

```
❯ request-access --email [________________] [ENTER]
```

- Full-width input area styled as terminal input
- Coral prompt symbol "❯"
- Command text "request-access --email" in muted color
- Input field with underscore cursor style
- Submit button styled as [ENTER] key or simple "→"
- Monospace throughout

Alternative simpler version:
- Input: Dark background, monospace placeholder "email@domain.com"
- Button: "join_waitlist" with underscore styling, coral background

**Social proof (styled as output):**
```
✓ 247 developers queued
```
- Green checkmark, muted text
- Monospace, small size

### Features Section (styled as help output)

```
❯ skillsmith --help

COMMANDS:
  search      Semantic search across 46K+ skills
  recommend   Stack-aware suggestions for your project
  install     One-command skill installation
  score       View quality metrics (docs, tests, security)

OPTIONS:
  --stack     Auto-detect from package.json, Cargo.toml, etc.
  --verified  Filter to verified skills only
  --limit     Number of results (default: 10)
```

- Styled exactly like CLI help output
- Monospace throughout
- Command names in white/cyan
- Descriptions in muted gray
- Proper indentation and alignment

### Live Demo Section (optional)

Show a fake terminal window with example output:

```
┌─────────────────────────────────────────────────┐
│ ❯ skillsmith search "testing react components" │
│                                                 │
│ Found 23 skills (0.4s)                         │
│                                                 │
│ 1. jest-helper         Score: 94  ✓ Verified  │
│    React testing patterns and utilities        │
│                                                 │
│ 2. vitest-config       Score: 89  Community   │
│    Vitest configuration for React projects     │
│                                                 │
│ 3. testing-library     Score: 87  ✓ Verified  │
│    Testing Library best practices              │
│                                                 │
│ [Press ENTER to install #1]                    │
└─────────────────────────────────────────────────┘
```

- Terminal window chrome (rounded corners, traffic light dots)
- Subtle shadow/glow
- Cyan highlights for scores
- Green checkmarks for verified

### Footer

Styled as terminal session info:
```
skillsmith v0.1.0-beta · api.skillsmith.app · github.com/skillsmith
```
- Single line, monospace, muted
- Version number adds authenticity

## Visual Effects

**Terminal-authentic details:**
- Subtle scanline effect (very faint horizontal lines, optional)
- Blinking cursor animation on email input
- Text appears to "type" on page load (staggered character reveal, optional)
- Subtle CRT glow on terminal window demo (optional, don't overdo)

**Interactions:**
- Input focus: Coral border, cursor blink
- Button hover: Background lightens slightly
- Links: Underline on hover, terminal-style

**Background:**
- Solid black, no gradients
- Optional: Very subtle grid pattern (like graph paper, 5% opacity)

## Layout Specifications

- Max content width: 900px (narrower, like terminal width)
- Monospace line length: ~80 characters max (terminal convention)
- Left-aligned throughout
- Generous vertical spacing between "command outputs"
- Mobile: Reduce font sizes, maintain monospace aesthetic

## Component Styling

**Input field:**
```
Background: #161616
Border: 1px solid #2A2A2A
Border-radius: 4px (subtle, or 0 for sharp)
Font: JetBrains Mono, 15px
Padding: 12px 16px
Caret-color: #E07A5F
```

**Primary button:**
```
Background: #E07A5F
Color: #0C0C0C (dark text on coral)
Font: JetBrains Mono, 14px, weight 600
Padding: 12px 24px
Border-radius: 4px
Text: "ENTER" or "join_waitlist"
```

**Terminal window (for demo):**
```
Background: #0C0C0C
Border: 1px solid #2A2A2A
Border-radius: 8px (macOS style)
Box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5)
Header: 12px height with traffic light dots (red, yellow, green)
```

## Do NOT include

- Sans-serif body text (except navigation)
- Rounded, soft UI elements
- Gradients (except subtle shadows)
- Non-technical metaphors
- Marketing language ("revolutionary", "game-changing")
- Emojis (except technical symbols like ✓, ❯, →)
- Stock imagery
```

---

## Key Differences from Primary Design

| Element | Primary | Variant B (Terminal) |
|---------|---------|----------------------|
| Typography | Satoshi sans-serif | JetBrains Mono throughout |
| Layout | Centered hero | Left-aligned, terminal-style |
| UI metaphor | SaaS landing page | CLI/terminal interface |
| Colors | Warm coral + sage | Coral + cyan + green (terminal) |
| Copy style | Marketing headlines | Command-line syntax |
| Features | Icon cards | CLI help output format |
| Buttons | Rounded gradient | Sharp, keyboard-key style |
| Decorations | Gradient orbs | Terminal window chrome |

## When to Use This Variant

- If targeting hardcore CLI users and terminal enthusiasts
- To maximize technical credibility
- For differentiation from typical SaaS aesthetics
- If the product's primary interface is command-line
- To signal "built by developers, for developers"

---

## Preview Description

*A terminal-native landing page that looks like beautiful CLI output. Monospace typography throughout, command-line syntax in the copy, email capture styled as terminal input. The aesthetic says "we live in the terminal too." Maximum developer credibility.*

---

## Copy Examples for This Variant

**Headline:**
```
❯ skillsmith discover

Finding the right skills.
46,000+ indexed. Zero noise.
```

**Subheadline:**
```
# Stack-aware recommendations for Claude Code
# Quality scores you can actually trust
```

**CTA:**
```
❯ request-access --email [your@email.com] [ENTER]
```

**Social proof:**
```
✓ 247 developers in queue
```

**Features:**
```
COMMANDS:
  search      Find skills by what they do
  recommend   Get suggestions for your stack
  install     Add skills with one command
  compare     Side-by-side skill analysis
```
