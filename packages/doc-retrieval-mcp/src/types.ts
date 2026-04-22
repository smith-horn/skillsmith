export interface ChunkMetadata {
  id: string
  filePath: string
  lineStart: number
  lineEnd: number
  headingChain: string[]
  text: string
  tokens: number
}

export interface ChunkWithVector extends ChunkMetadata {
  vector: Float32Array
}

export interface IndexState {
  lastIndexedSha: string | null
  chunkCountByFile: Record<string, number>
  lastRunAt: string
  corpusVersion: number
}

export interface SearchHit {
  id: string
  filePath: string
  lineStart: number
  lineEnd: number
  headingChain: string[]
  text: string
  score: number
}

export interface StatusInfo {
  chunkCount: number
  fileCount: number
  lastIndexedSha: string | null
  lastRunAt: string | null
  rvfPath: string
  corpusVersion: number
}
