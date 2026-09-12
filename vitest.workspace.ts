import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'bridge-server',
  'chrome-extension',
  {
    test: {
      name: 'integration',
      root: '.',
      include: ['test/**/*.test.ts'],
    },
  },
]);
