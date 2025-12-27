/**
 * SMI-586: install_skill MCP Tool
 * Downloads and installs skills from GitHub
 */

import { z } from 'zod';
import { SecurityScanner, type ScanReport } from '@skillsmith/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Input schema
export const installInputSchema = z.object({
  skillId: z.string().min(1).describe('Skill ID or GitHub URL'),
  force: z.boolean().default(false).describe('Force reinstall if exists'),
  skipScan: z.boolean().default(false).describe('Skip security scan (not recommended)'),
});

export type InstallInput = z.infer<typeof installInputSchema>;

// Output type
export interface InstallResult {
  success: boolean;
  skillId: string;
  installPath: string;
  securityReport?: ScanReport;
  tips?: string[];
  error?: string;
}

// Paths
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const SKILLSMITH_DIR = path.join(os.homedir(), '.skillsmith');
const MANIFEST_PATH = path.join(SKILLSMITH_DIR, 'manifest.json');

interface SkillManifest {
  version: string;
  installedSkills: Record<string, {
    id: string;
    name: string;
    version: string;
    source: string;
    installPath: string;
    installedAt: string;
    lastUpdated: string;
  }>;
}

/**
 * Load or create manifest
 */
async function loadManifest(): Promise<SkillManifest> {
  try {
    const content = await fs.readFile(MANIFEST_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {
      version: '1.0.0',
      installedSkills: {},
    };
  }
}

/**
 * Save manifest
 */
async function saveManifest(manifest: SkillManifest): Promise<void> {
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

/**
 * Parse skill ID or URL to get components
 */
function parseSkillId(input: string): { owner: string; repo: string; path: string } {
  // Handle full GitHub URLs
  if (input.startsWith('https://github.com/')) {
    const url = new URL(input);
    const parts = url.pathname.split('/').filter(Boolean);
    return {
      owner: parts[0],
      repo: parts[1],
      path: parts.slice(2).join('/') || '',
    };
  }
  
  // Handle owner/repo format
  if (input.includes('/')) {
    const [owner, ...rest] = input.split('/');
    const repo = rest[0];
    const skillPath = rest.slice(1).join('/');
    return { owner, repo, path: skillPath };
  }
  
  // Handle skill ID from registry
  throw new Error('Invalid skill ID format: ' + input + '. Use owner/repo or GitHub URL.');
}

/**
 * Fetch file from GitHub
 */
async function fetchFromGitHub(owner: string, repo: string, filePath: string): Promise<string> {
  const url = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/main/' + filePath;
  const response = await fetch(url);
  
  if (!response.ok) {
    // Try master branch
    const masterUrl = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/master/' + filePath;
    const masterResponse = await fetch(masterUrl);
    
    if (!masterResponse.ok) {
      throw new Error('Failed to fetch ' + filePath + ': ' + response.status);
    }
    
    return masterResponse.text();
  }
  
  return response.text();
}

/**
 * Validate SKILL.md content
 */
function validateSkillMd(content: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Check for required sections
  if (!content.includes('# ')) {
    errors.push('Missing title (# heading)');
  }
  
  // Check minimum length
  if (content.length < 100) {
    errors.push('SKILL.md is too short (minimum 100 characters)');
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Generate post-install tips
 */
function generateTips(skillName: string): string[] {
  return [
    'Skill "' + skillName + '" installed successfully!',
    'To use this skill, mention it in Claude Code: "Use the ' + skillName + ' skill to..."',
    'View installed skills: ls ~/.claude/skills/',
    'To uninstall: use the uninstall_skill tool',
  ];
}

/**
 * Install a skill from GitHub
 */
export async function installSkill(input: InstallInput): Promise<InstallResult> {
  const scanner = new SecurityScanner();
  
  try {
    // Parse skill ID
    const { owner, repo, path: skillPath } = parseSkillId(input.skillId);
    const skillName = skillPath ? path.basename(skillPath) : repo;
    const installPath = path.join(CLAUDE_SKILLS_DIR, skillName);
    
    // Check if already installed
    const manifest = await loadManifest();
    if (manifest.installedSkills[skillName] && !input.force) {
      return {
        success: false,
        skillId: input.skillId,
        installPath,
        error: 'Skill "' + skillName + '" is already installed. Use force=true to reinstall.',
      };
    }
    
    // Determine files to fetch
    const basePath = skillPath ? skillPath + '/' : '';
    const skillMdPath = basePath + 'SKILL.md';
    
    // Fetch SKILL.md (required)
    let skillMdContent: string;
    try {
      skillMdContent = await fetchFromGitHub(owner, repo, skillMdPath);
    } catch {
      return {
        success: false,
        skillId: input.skillId,
        installPath,
        error: 'Could not find SKILL.md at ' + skillMdPath + '. Skills must have a SKILL.md file.',
      };
    }
    
    // Validate SKILL.md
    const validation = validateSkillMd(skillMdContent);
    if (!validation.valid) {
      return {
        success: false,
        skillId: input.skillId,
        installPath,
        error: 'Invalid SKILL.md: ' + validation.errors.join(', '),
      };
    }
    
    // Security scan
    let securityReport: ScanReport | undefined;
    if (!input.skipScan) {
      securityReport = scanner.scan(input.skillId, skillMdContent);
      
      if (!securityReport.passed) {
        const criticalFindings = securityReport.findings.filter(
          f => f.severity === 'critical' || f.severity === 'high'
        );
        return {
          success: false,
          skillId: input.skillId,
          installPath,
          securityReport,
          error: 'Security scan failed with ' + criticalFindings.length + ' critical/high findings. Use skipScan=true to override (not recommended).',
        };
      }
    }
    
    // Create installation directory
    await fs.mkdir(installPath, { recursive: true });
    
    // Write SKILL.md
    await fs.writeFile(path.join(installPath, 'SKILL.md'), skillMdContent);
    
    // Try to fetch optional files
    const optionalFiles = ['README.md', 'examples.md', 'config.json'];
    for (const file of optionalFiles) {
      try {
        const content = await fetchFromGitHub(owner, repo, basePath + file);
        
        // Scan optional files too
        if (!input.skipScan) {
          const fileScan = scanner.scan(input.skillId + '/' + file, content);
          if (!fileScan.passed) {
            console.warn('Skipping ' + file + ' due to security findings');
            continue;
          }
        }
        
        await fs.writeFile(path.join(installPath, file), content);
      } catch {
        // Optional files are fine to skip
      }
    }
    
    // Update manifest
    manifest.installedSkills[skillName] = {
      id: input.skillId,
      name: skillName,
      version: '1.0.0',
      source: 'github:' + owner + '/' + repo,
      installPath,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
    await saveManifest(manifest);
    
    return {
      success: true,
      skillId: input.skillId,
      installPath,
      securityReport,
      tips: generateTips(skillName),
    };
  } catch (error) {
    return {
      success: false,
      skillId: input.skillId,
      installPath: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * MCP tool definition
 */
export const installTool = {
  name: 'install_skill',
  description: 'Install a Claude Code skill from GitHub. Performs security scan before installation.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillId: {
        type: 'string',
        description: 'Skill ID (owner/repo/skill) or GitHub URL',
      },
      force: {
        type: 'boolean',
        description: 'Force reinstall if skill already exists',
      },
      skipScan: {
        type: 'boolean',
        description: 'Skip security scan (not recommended)',
      },
    },
    required: ['skillId'],
  },
};

export default installTool;
