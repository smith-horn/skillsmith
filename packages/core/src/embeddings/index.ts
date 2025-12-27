/**
 * SMI-584: Semantic Embeddings Service
 * Uses all-MiniLM-L6-v2 model for fast, accurate skill embeddings
 */

import { pipeline } from '@xenova/transformers';
import Database from 'better-sqlite3';

// Type for feature extraction pipeline output
type FeatureExtractionPipeline = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;

export interface EmbeddingResult {
  skillId: string;
  embedding: Float32Array;
  text: string;
}

export interface SimilarityResult {
  skillId: string;
  score: number;
}

export class EmbeddingService {
  private model: FeatureExtractionPipeline | null = null;
  private modelPromise: Promise<FeatureExtractionPipeline> | null = null;
  private db: Database.Database | null = null;
  private readonly modelName = 'Xenova/all-MiniLM-L6-v2';
  private readonly embeddingDim = 384;

  constructor(dbPath?: string) {
    if (dbPath) {
      this.db = new Database(dbPath);
      this.initEmbeddingTable();
    }
  }

  private initEmbeddingTable(): void {
    if (!this.db) return;
    
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_embeddings (
        skill_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
    
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_skill 
      ON skill_embeddings(skill_id)
    `);
  }

  /**
   * Lazily load the embedding model
   */
  async loadModel(): Promise<FeatureExtractionPipeline> {
    if (this.model) return this.model;

    if (!this.modelPromise) {
      this.modelPromise = pipeline('feature-extraction', this.modelName, {
        quantized: true, // Use quantized model for faster inference
      }) as Promise<FeatureExtractionPipeline>;
    }

    this.model = await this.modelPromise;
    return this.model;
  }

  /**
   * Generate embedding for a single text
   */
  async embed(text: string): Promise<Float32Array> {
    const model = await this.loadModel();
    
    // Truncate text if too long (model max is 256 tokens)
    const truncated = text.slice(0, 1000);
    
    const output = await model(truncated, {
      pooling: 'mean',
      normalize: true,
    });
    
    // Extract embedding data
    const embedding = new Float32Array(this.embeddingDim);
    for (let i = 0; i < this.embeddingDim; i++) {
      embedding[i] = output.data[i];
    }
    
    return embedding;
  }

  /**
   * Batch embed multiple texts efficiently
   */
  async embedBatch(texts: Array<{ id: string; text: string }>): Promise<EmbeddingResult[]> {
    await this.loadModel();
    const results: EmbeddingResult[] = [];
    
    // Process in batches of 32 for efficiency
    const batchSize = 32;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      
      for (const { id, text } of batch) {
        const embedding = await this.embed(text);
        results.push({
          skillId: id,
          embedding,
          text,
        });
      }
    }
    
    return results;
  }

  /**
   * Store embedding in SQLite cache
   */
  storeEmbedding(skillId: string, embedding: Float32Array, text: string): void {
    if (!this.db) return;
    
    const buffer = Buffer.from(embedding.buffer);
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO skill_embeddings (skill_id, embedding, text, created_at)
      VALUES (?, ?, ?, unixepoch())
    `);
    
    stmt.run(skillId, buffer, text);
  }

  /**
   * Retrieve cached embedding
   */
  getEmbedding(skillId: string): Float32Array | null {
    if (!this.db) return null;
    
    const stmt = this.db.prepare(`
      SELECT embedding FROM skill_embeddings WHERE skill_id = ?
    `);
    
    const row = stmt.get(skillId) as { embedding: Buffer } | undefined;
    if (!row) return null;
    
    return new Float32Array(row.embedding.buffer.slice(
      row.embedding.byteOffset,
      row.embedding.byteOffset + row.embedding.byteLength
    ));
  }

  /**
   * Get all cached embeddings
   */
  getAllEmbeddings(): Map<string, Float32Array> {
    if (!this.db) return new Map();
    
    const stmt = this.db.prepare(`
      SELECT skill_id, embedding FROM skill_embeddings
    `);
    
    const rows = stmt.all() as Array<{ skill_id: string; embedding: Buffer }>;
    const result = new Map<string, Float32Array>();
    
    for (const row of rows) {
      const embedding = new Float32Array(row.embedding.buffer.slice(
        row.embedding.byteOffset,
        row.embedding.byteOffset + row.embedding.byteLength
      ));
      result.set(row.skill_id, embedding);
    }
    
    return result;
  }

  /**
   * Compute cosine similarity between two embeddings
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error('Embeddings must have same dimension');
    }
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Find most similar skills to a query embedding
   */
  findSimilar(
    queryEmbedding: Float32Array,
    topK: number = 10
  ): SimilarityResult[] {
    const allEmbeddings = this.getAllEmbeddings();
    const results: SimilarityResult[] = [];
    
    for (const [skillId, embedding] of allEmbeddings) {
      const score = this.cosineSimilarity(queryEmbedding, embedding);
      results.push({ skillId, score });
    }
    
    // Sort by similarity score descending
    results.sort((a, b) => b.score - a.score);
    
    return results.slice(0, topK);
  }

  /**
   * Pre-compute embeddings for all skills in database
   */
  async precomputeEmbeddings(
    skills: Array<{ id: string; name: string; description: string }>
  ): Promise<number> {
    let count = 0;
    
    for (const skill of skills) {
      // Check if already cached
      const existing = this.getEmbedding(skill.id);
      if (existing) continue;
      
      // Create text representation for embedding
      const text = `${skill.name} ${skill.description}`;
      const embedding = await this.embed(text);
      
      this.storeEmbedding(skill.id, embedding, text);
      count++;
    }
    
    return count;
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export default EmbeddingService;
