#!/usr/bin/env node

/**
 * Upload blog images to Cloudinary with optimized transforms.
 *
 * Usage:
 *   varlock run -- node scripts/upload-blog-images.mjs <article-slug> <local-dir>
 *
 * Example:
 *   varlock run -- node scripts/upload-blog-images.mjs security docs/articles/tmp
 *
 * Requires CLOUDINARY_URL env var (auto-configured by varlock).
 */

import { v2 as cloudinary } from 'cloudinary';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';

const CLOUD_NAME = 'diqcbcmaq';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif']);

function usage() {
  console.error('Usage: node scripts/upload-blog-images.mjs <article-slug> <local-dir>');
  console.error('Example: node scripts/upload-blog-images.mjs security docs/articles/tmp');
  process.exit(1);
}

const [slug, localDir] = process.argv.slice(2);
if (!slug || !localDir) usage();

if (!process.env.CLOUDINARY_URL) {
  console.error('Error: CLOUDINARY_URL not set. Run via: varlock run -- node scripts/upload-blog-images.mjs ...');
  process.exit(1);
}

// cloudinary auto-configures from CLOUDINARY_URL env var

async function getImageFiles(dir) {
  const entries = await readdir(dir);
  const images = [];
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const filePath = join(dir, entry);
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) {
      images.push({ path: filePath, name: basename(entry, ext), ext, size: fileStat.size });
    }
  }
  return images.sort((a, b) => a.name.localeCompare(b.name));
}

async function uploadImage(filePath, publicId) {
  return cloudinary.uploader.upload(filePath, {
    public_id: publicId,
    folder: `blog/${slug}`,
    overwrite: true,
    resource_type: 'image',
  });
}

function buildUrl(publicId, transforms) {
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${transforms}/${publicId}`;
}

async function main() {
  const images = await getImageFiles(localDir);
  if (images.length === 0) {
    console.error(`No images found in ${localDir}`);
    process.exit(1);
  }

  console.log(`Found ${images.length} images in ${localDir}\n`);

  const metadata = [];

  for (const image of images) {
    process.stdout.write(`Uploading ${image.name}${image.ext}...`);
    const publicId = image.name;
    const result = await uploadImage(image.path, publicId);
    console.log(` done (${result.width}x${result.height})`);

    const fullPublicId = result.public_id;
    const entry = {
      name: `${image.name}${image.ext}`,
      publicId: fullPublicId,
      format: result.format,
      width: result.width,
      height: result.height,
      bytes: result.bytes,
      originalBytes: image.size,
      url: {
        original: result.secure_url,
        blog: buildUrl(fullPublicId, 'f_auto,q_auto,w_1200'),
        og: buildUrl(fullPublicId, 'f_auto,q_auto,w_1200,h_630,c_fill'),
        mobile: buildUrl(fullPublicId, 'f_auto,q_auto,w_600'),
        thumbnail: buildUrl(fullPublicId, 'f_auto,q_auto,w_400,h_300,c_fill'),
      },
    };
    metadata.push(entry);
  }

  // Save metadata
  const metadataPath = join(localDir, 'cloudinary-metadata.json');
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  console.log(`\nMetadata saved to ${metadataPath}\n`);

  // Print summary
  console.log('=== Blog Image URLs (f_auto,q_auto,w_1200) ===\n');
  for (const entry of metadata) {
    console.log(`${entry.name}:`);
    console.log(`  ${entry.url.blog}`);
    console.log();
  }

  console.log('=== OG Image URLs (f_auto,q_auto,w_1200,h_630,c_fill) ===\n');
  for (const entry of metadata) {
    console.log(`${entry.name}:`);
    console.log(`  ${entry.url.og}`);
    console.log();
  }

  const totalOriginal = metadata.reduce((sum, e) => sum + e.originalBytes, 0);
  const totalUploaded = metadata.reduce((sum, e) => sum + e.bytes, 0);
  console.log(`Total: ${images.length} images uploaded`);
  console.log(`Original size: ${(totalOriginal / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Cloudinary size: ${(totalUploaded / 1024 / 1024).toFixed(1)} MB (before client transforms)`);
}

main().catch((err) => {
  console.error('Upload failed:', err.message);
  process.exit(1);
});
