#!/usr/bin/env node
// Creates the S3_BUCKET on the local docker-compose object store. Idempotent.
// Run via `node scripts/with-env.mjs node scripts/s3-init.mjs` so .env is loaded.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The S3 SDK is a dependency of apps/api, not of the workspace root.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps', 'api', 'package.json'));
const { S3Client, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');

const bucket = process.env.S3_BUCKET ?? 'procureflow-dev';
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'ap-south-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
  },
});

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`bucket "${bucket}" already exists`);
} catch {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`bucket "${bucket}" created`);
}
