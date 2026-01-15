# Skillsmith Logo Generation Prompts for Gemini

Run these prompts using the Gemini CLI to generate logo concepts.

## Usage

```bash
# Ensure GEMINI_API_KEY is set (use varlock)
varlock run -- gemini

# Then paste the prompts below
```

---

## Primary Prompt: Skill Stack Logo

```
Generate a minimal, modern logo for "Skillsmith" - a developer tool for AI skill discovery.

CONCEPT: Three overlapping rounded rectangles arranged diagonally (stacked cards representing skills)

SPECIFICATIONS:
- Style: Clean vector, minimal, geometric
- Front card: Coral/terracotta color (#E07A5F)
- Middle card: Light gray at 50% opacity
- Back card: Darker gray at 30% opacity
- Cards offset diagonally toward upper-right
- Rounded corners (12-16px radius feel)
- Background: Pure black (#0D0D0F) or transparent
- No text, icon only
- Suitable for favicon at 32x32

AESTHETIC REFERENCES:
- Linear app logo (confident, minimal)
- Raycast logo (developer tool feel)
- Stripe's sophisticated simplicity

OUTPUT: Clean vector-style image, centered composition, high contrast
```

---

## Alternative Prompt: Command Prompt Logo

```
Generate a minimal logo for "Skillsmith" - a terminal-native developer tool.

CONCEPT: A single bold chevron/arrow (>) like a terminal prompt

SPECIFICATIONS:
- Style: Ultra-minimal, bold geometric
- Shape: Right-pointing chevron, thick stroke weight
- Color: Warm coral (#E07A5F)
- Could have subtle gradient (coral to slightly darker coral)
- Background: Pure black (#0D0D0F) or transparent
- No text, symbol only
- Clean edges, no effects or shadows

AESTHETIC REFERENCES:
- Terminal prompt symbol
- Warp terminal's confidence
- Play button energy but more angular

OUTPUT: Simple geometric mark, scalable from 16px to any size
```

---

## Alternative Prompt: Neural S Logo

```
Generate a modern logo for "Skillsmith" - an AI-powered skill discovery platform.

CONCEPT: The letter "S" constructed from connected nodes (neural network style)

SPECIFICATIONS:
- Style: Technical, connected nodes with lines
- Shape: S-curve path with 5-7 circular nodes
- Primary color: Coral (#E07A5F) for nodes
- Connection lines: White or light gray, thinner than nodes
- Some nodes can be white for contrast
- Background: Pure black (#0D0D0F) or transparent
- Modern, tech-forward feel
- Suggests AI/machine learning

AESTHETIC REFERENCES:
- Neural network visualizations
- Constellation/star map aesthetics
- OpenAI, Anthropic visual language

OUTPUT: Single mark suitable for app icon and favicon
```

---

## Wordmark Generation Prompt

```
Generate a wordmark logo for "skillsmith" (lowercase, one word).

SPECIFICATIONS:
- Font style: Modern geometric sans-serif (like Satoshi or General Sans)
- Weight: Bold to Black (700-900)
- Letter-spacing: Slightly tight (-0.01em to -0.02em)
- Color: White (#FAFAFA) on black background
- Optional: Coral (#E07A5F) accent on the dot of the 'i' or first letter
- Lowercase only
- No icons, text only
- Clean, confident, developer-appropriate

OUTPUT: Horizontal wordmark suitable for navigation bar
```

---

## Combined Logo Prompt (Icon + Wordmark)

```
Generate a complete logo for "Skillsmith" - a developer tool brand.

COMPONENTS:
1. Icon: Three overlapping rounded rectangles (skill stack)
   - Front card coral (#E07A5F), back cards gray
   - Stacked diagonally

2. Wordmark: "skillsmith" in lowercase
   - Modern geometric sans-serif, bold weight
   - White text (#FAFAFA)
   - Positioned to the right of icon

LAYOUT:
- Horizontal arrangement: icon | spacing | wordmark
- Icon and wordmark vertically centered
- Professional spacing between elements

COLORS:
- Background: Black (#0D0D0F)
- Accent: Coral (#E07A5F)
- Text: White (#FAFAFA)

AESTHETIC: Premium developer tool, confident, minimal, Linear/Raycast inspired

OUTPUT: Complete horizontal logo lockup
```

---

## Style Modifiers

Add these to any prompt for variations:

### For darker/moodier feel:
```
Add: Deep shadows, subtle glow on coral elements, more dramatic contrast
```

### For lighter/cleaner feel:
```
Add: Higher contrast, crisper edges, more whitespace around elements
```

### For more technical feel:
```
Add: Subtle grid lines in background, more geometric precision, engineering aesthetic
```

### For warmer feel:
```
Add: Slightly warmer coral tone, softer edges, more approachable
```

---

## Output Requests

After generating, request these variations:

```
Now create variations:
1. Icon only on transparent background (for favicon)
2. Icon only on black background (for social avatar)
3. White monochrome version (for dark photo overlays)
4. Full logo at 1200x630 (for OG image)
```

---

## Color Reference

| Name | Hex | RGB | Use |
|------|-----|-----|-----|
| Coral (Primary) | #E07A5F | 224, 122, 95 | Icon accent, CTAs |
| Coral Dark | #D4694E | 212, 105, 78 | Gradients, hover |
| Background | #0D0D0F | 13, 13, 15 | Dark background |
| White | #FAFAFA | 250, 250, 250 | Text, light elements |
| Gray | #A1A1AA | 161, 161, 170 | Secondary elements |
