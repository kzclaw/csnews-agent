import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // 重 import 用例（validate/ 里 await import('../src/index')）模块图大，
    // 内存紧张时单个文件可能跑不完 30s · 这里给 60s 兜底，真实断言失败仍照报
    testTimeout: 60000,
    // 限制并发 worker 数压低内存峰值（macOS compressor 压力下 18 文件全并发会假超时）
    maxWorkers: 2,
    minWorkers: 1,
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
