import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 集成测试各自持有独立的内存 SQLite，测试之间不共享状态
    fileParallelism: true,
  },
});
