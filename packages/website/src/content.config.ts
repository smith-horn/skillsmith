import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'

/**
 * Blog collection schema
 * SMI-1728: Blog system implementation
 * Astro 6: Migrated from legacy content config to Content Layer API with glob loader
 */
const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    author: z.string().default('Skillsmith Team'),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    category: z
      .enum(['Guides', 'Tutorials', 'Case Studies', 'News', 'Engineering'])
      .default('Guides'),
    tags: z.array(z.string()).default([]),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
    ogImage: z.string().optional(),
    schemaType: z.enum(['HowTo', 'FAQ']).optional(),
    howToSteps: z.array(z.object({ name: z.string(), text: z.string() })).optional(),
  }),
})

export const collections = { blog }
