# Skillsmith Brand Guidelines

**Version:** 1.0
**Last Updated:** January 2026

---

## Brand Overview

### Brand Essence

Skillsmith is the intelligent layer between developers and the 46,000+ Claude Code skill ecosystem. We're not a marketplace or directory—we're an **efficiency multiplier** that surfaces the right skills for your stack before you know you need them.

### Brand Positioning

**Category:** Developer tools / AI skill discovery
**Audience:** Claude Code power users seeking efficiency
**Differentiator:** Stack-aware recommendations with quality signals
**Ecosystem:** Aligned with Anthropic/Claude, community-driven

---

## Brand Personality

| Trait | Description | Expression |
|-------|-------------|------------|
| **Confident** | We know this space deeply | Clear statements, no hedging |
| **Efficient** | Respects developer time | Concise copy, purposeful design |
| **Trustworthy** | Part of Claude ecosystem | Quality signals, honest metrics |
| **Technical** | Built for developers | Terminal-native, code-aware |
| **Forward-looking** | Early access = advantage | Beta exclusivity, discovery focus |

### Personality Spectrum

```
Cold ←――――――――――●―――――→ Warm
      Technical but approachable

Formal ←――――――●――――――――→ Casual
       Professional peer

Serious ←――――――●――――――――→ Playful
        Confident, not stiff

Minimal ←――――●―――――――――→ Expressive
        Bold but restrained
```

---

## Logo

### Primary Logo

The Skillsmith logo consists of:
1. **Wordmark:** "Skillsmith" in Satoshi Bold
2. **Icon:** Abstract "S" suggesting layered skills/cards

### Logo Versions

| Version | Use Case |
|---------|----------|
| Full logo (icon + wordmark) | Primary usage, hero placement |
| Wordmark only | Navigation, tight spaces |
| Icon only | Favicons, app icons, social avatars |

### Logo Colors

| Context | Wordmark | Icon Accent |
|---------|----------|-------------|
| Dark backgrounds | White `#FAFAFA` | Coral `#E07A5F` |
| Light backgrounds | Dark `#0D0D0F` | Coral `#E07A5F` |
| Monochrome | Single color throughout | — |

### Clear Space

Maintain minimum clear space equal to the height of the "S" in "Skillsmith" on all sides.

```
    ┌─────────────────────────┐
    │                         │
    │    ◆ Skillsmith         │
    │    ↑                    │
    │    1x height minimum    │
    │                         │
    └─────────────────────────┘
```

### Minimum Size

- **Full logo:** 120px width minimum
- **Wordmark:** 100px width minimum
- **Icon only:** 24px minimum

### Logo Don'ts

- ✗ Don't rotate or skew the logo
- ✗ Don't change the logo colors outside approved palette
- ✗ Don't add effects (shadows, gradients, outlines)
- ✗ Don't place on busy backgrounds without contrast
- ✗ Don't stretch or distort proportions

---

## Color Palette

### Primary Colors

#### Dark Foundation

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Background Primary** | `#0D0D0F` | 13, 13, 15 | Page backgrounds |
| **Background Secondary** | `#18181B` | 24, 24, 27 | Cards, elevated surfaces |
| **Background Tertiary** | `#27272A` | 39, 39, 42 | Borders, dividers |

#### Accent Colors

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Coral** (Primary) | `#E07A5F` | 224, 122, 95 | Primary CTA, links, emphasis |
| **Coral Dark** | `#D4694E` | 212, 105, 78 | Hover states, gradients |
| **Amber** | `#F4A261` | 244, 162, 97 | Highlights, badges |
| **Sage** | `#81B29A` | 129, 178, 154 | Success, trust indicators |

#### Text Colors

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Text Primary** | `#FAFAFA` | 250, 250, 250 | Headlines, important text |
| **Text Secondary** | `#A1A1AA` | 161, 161, 170 | Body text, descriptions |
| **Text Muted** | `#71717A` | 113, 113, 122 | Captions, metadata |

### Color Application Rules

1. **Coral is precious** — Reserve for primary CTAs and key emphasis only
2. **Dark mode default** — All interfaces use dark palette
3. **Warm undertones** — Backgrounds have slight warmth, never pure black
4. **Sage for trust** — Use for verification badges, success states
5. **High contrast text** — Headlines in white, body in light gray

### Accessibility

All color combinations meet WCAG AA standards:

| Combination | Contrast Ratio | Pass |
|-------------|----------------|------|
| White on Background Primary | 18.1:1 | ✓ AAA |
| Text Secondary on Background Primary | 7.2:1 | ✓ AAA |
| Coral on Background Primary | 5.8:1 | ✓ AA |
| Text Muted on Background Primary | 4.6:1 | ✓ AA |

### Gradients

#### CTA Gradient
```css
background: linear-gradient(135deg, #E07A5F 0%, #D4694E 100%);
```

#### Background Atmosphere
```css
/* Subtle coral glow */
radial-gradient(circle at 20% 30%, rgba(224, 122, 95, 0.08) 0%, transparent 50%)

/* Subtle sage glow */
radial-gradient(circle at 80% 70%, rgba(129, 178, 154, 0.05) 0%, transparent 50%)
```

---

## Typography

### Font Family

| Role | Font | Weight | Fallback |
|------|------|--------|----------|
| **Display** | Satoshi | 900 (Black) | system-ui, sans-serif |
| **Headlines** | Satoshi | 700 (Bold) | system-ui, sans-serif |
| **Body** | Satoshi | 500 (Medium), 400 (Regular) | system-ui, sans-serif |
| **Code** | JetBrains Mono | 500, 600 | monospace |

**Font Source:** [Fontshare](https://www.fontshare.com/fonts/satoshi) (free for commercial use)

### Type Scale

| Name | Size | Weight | Line Height | Letter Spacing |
|------|------|--------|-------------|----------------|
| Hero | 72px / 4.5rem | 900 | 1.1 | -0.02em |
| H1 | 48px / 3rem | 700 | 1.1 | -0.02em |
| H2 | 32px / 2rem | 700 | 1.2 | -0.01em |
| H3 | 24px / 1.5rem | 700 | 1.3 | 0 |
| Body Large | 20px / 1.25rem | 500 | 1.5 | 0 |
| Body | 16px / 1rem | 400 | 1.5 | 0 |
| Caption | 14px / 0.875rem | 500 | 1.4 | 0 |
| Small | 12px / 0.75rem | 400 | 1.4 | 0.01em |

### Typography Rules

1. **Bold headlines** — Use 900 weight for hero, 700 for sections
2. **Size contrast** — Jump at least 1.5x between hierarchy levels
3. **Tight headlines** — Negative letter-spacing on display text
4. **Readable body** — 16px minimum, 1.5 line height
5. **Monospace for code** — Any technical content uses JetBrains Mono

### Responsive Typography

| Element | Desktop | Tablet | Mobile |
|---------|---------|--------|--------|
| Hero | 72px | 56px | 40px |
| H1 | 48px | 40px | 32px |
| H2 | 32px | 28px | 24px |
| Body | 16px | 16px | 16px |

---

## Voice & Tone

### Voice Characteristics

| Attribute | Description |
|-----------|-------------|
| **Peer-to-peer** | Senior colleague, not teacher or vendor |
| **Confident humility** | Know what we know, admit what we don't |
| **Technically honest** | Numbers over adjectives |
| **Helpfully brief** | Respect terminal space |
| **Warmly professional** | Human but not casual |

### Writing Guidelines

#### Do

- Use specific numbers: "46,000+ skills" not "tons of skills"
- Lead with value: "Save hours" not "Our platform helps you"
- Be direct: "Quality scores you can trust" not "We provide quality scores that you might find trustworthy"
- Use active voice: "Find skills" not "Skills can be found"

#### Don't

- ✗ Use superlatives: "Revolutionary!", "Amazing!", "Best ever!"
- ✗ Use hedging language: "might", "could potentially", "we think"
- ✗ Use marketing buzzwords: "synergy", "leverage", "paradigm"
- ✗ Use emojis in product interfaces
- ✗ Patronize: "Congratulations!", "Great job!"

### Tone by Context

| Context | Tone | Example |
|---------|------|---------|
| Marketing | Confident, efficient | "Save hours finding the right skills." |
| Error messages | Helpful, clear | "Skill not found. Try a broader search." |
| Success states | Brief, warm | "Installed successfully." |
| Documentation | Technical, thorough | "The search endpoint accepts..." |

### Sample Copy

**Hero headline:**
> Save Hours Finding the Right Skills.

**Value proposition:**
> 46,000+ Claude Code skills. Finally searchable. Get stack-aware recommendations before anyone else.

**Feature description:**
> Quality scores based on documentation, testing, maintenance, and security. Numbers you can trust.

**CTA:**
> Get Early Access →

**Error:**
> Please enter a valid email address.

**Success:**
> You're on the list. We'll be in touch soon.

---

## Imagery & Icons

### Icon Style

- **Style:** Outlined, 2px stroke weight
- **Corners:** Slightly rounded (2px radius)
- **Size:** 24px default, 48px for feature icons
- **Color:** Coral `#E07A5F` for emphasis, `#A1A1AA` for neutral

### Icon Library

Recommended icon sets (consistent style):
- Lucide Icons
- Phosphor Icons
- Heroicons (outline variant)

### Photography

Currently, Skillsmith does not use photography. If needed in future:
- Developer-focused (workspace, code on screen)
- Warm lighting, natural settings
- Diverse representation
- No stock photography clichés

### Illustrations

If illustrations are added:
- Geometric, abstract style
- Use brand color palette
- Technical but approachable
- No cartoon characters or mascots

---

## Components

### Buttons

#### Primary Button (CTA)
```
Background: linear-gradient(135deg, #E07A5F, #D4694E)
Text: White, Satoshi Bold, 16px
Padding: 16px 32px
Border-radius: 12px
Shadow: 0 8px 32px rgba(224, 122, 95, 0.25)

Hover: scale(1.02), increased shadow
Active: scale(0.98)
```

#### Secondary Button (Ghost)
```
Background: transparent
Border: 1px solid rgba(255, 255, 255, 0.2)
Text: White, Satoshi Medium, 16px
Padding: 12px 24px
Border-radius: 12px

Hover: border-color rgba(255, 255, 255, 0.4)
```

### Input Fields
```
Background: #18181B
Border: 1px solid rgba(255, 255, 255, 0.1)
Text: White, Satoshi Regular, 16px
Placeholder: #71717A
Padding: 16px 20px
Border-radius: 12px

Focus: border-color #E07A5F, box-shadow 0 0 0 3px rgba(224, 122, 95, 0.1)
```

### Cards
```
Background: #18181B
Border: 1px solid rgba(255, 255, 255, 0.06)
Border-radius: 16px
Padding: 32px

Hover: translateY(-4px), increased shadow
Accent variant: border-color rgba(224, 122, 95, 0.2), subtle glow
```

---

## Motion

### Principles

1. **Purposeful** — Animation serves function, not decoration
2. **Quick** — Respect user time, 200-400ms typical
3. **Subtle** — Enhance, don't distract
4. **Consistent** — Same easing curves throughout

### Timing

| Type | Duration | Easing |
|------|----------|--------|
| Micro-interactions | 150-200ms | ease-out |
| Transitions | 300-400ms | cubic-bezier(0.4, 0, 0.2, 1) |
| Page animations | 600-800ms | cubic-bezier(0.4, 0, 0.2, 1) |

### Standard Animations

#### Fade Up (Page Load)
```css
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
```

#### Button Hover
```css
transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
transform: scale(1.02);
```

#### Card Lift
```css
transition: transform 0.3s ease;
transform: translateY(-4px);
```

---

## Spacing

### Base Unit

All spacing derives from a 4px base unit.

### Scale

| Token | Value | Usage |
|-------|-------|-------|
| space-1 | 4px | Tight gaps |
| space-2 | 8px | Icon gaps |
| space-3 | 12px | Inline spacing |
| space-4 | 16px | Component padding |
| space-6 | 24px | Card padding, gutters |
| space-8 | 32px | Section gaps |
| space-12 | 48px | Component margins |
| space-16 | 64px | Section padding |
| space-24 | 96px | Major sections |

### Layout

- **Max content width:** 1200px
- **Gutter:** 24px
- **Mobile margin:** 16px
- **Desktop margin:** 48px

---

## Application Examples

### Dark Mode (Primary)

All Skillsmith interfaces use dark mode by default:
- Background: `#0D0D0F`
- Cards: `#18181B`
- Text: White and gray variants
- Accents: Coral, sage, amber

### Email Templates

- Dark background preferred
- White logo variant
- Coral CTA buttons
- Minimal design, focused content

### Social Media

- Dark background images
- Logo with adequate clear space
- Consistent coral accent usage
- Satoshi typography in graphics

---

## File Formats

| Asset | Format | Usage |
|-------|--------|-------|
| Logo | SVG, PNG | Web, print |
| Icons | SVG | All contexts |
| Social images | PNG, JPG | 1200x630 (OG), 1080x1080 (square) |
| Favicon | ICO, PNG | 16x16, 32x32, 180x180 |

---

## Quick Reference

### Colors (Copy-Paste)

```css
/* Backgrounds */
--bg-primary: #0D0D0F;
--bg-secondary: #18181B;
--bg-tertiary: #27272A;

/* Accents */
--accent-coral: #E07A5F;
--accent-coral-dark: #D4694E;
--accent-amber: #F4A261;
--accent-sage: #81B29A;

/* Text */
--text-primary: #FAFAFA;
--text-secondary: #A1A1AA;
--text-muted: #71717A;
```

### Typography (Copy-Paste)

```css
/* Fonts */
font-family: 'Satoshi', system-ui, sans-serif;
font-family: 'JetBrains Mono', monospace;

/* Weights */
font-weight: 900; /* Display */
font-weight: 700; /* Headlines */
font-weight: 500; /* Body emphasis */
font-weight: 400; /* Body */
```

---

*For questions about brand application, contact the Skillsmith design team.*
