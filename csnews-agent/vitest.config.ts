import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['validate/**/*.contract.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/score.ts',
        'src/classify.ts',
        'src/pull.ts',
        'src/dispatch.ts',
      ],
      thresholds: {
        lines: 50,
      },
    },
  },
});
