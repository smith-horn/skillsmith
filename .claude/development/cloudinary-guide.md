# Cloudinary Image Workflow

Blog images are hosted on Cloudinary for automatic format conversion (AVIF/WebP), quality optimization, and responsive sizing.

## Quick Start

```bash
# 1. Generate images into docs/articles/tmp/
# 2. Upload to Cloudinary
varlock run -- node scripts/upload-blog-images.mjs <article-slug> docs/articles/tmp

# 3. Copy URLs from script output into your blog markdown
```

The script uploads all images in the directory to `blog/{slug}/` on Cloudinary and prints optimized URLs.

## Folder Convention

| Cloudinary Path | Content |
|----------------|---------|
| `blog/{slug}/` | Blog article images (e.g., `blog/security/defense-layers`) |

Local workflow:

1. `docs/articles/tmp/` - working directory for image generation
2. Upload via script
3. Archive originals or delete tmp files after upload

## URL Transform Cheat Sheet

Base URL: `https://res.cloudinary.com/diqcbcmaq/image/upload/{transforms}/{public_id}`

| Use Case | Transforms | Example Width |
|----------|-----------|---------------|
| Blog body | `f_auto,q_auto,w_1200` | 1200px |
| Mobile | `f_auto,q_auto,w_600` | 600px |
| OG / social card | `f_auto,q_auto,w_1200,h_630,c_fill` | 1200x630 |
| Retina blog | `f_auto,q_auto,w_2400` | 2400px (2x) |
| Thumbnail | `f_auto,q_auto,w_400,h_300,c_fill` | 400x300 |
| Original (no transform) | (none) | Full size |

Key transforms:

- `f_auto` - serves AVIF/WebP/PNG based on browser `Accept` header
- `q_auto` - perceptual quality optimization (~40-60% size reduction)
- `w_N` - scale width to N pixels (aspect ratio preserved unless `c_fill`)
- `c_fill` - crop to exact dimensions (use with `w_` and `h_`)

## Upload Script Reference

```bash
varlock run -- node scripts/upload-blog-images.mjs <slug> <dir>
```

**Arguments:**

- `slug` - article identifier, becomes the Cloudinary folder name (e.g., `security`)
- `dir` - local directory containing images to upload

**Outputs:**

- Prints blog and OG URLs for each image
- Saves `cloudinary-metadata.json` in the source directory (tracks public IDs, dimensions, sizes)

**Supported formats:** PNG, JPG, JPEG, WebP, AVIF

**Requirements:** `CLOUDINARY_URL` env var (injected by varlock)

## Astro Configuration

`res.cloudinary.com` is intentionally **excluded** from `packages/website/astro.config.mjs` `image.domains` and `image.remotePatterns`. This lets Cloudinary URLs pass through as plain `<img>` tags, preserving Cloudinary's CDN delivery (`f_auto`, `q_auto`, edge caching). If Cloudinary were listed in those configs, Astro would download and re-encode images into local `/_astro/*.webp` files at build time, defeating Cloudinary's optimizations and adding seconds per page to the build.

## Markdown Usage

```markdown
![Alt text](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/{slug}/{name})
```

For OG images in frontmatter:

```yaml
ogImage: "https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200,h_630,c_fill/blog/{slug}/{name}"
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| 401 Unauthorized | Check `CLOUDINARY_URL` is set. Run via `varlock run --` |
| Image not loading in Astro | Verify the Cloudinary URL is a valid `https://res.cloudinary.com/...` path. Do NOT add Cloudinary to `astro.config.mjs` `image.domains` — see Astro Configuration section above |
| Wrong quality / too large | Adjust `q_auto` to `q_auto:low` or `q_auto:eco` for smaller files |
| Image too blurry on retina | Use `w_2400` (2x) with `srcset` or serve original width |
| Upload overwrites existing | Script uses `overwrite: true` by default. Use a different slug to avoid |
