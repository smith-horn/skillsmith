// SMI-5366: Wire-shape type shared by the skills browse and detail pages.
// Distinct from the camelCase `Skill` in types/index.ts (which mirrors the
// internal DB shape). This type mirrors what skills-search / skills-get return
// over the wire (snake_case API fields).
import type { TrustTierId } from '../constants/terminology'

/** Snake_case wire shape returned by skills-search / skills-get (mirrors core ApiSkill
 *  plus website-only fields). Distinct from the camelCase `Skill` in types/index.ts. */
export interface WireSkill {
  id: string
  name: string
  author?: string
  description?: string
  trust_tier?: TrustTierId
  stars?: number
  categories?: string[]
  version?: string
  repo_url?: string
  compatibility?: string[]
  license?: string | null
  /** Client-injected (not from API): set when author/topics match a user's GitHub org. */
  _orgMatch?: string
  metadata?: { topics?: string[] }
}
