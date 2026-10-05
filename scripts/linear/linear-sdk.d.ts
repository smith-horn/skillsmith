/**
 * SMI-6975 — minimal type declaration for `@linear/sdk`.
 *
 * `@linear/sdk` is NOT an installed dependency anywhere in this repo (not in
 * any package.json, not even transitively -- confirmed via a repo-wide
 * search for an "@linear/sdk" directory under any node_modules, and a
 * package-lock.json grep for the same string: both came back empty).
 * This repo's maintained Linear tooling deliberately goes through
 * `scripts/linear-api.mjs` (GraphQL direct) or the MCP Linear tools instead
 * (CLAUDE.md "Linear Hygiene" § Tooling); create-warning-issues.ts is a
 * historical one-off (SMI-1179, last substantive commit in the SMI-1189 era)
 * that predates that convention and has not run since. Adding the real SDK
 * as a dependency is a package.json change, out of this gate's scope
 * (SMI-6975 owns fixing the 37 typecheck errors the new gate surfaces, not
 * dependency wiring or deciding whether this dead script should be deleted).
 *
 * So: a narrow declaration covering EXACTLY the methods and fields
 * create-warning-issues.ts reads off `LinearClient` and its return values --
 * not the real SDK's full surface, and not a blanket `any` either. Each
 * shape below is derived from how this file's own (pre-existing, unchanged)
 * code already uses it: `await x.project`/`await x.issueLabel`/`await x.issue`
 * being awaited directly is what fixes each as a Promise-returning field,
 * matching the real SDK's lazy-payload pattern.
 */
declare module '@linear/sdk' {
  // SMI-6975: exported (not just declared) because create-warning-issues.ts
  // needs to name `Project` explicitly to type its own `project` local
  // correctly as `Project | undefined` -- an ambient interface with no
  // `export` is usable only inside this declaration block, not importable.
  export interface LinearNode {
    id: string
  }
  export interface Team extends LinearNode {
    key: string
    name: string
  }
  export interface Project extends LinearNode {
    name: string
  }
  export interface IssueLabel extends LinearNode {
    name: string
  }
  export interface Issue extends LinearNode {
    identifier: string
  }
  export interface Connection<T> {
    nodes: T[]
  }

  export interface ProjectFilterInput {
    name?: { containsIgnoreCase?: string }
  }

  export class LinearClient {
    constructor(options: { apiKey: string })
    teams(): Promise<Connection<Team>>
    projects(variables?: { filter?: ProjectFilterInput }): Promise<Connection<Project>>
    createProject(input: {
      name: string
      teamIds: string[]
      description?: string
    }): Promise<{ project: Promise<Project | null> }>
    issueLabels(): Promise<Connection<IssueLabel>>
    createIssueLabel(input: {
      name: string
      teamId: string
    }): Promise<{ issueLabel: Promise<IssueLabel | null> }>
    createIssue(input: {
      title: string
      description: string
      teamId: string
      projectId: string
      priority: number
      labelIds: string[]
    }): Promise<{ issue: Promise<Issue | null> }>
  }
}
