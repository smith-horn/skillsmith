/**
 * SMI-7121: the GitHub Actions run list the deferral reconciliation reads
 * @module scripts/indexer/backfill-autochain-defer.github
 *
 * Lists every indexer-backfill.yml run created at or after a timestamp, all pages,
 * through the REST API with GH_TOKEN. Fail closed: a non-2xx status, an unparseable
 * body, an entry without an integer id or a string display_title, or more pages than
 * the cap all THROW, because an incomplete list could hide the run a claim dispatched.
 */

export interface BackfillRunRef {
  id: number
  display_title: string
}

const PER_PAGE = 100
const PAGES_MAX = 10

type FetchLike = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export async function listBackfillRunsCreatedSince(opts: {
  repo: string
  token: string
  createdSinceIso: string
  fetchImpl?: FetchLike
}): Promise<BackfillRunRef[]> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) {
    throw new Error(`GITHUB_REPOSITORY is not owner/repo: ${JSON.stringify(opts.repo)}`)
  }
  if (Number.isNaN(Date.parse(opts.createdSinceIso))) {
    throw new Error(`createdSinceIso is not a date: ${JSON.stringify(opts.createdSinceIso)}`)
  }
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const runs: BackfillRunRef[] = []
  for (let page = 1; page <= PAGES_MAX; page++) {
    const query = new URLSearchParams({
      created: `>=${opts.createdSinceIso}`,
      per_page: String(PER_PAGE),
      page: String(page),
    })
    const url = `https://api.github.com/repos/${opts.repo}/actions/workflows/indexer-backfill.yml/runs?${query.toString()}`
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!res.ok)
      throw new Error(`Listing indexer-backfill.yml runs failed: HTTP ${res.status} (page ${page})`)
    const body = (await res.json()) as { workflow_runs?: unknown }
    const list = body?.workflow_runs
    if (!Array.isArray(list)) throw new Error(`Run list page ${page} has no workflow_runs array`)
    for (const r of list as unknown[]) {
      const rec = r as { id?: unknown; display_title?: unknown } | null
      if (!rec || !Number.isSafeInteger(rec.id) || typeof rec.display_title !== 'string') {
        throw new Error(`Run list page ${page} has an incomplete entry: ${JSON.stringify(r)}`)
      }
      runs.push({ id: rec.id as number, display_title: rec.display_title })
    }
    if (list.length < PER_PAGE) return runs
  }
  throw new Error(
    `More than ${PAGES_MAX} pages of indexer-backfill.yml runs; cannot prove the list is complete`
  )
}
