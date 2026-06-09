/**
 * CSNEWS Agent · vitest 配置（v0.33+sweep·FT-KR0 · Phase0 · T000）
 *
 * 定位：业务契约验证（validate），不是测试实现细节（test）。
 * 区分原则：
 *   - test 派：测的是"代码这样写对不对"，依赖 mock/隔离，重构就挂
 *   - validate 派：测的是"业务规则就是这样"，不依赖外部环境，契约稳定
 *
 * 工具链仍是 vitest（TS 一等公民，不发明新框架），
 * 只把 include pattern / 命令名改成 validate 语义。
 *
 * 详见：tasks/csnews-agent-okr.md v0.33+sweep·FT-KR0
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 业务契约验证入口：只认 *.contract.ts（test 派的 *.test.ts 默认不跑）
    include: ['validate/**/*.contract.ts'],
    // 排除 node_modules / dist / .wrangler 等
    exclude: ['node_modules', 'dist', '.wrangler', 'coverage'],

    // 纯函数验证用 Node 即可（不依赖 Workers runtime）
    // 将来测 handlePull 等需要 supabaseFetch 的入口时再 mock
    environment: 'node',

    // Phase0 之前 validate/ 还没 contract 文件，避免 exit 1
    // Phase0 写完后这条不影响任何契约验证（vitest 找到文件就按文件走）
    passWithNoTests: true,

    // 5 重安全网 · T000 覆盖率门槛
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      // 5 个首批验证函数（v0.33+sweep·FT-KR0 锁定）：hashStr / scoreRule /
      // classifyRule / parseFilters / TYPE_CONFIG + VALID_* 4 个常量
      // include 锁定 src/{score,classify,pull}.ts 这三个文件
      include: ['src/score.ts', 'src/classify.ts', 'src/pull.ts'],
      // 阈值：≥80%（v0.33+sweep 阶段硬指标，CF auto-deploy 守住）
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});