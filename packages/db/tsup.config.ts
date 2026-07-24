import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  // Keep the generated Prisma client and native deps external — never bundle.
  external: ['@prisma/client', '.prisma/client', 'argon2', 'ulid'],
});
