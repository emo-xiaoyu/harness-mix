import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: [
      {
        find: '@codexhost/shared-contracts/version',
        replacement: path.join(root, 'src/native-ui/shared-contracts/src/version.ts'),
      },
      {
        find: '@codexhost/shared-contracts',
        replacement: path.join(root, 'src/native-ui/shared-contracts/src/index.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/native-ui/**/test/**/*.test.ts'],
    maxWorkers: 4,
    passWithNoTests: false,
  },
});
