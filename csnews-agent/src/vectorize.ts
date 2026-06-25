// ============================================================
// Vectorize Client for news_hotspots embedding storage
// ============================================================
// Vectorize requires flat number[] arrays, not number[][]
// Types are defined globally in cf-types.d.ts (ambient declarations)

import { logEvent } from './log';
import type { R2Bucket } from '@cloudflare/workers-types';
import type { Env } from './shared';

/**
 * VectorizeClient — wrapper around the Vectorize binding for news_hotspots embeddings.
 *
 * Usage:
 *   const client = new VectorizeClient(env.VECTORIZE);
 *   await client.upsert(embedding, id, { title, category });
 *   const results = await client.query(embedding, 5);
 */
export class VectorizeClient {
  private index: Vectorize | undefined;
  private env: Env | undefined;

  constructor(vectorize: Vectorize | undefined, env?: Env | undefined) {
    this.index = vectorize;
    this.env = env;
  }

  /**
   * Check if Vectorize binding is available.
   */
  isAvailable(): boolean {
    return !!this.index;
  }

  /**
   * Upsert a single embedding to Vectorize (insert or update).
   * Vectorize requires flat number[] array, not nested.
   *
   * @param embedding - 1024-dim bge-m3 vector (flat number[])
   * @param id - news_hotspots row id
   * @param metadata - optional metadata (title, category, etc.)
   */
  async upsert(
    embedding: number[],
    id: string,
    metadata?: Record<string, string | number | boolean>
  ): Promise<void> {
    if (!this.index) {
      await logEvent((this.env as any), 'warn', '[Vectorize] binding not available, skipping upsert', undefined, 'vectorize');
      return;
    }

    if (!embedding || embedding.length === 0) {
      await logEvent((this.env as any), 'warn', '[Vectorize] empty embedding, skipping upsert', undefined, 'vectorize');
      return;
    }

    const vector: VectorizeVector = {
      id,
      values: embedding, // flat number[] required by Vectorize
      metadata,
    };

    try {
      const result = await this.index.upsert([vector]);
      await logEvent((this.env as any), 'info', `[Vectorize] upserted id=${id} count=${result.count ?? 'unknown'}`, undefined, 'vectorize');
    } catch (err) {
      await logEvent((this.env as any), 'error', `[Vectorize] upsert failed for id=${id}`, { err: err as any }, 'vectorize');
      // Don't throw — Vectorize failure should not block Supabase write
    }
  }

  /**
   * Query Vectorize for similar vectors.
   *
   * @param embedding - 1024-dim bge-m3 query vector (flat number[])
   * @param topK - number of results to return (default 5)
   * @returns array of { id, score } matches
   */
  async query(embedding: number[], topK = 5): Promise<Array<{ id: string; score: number }>> {
    if (!this.index) {
      await logEvent((this.env as any), 'warn', '[Vectorize] binding not available, returning empty results', undefined, 'vectorize');
      return [];
    }

    if (!embedding || embedding.length === 0) {
      await logEvent((this.env as any), 'warn', '[Vectorize] empty query embedding, returning empty results', undefined, 'vectorize');
      return [];
    }

    try {
      const result = await this.index.query({
        vector: embedding,
        topK,
        returnMetadata: false,
      });

      return result.matches.map((match: { id: string; score: number }) => ({
        id: match.id,
        score: match.score,
      }));
    } catch (err) {
      await logEvent((this.env as any), 'error', '[Vectorize] query failed', { err: err as any }, 'vectorize');
      // Return empty on error — caller should fallback to Supabase
      return [];
    }
  }

  /**
   * Delete vectors by IDs.
   *
   * @param ids - array of news_hotspots ids to delete
   */
  async deleteByIds(ids: string[]): Promise<void> {
    if (!this.index) {
      await logEvent((this.env as any), 'warn', '[Vectorize] binding not available, skipping delete', undefined, 'vectorize');
      return;
    }

    if (!ids || ids.length === 0) {
      return;
    }

    try {
      await this.index.deleteByIds(ids);
      await logEvent((this.env as any), 'info', `[Vectorize] deleted ${ids.length} vectors`, undefined, 'vectorize');
    } catch (err) {
      await logEvent((this.env as any), 'error', '[Vectorize] deleteByIds failed', { err: err as any }, 'vectorize');
    }
  }
}
