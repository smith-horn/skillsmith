/**
 * SMI-903: DevOps-related test skill fixtures
 * Community skills for container, CI/CD, and infrastructure tools
 */

import type { TestSkillData } from './skill-types.js'

/**
 * Community skills - DevOps (6 total)
 */
export const DEVOPS_SKILLS: TestSkillData[] = [
  {
    id: 'community/docker-compose',
    name: 'docker-compose',
    description: 'Generate and manage Docker Compose configurations for development',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/docker-compose',
    qualityScore: 0.84,
    trustTier: 'community',
    tags: ['docker', 'devops', 'containers', 'compose', 'devops'],
  },
  {
    id: 'community/kubernetes-helper',
    name: 'kubernetes-helper',
    description: 'Kubernetes manifest generation and cluster management',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/kubernetes-helper',
    qualityScore: 0.81,
    trustTier: 'community',
    tags: ['kubernetes', 'k8s', 'devops', 'containers', 'devops'],
  },
  {
    id: 'community/github-actions',
    name: 'github-actions',
    description: 'GitHub Actions workflow generation and CI/CD pipelines',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/github-actions',
    qualityScore: 0.86,
    trustTier: 'community',
    tags: ['github-actions', 'ci-cd', 'automation', 'devops', 'devops'],
  },
  {
    id: 'community/terraform-helper',
    name: 'terraform-helper',
    description: 'Terraform infrastructure as code generation and best practices',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/terraform-helper',
    qualityScore: 0.79,
    trustTier: 'community',
    tags: ['terraform', 'iac', 'infrastructure', 'cloud', 'devops'],
  },
  {
    id: 'community/nginx-config',
    name: 'nginx-config',
    description: 'Nginx configuration generation for web servers and proxies',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/nginx-config',
    qualityScore: 0.75,
    trustTier: 'community',
    tags: ['nginx', 'webserver', 'proxy', 'devops', 'devops'],
  },
  {
    id: 'community/aws-helper',
    name: 'aws-helper',
    description: 'AWS service configuration and CloudFormation templates',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/aws-helper',
    qualityScore: 0.8,
    trustTier: 'community',
    tags: ['aws', 'cloud', 'cloudformation', 'infrastructure', 'devops'],
  },
]
