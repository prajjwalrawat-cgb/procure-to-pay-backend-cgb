import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    root: '.',
    coverage: {
      provider: 'v8',
      include: [
        'src/auth/auth.service.ts',
        'src/auth/guards/permission.guard.ts',
        'src/audit/audit.service.ts',
        'src/invoices/domain/tds.service.ts',
        'src/invoices/domain/msme.service.ts',
        'src/payment-runs/payment-run-msme.service.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 60, statements: 80 },
    },
  },
  plugins: [
    // SWC transpiles NestJS decorators/metadata for Vitest.
    swc.vite({ module: { type: 'es6' } }),
  ],
});
