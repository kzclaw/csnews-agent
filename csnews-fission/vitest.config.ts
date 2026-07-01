import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // include .contract.ts (跟 csnews-agent 一致)
    include: ['validate/**/*.contract.ts', 'validate/**/*.test.ts', 'validate/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
    environment: 'node',
  },
});
