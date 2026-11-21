import { writeFile } from 'node:fs/promises';

const apiBaseUrl = (process.env.VOICEKHATA_API_BASE_URL || '').trim().replace(/\/+$/, '');

if (!apiBaseUrl) {
  throw new Error('Set VOICEKHATA_API_BASE_URL in the Vercel project environment before building.');
}

let parsedUrl;
try {
  parsedUrl = new URL(apiBaseUrl);
} catch {
  throw new Error('VOICEKHATA_API_BASE_URL must be a valid HTTPS origin.');
}

if (parsedUrl.protocol !== 'https:' || parsedUrl.origin !== apiBaseUrl) {
  throw new Error('VOICEKHATA_API_BASE_URL must be an HTTPS origin without a path.');
}

await writeFile(
  new URL('./config.js', import.meta.url),
  `window.VOICEKHATA_CONFIG = { apiBaseUrl: ${JSON.stringify(apiBaseUrl)} };\n`,
  'utf8',
);
