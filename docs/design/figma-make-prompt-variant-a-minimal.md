# Figma Make Prompt: Skillsmith Landing Page
## Variant A — Refined Minimal

A cleaner, more restrained interpretation emphasizing whitespace and typography hierarchy. Inspired by Stripe and Vercel's refined approach.

---

## Prompt

```
Create a beta signup landing page for Skillsmith, a skill discovery platform for Claude Code developers.

## Brand & Aesthetic

**Style:** Refined minimal with warm dark foundation. Maximum restraint, every element essential.
**Mood:** Quietly confident, premium developer tool, sophisticated simplicity.
**Inspiration:** Stripe's elegance, Vercel's clarity, Linear's confidence.

## Color Palette

Use an extremely restrained palette:

- Background: #09090B (deep black)
- Surface: #111113 (cards, subtle elevation)
- Border: rgba(255, 255, 255, 0.08)
- Primary accent: #E07A5F (warm coral - CTA only, used sparingly)
- Text primary: #FAFAFA
- Text secondary: #888888
- Text muted: #555555

NO secondary accent colors. Coral is the only color that isn't grayscale.

## Typography

- Font: General Sans (or Satoshi)
- Hero: 80px, weight 600, letter-spacing -0.03em
- Subheadline: 20px, weight 400, letter-spacing 0
- Body: 16px, weight 400
- Labels: 12px, weight 500, uppercase, letter-spacing 0.1em

Keep typography minimal. Large hero, generous line height, lots of breathing room.

## Page Structure

### Navigation (80px height, minimal)
- Left: "skillsmith" wordmark in lowercase, weight 500
- Right: Single text link "API →"
- No background color, just content on page background
- Very subtle bottom border on scroll

### Hero Section (full viewport height minus nav)

**Layout:** Left-aligned on desktop, generous left margin (20% of viewport)

**Overline (small label above headline):**
"BETA ACCESS" - 12px, uppercase, coral color, letter-spacing 0.1em

**Headline:**
"Find the right skills.
Faster."
- 80px, weight 600, white
- Line height 1.05
- Each sentence on its own line

**Subheadline:**
"Intelligent discovery for 46,000+ Claude Code skills. Stack-aware recommendations. Quality scores you can trust."
- 20px, weight 400, gray (#888888)
- Max-width 480px
- Margin-top 32px

**Email Capture:**
- Simple, single-line layout
- Input: transparent background, bottom border only (1px white at 20% opacity)
- Placeholder: "your@email.com"
- Button: "Request Access" - text only with arrow, coral color, no background
- Or: Minimal solid button, coral background, white text, no border-radius (sharp corners)
- Margin-top 48px

**Social proof:**
"127 developers on the waitlist"
- 14px, muted gray (#555555)
- Margin-top 16px

### Features Section (optional, minimal)

If including features, use a simple two-column text layout:

Left column header: "What you get"
Right column: 4 short bullet points, no icons
- "Semantic search across the entire skill ecosystem"
- "Quality scores based on real signals"
- "Recommendations matched to your stack"
- "One-command installation"

Text only. No cards, no icons, no decoration.

### Footer

Single line at bottom:
"skillsmith · api.skillsmith.app"
- 14px, muted gray
- Generous top margin (160px+)

## Visual Effects

**Restraint is key:**
- NO gradient orbs or glows
- NO animated backgrounds
- Subtle fade-in on load (opacity only, no transform)
- Minimal hover states (color change only, no movement)
- Button hover: slight opacity reduction or underline

**One allowed accent:**
- A single thin horizontal line (1px, coral, 60px wide) above the "BETA ACCESS" overline
- This is the only decorative element

## Layout Specifications

- Max content width: 1000px (narrower than typical)
- Hero text max-width: 600px
- Generous margins: 20% left margin on desktop
- Mobile: Full-width with 24px padding, centered text
- Section spacing: 160px+

## Design Principles for This Variant

1. **Remove everything possible** - If it's not essential, delete it
2. **Typography does the work** - Size and weight create hierarchy, not color
3. **One accent color** - Coral appears maximum 3 times on the page
4. **Sharp geometry** - Consider 0 border-radius on buttons
5. **Asymmetric layout** - Left-aligned hero feels more editorial
6. **Extreme whitespace** - When in doubt, add more space

## Do NOT include

- Icons
- Cards with backgrounds
- Multiple colors
- Decorative gradients
- Rounded corners (or minimal, 4px max)
- Busy backgrounds
- Multiple CTAs
- Navigation links beyond one
```

---

## Key Differences from Primary Design

| Element | Primary | Variant A (Minimal) |
|---------|---------|---------------------|
| Layout | Centered | Left-aligned, asymmetric |
| Colors | Coral + Sage + Amber | Coral only (grayscale otherwise) |
| Border radius | 12-16px | 0-4px (sharp) |
| Background | Gradient orbs | Solid flat color |
| Features | Icon cards | Text-only list |
| Typography | Bold weight (900) | Medium weight (600) |
| Decoration | Glows, shadows | Single thin line |
| Spacing | Standard | Extra generous |

## When to Use This Variant

- If the primary feels too "startup-y"
- For a more premium, editorial impression
- If targeting senior developers who prefer restraint
- To differentiate from typical SaaS landing pages

---

## Preview Description

*A spare, typographically-driven landing page. Deep black background, single coral accent, sharp corners, asymmetric layout. The design says "we're confident enough to not try hard." Premium developer tool aesthetic.*
