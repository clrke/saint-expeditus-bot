import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'bridge-server',
    include: ['test/**/*.test.ts'],
  },
});
