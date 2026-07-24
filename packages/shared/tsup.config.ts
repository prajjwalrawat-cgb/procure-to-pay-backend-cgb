import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  // Keep the previous dist (esp. index.d.ts) in place while `tsup --watch`
  // rebuilds, so consumers running in watch mode (the api's nest --watch) never
  // see a transiently-missing declaration file and fail with cascade TS7016s.
  clean: false,
  sourcemap: true,
  target: 'es2022',
});
