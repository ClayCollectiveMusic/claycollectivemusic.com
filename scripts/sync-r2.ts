/**
 * Sync media files with Cloudflare R2.
 *
 * Push (default): upload local media files to R2, skipping files already there.
 *   tsx scripts/sync-r2.ts
 *   tsx scripts/sync-r2.ts --push
 *
 * Pull: download files from R2 that don't exist locally (never deletes local files).
 *   tsx scripts/sync-r2.ts --pull
 *
 * Required env vars (put in .env.local or export before running):
 *   R2_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET        (default: claycollectivemusic)
 *   R2_PUBLIC_URL    (default: https://cdn.claycollectivemusic.com)
 */

import { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import * as fastGlob from 'fast-glob';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.join(__dirname, '..', 'src', 'media');

// --- Config from env ---
function requireEnv(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

// Load .env.local if present
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] ??= m[2].trim();
  }
}

const ACCOUNT_ID = requireEnv('R2_ACCOUNT_ID');
const ACCESS_KEY_ID = requireEnv('R2_ACCESS_KEY_ID');
const SECRET_ACCESS_KEY = requireEnv('R2_SECRET_ACCESS_KEY');
const BUCKET = requireEnv('R2_BUCKET', 'claycollectivemusic');

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});

// Files to exclude from sync (stay in git only)
const EXCLUDE_GLOBS = ['**/*.json', '**/*.wav'];

async function listR2Objects(): Promise<Set<string>> {
  const keys = new Set<string>();
  let continuationToken: string | undefined;

  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      ContinuationToken: continuationToken,
    }));
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.add(obj.Key);
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

function listLocalFiles(): string[] {
  const files = fastGlob.sync('**/*', {
    cwd: mediaDir,
    onlyFiles: true,
    ignore: EXCLUDE_GLOBS,
  });

  // On Windows, fast-glob may return paths with incorrect casing because NTFS is
  // case-insensitive. Resolve each path to its true filesystem-reported case so
  // that R2 keys always reflect the actual folder/file names on disk.
  return files.map(relPath => {
    const absPath = path.join(mediaDir, relPath);
    try {
      const realAbs = fs.realpathSync.native(absPath);
      return path.relative(mediaDir, realAbs).replace(/\\/g, '/');
    } catch {
      return relPath.replace(/\\/g, '/');
    }
  }).sort();
}

function mimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

async function push() {
  console.log('Listing R2 objects...');
  const r2Keys = await listR2Objects();
  console.log(`R2 has ${r2Keys.size} objects`);

  // Build a lowercase -> actual key map for case-insensitive comparison
  const r2KeysLower = new Map<string, string>();
  for (const key of r2Keys) {
    r2KeysLower.set(key.toLowerCase(), key);
  }

  const localFiles = listLocalFiles();
  console.log(`Local has ${localFiles.length} files to consider\n`);

  let uploaded = 0;
  let renamed = 0;
  let skipped = 0;

  for (const relPath of localFiles) {
    const r2Key = `media/${relPath}`;
    const r2KeyLower = r2Key.toLowerCase();

    if (r2Keys.has(r2Key)) {
      // Exact match — already in R2
      skipped++;
      continue;
    }

    const existingKey = r2KeysLower.get(r2KeyLower);
    if (existingKey) {
      // Case mismatch — rename by uploading with correct key and deleting old
      const absPath = path.join(mediaDir, relPath);
      const fileSize = fs.statSync(absPath).size;
      console.log(`Renaming: ${existingKey} -> ${r2Key} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
      await client.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: r2Key,
        Body: fs.readFileSync(absPath),
        ContentType: mimeType(relPath),
      }));
      await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: existingKey }));
      renamed++;
      continue;
    }

    // Not in R2 at all — upload
    const absPath = path.join(mediaDir, relPath);
    const fileSize = fs.statSync(absPath).size;
    console.log(`Uploading: ${r2Key} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
    await client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: r2Key,
      Body: fs.readFileSync(absPath),
      ContentType: mimeType(relPath),
    }));
    uploaded++;
  }

  console.log(`\nDone. Uploaded: ${uploaded}, Renamed: ${renamed}, Skipped (already in R2): ${skipped}`);
}

async function pull() {
  console.log('Listing R2 objects...');
  const r2Keys = await listR2Objects();
  console.log(`R2 has ${r2Keys.size} objects\n`);

  let downloaded = 0;
  let skipped = 0;

  for (const r2Key of r2Keys) {
    // Only pull files under media/
    if (!r2Key.startsWith('media/')) continue;

    const relPath = r2Key.slice('media/'.length);
    const absPath = path.join(mediaDir, relPath);

    if (fs.existsSync(absPath)) {
      skipped++;
      continue;
    }

    console.log(`Downloading: ${r2Key}`);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });

    const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: r2Key }));
    const stream = res.Body as Readable;
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(absPath);
      stream.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });

    downloaded++;
  }

  console.log(`\nDone. Downloaded: ${downloaded}, Skipped (already local): ${skipped}`);
}

const mode = process.argv.includes('--pull') ? 'pull' : 'push';
console.log(`R2 sync — mode: ${mode}\n`);

if (mode === 'pull') {
  pull().catch(e => { console.error(e); process.exit(1); });
} else {
  push().catch(e => { console.error(e); process.exit(1); });
}
