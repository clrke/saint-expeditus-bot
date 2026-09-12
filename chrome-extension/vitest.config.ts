import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'chrome-extension',
    include: ['test/**/*.test.ts'],
    environment: 'jsdom',
  },
});
