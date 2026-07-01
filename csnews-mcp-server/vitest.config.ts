import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['validate/**/*.contract.ts', 'validate/**/*.test.ts', 'validate/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/.git/**'],
    environment: 'node',
  },
});
