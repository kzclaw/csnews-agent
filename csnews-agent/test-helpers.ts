/**
 * Generic test helper utilities for contract tests.
 * No internal codenames, version numbers, or secret keywords.
 */

import { vi } from 'vitest';

/**
 * Create a mock URL object for testing parseFilter-style functions.
 */
export function createMockUrl(params: Record<string, string>): URL {
  const url = new URL('http://localhost/');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url;
}

/**
 * Mock global.fetch for tests that need to simulate HTTP responses.
 * Returns the original fetch in afterAll.
 */
export function mockFetch(response: unknown, ok = true, status = 200): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => response,
    text: async () => JSON.stringify(response),
  } as unknown as Response);
  return () => {
    globalThis.fetch = orig;
  };
}

/**
 * Create a simple mock KV namespace that stores data in memory.
 */
export function createMockKVNamespace(prefill: Record<string, string> = {}): {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: (opts?: { prefix?: string }) => Promise<{ keys: { name: string }[] }>;
} {
  const store: Record<string, string> = { ...prefill };
  return {
    get: vi.fn().mockImplementation(async (key: string) => store[key] ?? null),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      store[key] = value;
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      delete store[key];
    }),
    list: vi.fn().mockImplementation(async (opts?: { prefix?: string }) => ({
      keys: Object.keys(store)
        .filter((k) => !opts?.prefix || k.startsWith(opts.prefix))
        .map((name) => ({ name })),
    })),
  };
}

/**
 * Create a mock R2 bucket for entity and other R2-based tests.
 */
export function createMockR2Bucket(
  objects: Record<string, string> = {}
): {
  get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
  put: (key: string, value: string) => Promise<void>;
  head: (key: string) => Promise<{ size: number } | null>;
} {
  const store: Record<string, string> = { ...objects };
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (!(key in store)) return null;
      return {
        text: async () => store[key],
      };
    }),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      store[key] = value;
    }),
    head: vi.fn().mockImplementation(async (key: string) => {
      if (!(key in store)) return null;
      return { size: store[key].length };
    }),
  };
}

/**
 * Sleep for the given milliseconds. Useful for simulating async delays.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

