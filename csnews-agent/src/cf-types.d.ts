/**
 * Cloudflare Workers 全局类型(仅类型,无运行时)
 * 来源:@cloudflare/workers-types
 * 放在 .d.ts 里作为 ambient 声明
 */

// AI binding
interface Ai {
  run(model: string, inputs: any): Promise<any>;
}

declare namespace Ai {
  interface EmbeddingResponse {
    shape: number[];
    data: number[][];
  }
  interface TextGenerationResponse {
    response: string;
  }
}

interface R2Object {
  key: string;
  size: number;
  uploaded: Date;
}

interface R2Bucket {
  put(
    key: string,
    value: string | ReadableStream | ArrayBuffer | Blob,
    options?: any
  ): Promise<any>;
  get(key: string): Promise<any>;
  list(options?: any): Promise<any>;
  delete(key: string): Promise<void>;
}

// Vectorize binding interface (Cloudflare Workers)
// Based on @cloudflare/workers-types Vectorize binding
interface VectorizeVector {
  id: string;
  values: number[];
  metadata?: Record<string, string | number | boolean>;
}

interface VectorizeQueryResult {
  matches: Array<{
    id: string;
    score: number;
    vector?: VectorizeVector;
  }>;
}

// VectorizeAsyncMutation is returned by insert/upsert operations
interface VectorizeAsyncMutation {
  count?: number;
}

interface Vectorize {
  insert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation>;
  query(options: {
    vector: number[];
    topK: number;
    returnMetadata?: boolean;
  }): Promise<VectorizeQueryResult>;
  upsert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation>;
  deleteByIds(ids: string[]): Promise<void>;
}
