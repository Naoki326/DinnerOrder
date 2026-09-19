import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // scripts/ 下的 CLI 同样有可单测的纯函数（如 --xcf-dir 的 manifest 读法）：导入器的一部分，
    // 一并进测试盘子，免得「CLI 里的解析」成为唯一没有测试覆盖的地方。
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // 集成测试各自持有独立的内存 SQLite，测试之间不共享状态
    fileParallelism: true,
  },
});
