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
  put(key: string, value: string | ReadableStream | ArrayBuffer | Blob, options?: any): Promise<any>;
  get(key: string): Promise<any>;
  list(options?: any): Promise<any>;
  delete(key: string): Promise<void>;
}
