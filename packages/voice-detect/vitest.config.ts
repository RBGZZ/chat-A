import { defineConfig } from 'vitest/config';

/**
 * 包内 Vitest 配置:让 `pnpm -F @chat-a/voice-detect test` 只跑本包 test/。
 * 与根 vitest.config.ts(扫 packages/*​/test)互不冲突:根负责全量,这里负责单包定向。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
