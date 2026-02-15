import rss from '@astrojs/rss'
import { getCollection } from 'astro:content'
import type { APIContext } from 'astro'

/**
 * RSS Feed endpoint for the Skillsmith blog
 * SMI-2532: RSS feed implementation
 */
export async function GET(context: APIContext) {
  const posts = await getCollection('blog', ({ data }) => !data.draft)
  return rss({
    title: 'Skillsmith Blog',
    description: 'AI-powered agent skill discovery and management',
    site: context.site!,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.description,
      link: `/blog/${post.slug}/`,
      author: post.data.author,
      categories: post.data.tags,
    })),
  })
}
