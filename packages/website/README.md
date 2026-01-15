# @skillsmith/website

Beta landing page and marketing website for Skillsmith.

## Quick Start

### Preview Landing Page

```bash
# Open directly in browser
open packages/website/public/beta.html

# Or serve locally
cd packages/website/public && python3 -m http.server 8080
# Visit http://localhost:8080/beta.html
```

### Development

```bash
# Install dependencies
npm install

# Start development server (Astro)
npm run dev

# Build for production
npm run build
```

## Landing Page

The beta landing page (`public/beta.html`) is a standalone HTML file designed for email capture before launch.

### Features

- **Hero Section**: "Save Hours Finding the Right Skills."
- **Email Capture**: Form for early access signups
- **Value Props**: Semantic Search, Quality Scores, Stack-Aware, One-Click Install
- **Problem/Solution**: Comparison of with/without Skillsmith
- **Social Proof**: Developer signup counter

### Design Specifications

| Element | Value |
|---------|-------|
| Background | `#0D0D0F` (near-black) |
| Primary Accent | `#E07A5F` (coral) |
| Success/Trust | `#81B29A` (sage) |
| Font | Satoshi (400, 500, 700, 900) |
| Logo | Neural S (concept 3) |

See full design documentation:
- [Landing Page Design Brief](../../docs/design/landing-page-design-brief.md)
- [Brand Guidelines](../../docs/design/brand_guidelines.md)
- [Figma Make Prompt](../../docs/design/figma-make-prompt.md)

## Project Structure

```
packages/website/
├── public/
│   ├── beta.html          # Standalone landing page
│   ├── logo-icon.svg      # Neural S favicon
│   ├── logo-wordmark.svg  # Logo with text
│   └── favicon.svg        # Default favicon
├── src/
│   ├── pages/             # Astro pages
│   ├── components/        # Reusable components
│   ├── layouts/           # Page layouts
│   └── styles/            # Global styles
├── astro.config.mjs       # Astro configuration
├── tailwind.config.mjs    # Tailwind CSS config
└── package.json
```

## Deployment

### Vercel (Recommended)

The landing page is deployed to Vercel at `skillsmith.app`.

```bash
# Deploy preview
vercel

# Deploy production
vercel --prod
```

### Static Hosting

The `public/beta.html` file can be deployed to any static host:
- Vercel
- Netlify
- GitHub Pages
- Cloudflare Pages

## Related Issues

- [SMI-1462](https://linear.app/smith-horn-group/issue/SMI-1462) - User testing for landing page
- [SMI-1463](https://linear.app/smith-horn-group/issue/SMI-1463) - Email capture service
- [SMI-1464](https://linear.app/smith-horn-group/issue/SMI-1464) - Social media handles

## Assets

Logo assets are in `docs/design/assets/concept-3-neural-s/`:
- `skillsmith-icon.svg` - 64×64 favicon
- `skillsmith-wordmark.svg` - Icon + text
- `skillsmith-logo-refined.svg` - 512×512 icon
- `skillsmith-logo-full.svg` - Full marketing lockup
