import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Migration/maintenance tooling under scripts/. The Prisma client itself is
    // exercised by the api package's integration tests, not here.
    include: ['scripts/**/*.test.ts'],
  },
});
