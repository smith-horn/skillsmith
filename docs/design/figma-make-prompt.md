# Figma Make Prompt: Skillsmith Landing Page

Copy this entire prompt into Figma Make to generate the landing page design.

---

## Prompt

```
Create a beta signup landing page for Skillsmith, a skill discovery platform for Claude Code developers.

## Brand & Aesthetic

**Style:** Bold & Confident dark theme with warm accents. Think Linear meets Anthropic's warmth.
**Mood:** Professional credibility, developer-focused, efficiency-oriented.
**Tone:** Confident peer-to-peer. No marketing fluff.

## Color Palette

- Background: #0D0D0F (near-black, warm undertone)
- Card/elevated surfaces: #18181B
- Primary accent: #E07A5F (warm coral - use for CTA only)
- Secondary accent: #81B29A (sage green - trust/success indicators)
- Highlight: #F4A261 (amber - badges, emphasis)
- Primary text: #FAFAFA
- Secondary text: #A1A1AA
- Muted text: #71717A

## Typography

- Headlines: Satoshi Black (900 weight), tight letter-spacing (-0.02em)
- Body: Satoshi Medium (500 weight)
- Monospace accents: JetBrains Mono
- Hero headline: 72px
- Subheadline: 20px
- Body: 16px

## Page Structure

### Navigation (fixed, 72px height)
- Left: "Skillsmith" wordmark logo (white text, coral icon accent)
- Right: "API Docs" text link, "Get Early Access" ghost button
- Background: semi-transparent with backdrop blur

### Hero Section (centered, max-width 800px)
**Headline:** "Save Hours Finding the Right Skills."
- Satoshi Black, 72px, white (#FAFAFA)

**Subheadline:** "46,000+ Claude Code skills. Finally searchable. Get stack-aware recommendations before anyone else."
- Satoshi Medium, 20px, gray (#A1A1AA)
- Max-width 600px, centered

**Email Capture Form:**
- Horizontal layout: email input + CTA button
- Input: dark background (#18181B), subtle border, 16px padding
- Button: coral gradient (#E07A5F to #D4694E), "Get Early Access →", bold white text
- Button shadow: 0 8px 32px rgba(224, 122, 95, 0.25)
- Border radius: 12px

**Social Proof:** "◉ 247 developers already signed up" - small text below form, coral dot

### Value Props Section (4-column grid)
Four cards with icons, each containing:
1. **Semantic Search** - magnifying glass icon - "Search by intent, not keywords. AI-powered skill discovery."
2. **Quality Scores** - badge/checkmark icon - "0-100 scores based on docs, tests, maintenance, security."
3. **Stack-Aware** - layers icon - "Recommendations tailored to your project's tech stack."
4. **One-Click Install** - download icon - "Install directly to Claude Code. Uninstall just as fast."

Icon style: Outlined, 2px stroke, coral color (#E07A5F)
Card titles: Satoshi Bold, 18px, white
Card descriptions: Satoshi Regular, 14px, gray

### Problem/Solution Section
**Header:** "The skill discovery problem" - centered, 32px, white

Two comparison cards side-by-side:

**Left card "Without Skillsmith":**
- Slightly dimmed (opacity 0.7)
- Gray header label
- List with × icons: "Manual GitHub searches", "No quality signals", "Trial and error installs", "Miss skills you need"

**Right card "With Skillsmith":**
- Coral border accent, subtle glow
- Coral header label
- List with ✓ icons (sage green): "Semantic search across 46K+ skills", "Quality scores you can trust", "Stack-aware recommendations", "Discover before you need"

### Final CTA Section
**Headline:** "Join 247 developers getting early access"
- Satoshi Bold, 32px, white, centered

**Subtext:** "Be first to discover skills that fit your workflow."
- 18px, gray

**Email form:** Same as hero section

### Footer (minimal)
Single line, centered: "Skillsmith · api.skillsmith.app · @skillsmith"
- 14px, muted gray, links turn coral on hover

## Visual Effects

- Subtle gradient orbs in hero background (coral and sage, very low opacity)
- Staggered fade-up animations on page load
- Button hover: slight scale (1.02) + increased shadow
- Card hover: subtle lift (-4px translateY)
- Input focus: coral border + soft glow

## Layout Specifications

- Max content width: 1200px
- Section vertical padding: 96px
- Mobile: Stack all elements, reduce headline to 48px
- Dark mode only (no light theme toggle)

## Do NOT include

- Emojis
- Purple gradients
- Generic stock imagery
- Feature screenshots (not built yet)
- Pricing information
- Multiple CTA colors (coral only)
```

---

## Quick Reference

| Element | Specification |
|---------|--------------|
| Primary CTA | Coral gradient `#E07A5F → #D4694E` |
| Background | `#0D0D0F` |
| Headlines | Satoshi Black 900 |
| Body | Satoshi Medium 500 |
| Hero size | 72px desktop, 48px mobile |
| Border radius | 12px (buttons), 16px (cards) |
| Max width | 1200px content, 800px hero text |

---

## Assets to Upload (if available)

1. Skillsmith logo (SVG preferred)
2. Custom icons for value props (optional - can use Lucide/Phosphor)

---

## Post-Generation Checklist

- [ ] Verify coral accent is only on primary CTA
- [ ] Check text contrast meets WCAG AA
- [ ] Ensure mobile layout stacks properly
- [ ] Confirm animations are subtle, not distracting
- [ ] Test email input focus states
