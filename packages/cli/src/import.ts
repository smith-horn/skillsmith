#!/usr/bin/env node
/**
 * SMI-580: GitHub Skill Import Script
 *
 * Discovers and imports Claude skills from GitHub:
 * - Searches for repos with topic:claude-skill
 * - Extracts metadata from SKILL.md files
 * - Handles rate limiting with exponential backoff
 * - Supports batch import of 1000+ skills
 */

import { createDatabase, SkillRepository, type SkillCreateInput } from '@skillsmith/core';

interface GitHubSearchResult {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubRepo[];
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  owner: {
    login: string;
  };
  stargazers_count: number;
  topics: string[];
  created_at: string;
  updated_at: string;
}

interface ImportOptions {
  token?: string;
  topic?: string;
  maxSkills?: number;
  dbPath?: string;
  verbose?: boolean;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: number;
  duration: number;
}

const DEFAULT_TOPIC = 'claude-skill';
const GITHUB_API = 'https://api.github.com';
const MAX_PER_PAGE = 100;
const RATE_LIMIT_DELAY = 60000; // 1 minute

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
function getBackoffDelay(attempt: number, baseDelay: number = 1000): number {
  return Math.min(baseDelay * Math.pow(2, attempt), 30000);
}

/**
 * Fetch from GitHub API with authentication and rate limiting
 */
async function fetchGitHub<T>(
  url: string,
  token?: string,
  retries: number = 3
): Promise<T> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers });

      // Handle rate limiting
      if (response.status === 403) {
        const resetTime = response.headers.get('X-RateLimit-Reset');
        if (resetTime) {
          const waitTime = Math.max(0, parseInt(resetTime) * 1000 - Date.now());
          console.log(`Rate limited. Waiting ${Math.ceil(waitTime / 1000)}s...`);
          await sleep(Math.min(waitTime, RATE_LIMIT_DELAY));
          continue;
        }
      }

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      return await response.json() as T;
    } catch (error) {
      if (attempt < retries) {
        const delay = getBackoffDelay(attempt);
        console.log(`Request failed, retrying in ${delay}ms...`);
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }

  throw new Error('Max retries exceeded');
}

/**
 * Fetch SKILL.md content from a repository
 */
async function fetchSkillMd(
  repo: GitHubRepo,
  token?: string
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${repo.full_name}/contents/SKILL.md`;

  try {
    const response = await fetchGitHub<{ content: string; encoding: string }>(url, token);
    if (response.encoding === 'base64') {
      return Buffer.from(response.content, 'base64').toString('utf-8');
    }
    return response.content;
  } catch {
    return null;
  }
}

/**
 * Parse SKILL.md content to extract metadata
 */
function parseSkillMd(content: string): Partial<SkillCreateInput> {
  const metadata: Partial<SkillCreateInput> = {};

  // Extract name from first heading
  const nameMatch = content.match(/^#\s+(.+)$/m);
  if (nameMatch?.[1]) {
    metadata.name = nameMatch[1].trim();
  }

  // Extract description from first paragraph after heading
  const descMatch = content.match(/^#\s+.+\n+([^#\n].+)/m);
  if (descMatch?.[1]) {
    metadata.description = descMatch[1].trim();
  }

  // Extract tags from frontmatter or inline
  const tagsMatch = content.match(/tags:\s*\[([^\]]+)\]/);
  if (tagsMatch?.[1]) {
    metadata.tags = tagsMatch[1].split(',').map(t => t.trim().replace(/["']/g, ''));
  }

  // Extract author from frontmatter
  const authorMatch = content.match(/author:\s*["']?([^"'\n]+)["']?/);
  if (authorMatch?.[1]) {
    metadata.author = authorMatch[1].trim();
  }

  return metadata;
}

/**
 * Calculate quality score based on repo metrics
 */
function calculateQualityScore(repo: GitHubRepo, hasSkillMd: boolean): number {
  let score = 0;

  // Stars contribute up to 0.3
  score += Math.min(repo.stargazers_count / 100, 0.3);

  // Has SKILL.md contributes 0.3
  if (hasSkillMd) score += 0.3;

  // Has description contributes 0.1
  if (repo.description) score += 0.1;

  // Has topics contributes 0.1
  if (repo.topics.length > 1) score += 0.1;

  // Recent activity contributes 0.2
  const daysSinceUpdate = (Date.now() - new Date(repo.updated_at).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate < 30) score += 0.2;
  else if (daysSinceUpdate < 90) score += 0.1;

  return Math.min(score, 1);
}

/**
 * Search for Claude skill repositories on GitHub
 */
async function searchSkillRepos(
  topic: string,
  token?: string,
  maxResults: number = 1000
): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let page = 1;

  while (repos.length < maxResults) {
    const url = `${GITHUB_API}/search/repositories?q=topic:${topic}&sort=stars&order=desc&per_page=${MAX_PER_PAGE}&page=${page}`;

    try {
      const result = await fetchGitHub<GitHubSearchResult>(url, token);

      if (result.items.length === 0) break;

      repos.push(...result.items);

      console.log(`Found ${repos.length}/${result.total_count} repositories...`);

      if (repos.length >= result.total_count) break;

      page++;

      // Rate limit protection
      await sleep(1000);
    } catch (error) {
      console.error('Search error:', error);
      break;
    }
  }

  return repos.slice(0, maxResults);
}

/**
 * Import skills from GitHub into the database
 */
export async function importSkills(options: ImportOptions = {}): Promise<ImportResult> {
  const {
    token = process.env['GITHUB_TOKEN'],
    topic = DEFAULT_TOPIC,
    maxSkills = 1000,
    dbPath = 'skillsmith.db',
    verbose = false
  } = options;

  const startTime = Date.now();
  const result: ImportResult = {
    imported: 0,
    skipped: 0,
    errors: 0,
    duration: 0
  };

  // Initialize database
  const db = createDatabase(dbPath);
  const skillRepo = new SkillRepository(db);

  console.log(`Searching for repositories with topic: ${topic}...`);

  try {
    // Search for skill repositories
    const repos = await searchSkillRepos(topic, token, maxSkills);
    console.log(`\nProcessing ${repos.length} repositories...`);

    // Prepare batch import
    const skills: SkillCreateInput[] = [];

    for (const repo of repos) {
      try {
        // Check if already imported
        if (skillRepo.findByRepoUrl(repo.html_url)) {
          result.skipped++;
          if (verbose) console.log(`Skipped (exists): ${repo.full_name}`);
          continue;
        }

        // Try to fetch SKILL.md
        const skillMd = await fetchSkillMd(repo, token);
        const skillMdMeta = skillMd ? parseSkillMd(skillMd) : {};

        // Build skill data
        const skill: SkillCreateInput = {
          name: skillMdMeta.name || repo.name,
          description: skillMdMeta.description || repo.description || null,
          author: skillMdMeta.author || repo.owner.login,
          repoUrl: repo.html_url,
          qualityScore: calculateQualityScore(repo, !!skillMd),
          trustTier: skillMd ? 'community' : 'experimental',
          tags: skillMdMeta.tags || repo.topics
        };

        skills.push(skill);

        if (verbose) {
          console.log(`Prepared: ${skill.name} (${repo.full_name})`);
        }

        // Rate limit protection
        await sleep(100);
      } catch (error) {
        result.errors++;
        console.error(`Error processing ${repo.full_name}:`, error);
      }
    }

    // Batch insert all skills
    if (skills.length > 0) {
      console.log(`\nImporting ${skills.length} skills...`);
      const imported = skillRepo.createBatch(skills);
      result.imported = imported.length;
      console.log(`Successfully imported ${result.imported} skills`);
    }

  } finally {
    db.close();
  }

  result.duration = Date.now() - startTime;

  console.log(`\n--- Import Complete ---`);
  console.log(`Imported: ${result.imported}`);
  console.log(`Skipped: ${result.skipped}`);
  console.log(`Errors: ${result.errors}`);
  console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);

  return result;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const maxSkills = parseInt(args.find(a => a.startsWith('--max='))?.split('=')[1] || '1000');
  const dbPath = args.find(a => a.startsWith('--db='))?.split('=')[1] || 'skillsmith.db';

  importSkills({ verbose, maxSkills, dbPath })
    .then(result => {
      process.exit(result.errors > 0 ? 1 : 0);
    })
    .catch(error => {
      console.error('Import failed:', error);
      process.exit(1);
    });
}
