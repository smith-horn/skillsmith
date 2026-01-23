import { defineCollection, z } from 'astro:content'

/**
 * Blog collection schema
 * SMI-1728: Blog system implementation
 */
const blog = defineCollection({
  type: 'content',
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
  }),
})

export const collections = { blog }
