#!/usr/bin/env node
// Generates an RS256 key pair and prints the base64-encoded PEMs to paste into
// `.env` (JWT_PRIVATE_KEY_BASE64 / JWT_PUBLIC_KEY_BASE64). Master Context §2/§3.
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const b64 = (pem) => Buffer.from(pem, 'utf8').toString('base64');

console.log('# Paste these into your .env (dev only — use a secrets manager in prod):');
console.log(`JWT_PRIVATE_KEY_BASE64=${b64(privateKey)}`);
console.log(`JWT_PUBLIC_KEY_BASE64=${b64(publicKey)}`);
