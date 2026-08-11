/**
 * Sync media files with Cloudflare R2.
 *
 * LOCAL FILES ARE NEVER DELETED OR MODIFIED by any mode. src/media/ is the
 * source of truth; this script only ever writes to R2 or adds missing local files.
 *
 * Push (default): upload local media files to R2. Uploads new files and re-uploads
 * ones whose content changed (compared by size, then md5 vs ETag). Reports remote
 * objects that no longer exist locally but leaves them alone.
 *   tsx scripts/sync-r2.ts
 *   tsx scripts/sync-r2.ts --push
 *
 * Push with prune: additionally DELETE remote objects with no local counterpart.
 * Cleans up after renames and deletions. Only affects R2.
 *   tsx scripts/sync-r2.ts --push --prune
 *
 * Dry run: print what would happen without uploading or deleting anything.
 *   tsx scripts/sync-r2.ts --push --prune --dry-run
 *
 * Pull: download files from R2 that don't exist locally (never deletes local files).
 *   tsx scripts/sync-r2.ts --pull
 *
 *Required env vars (put in .env.local or export before running):
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
import { createHash } from 'crypto';
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

// Files to exclude from sync (stay local/in git only).
//
// .json — album.json / site.json are build-time inputs, baked into the HTML by
//   vite.config.js. They are never fetched at runtime.
// .wav — src/media/ is the permanent source of truth for masters. The .wav
//   originals are never uploaded; only the derived .mp3 files are served.
// .variants — scratch output from `generate-waveforms.js --variants`.
//
// Waveform .svg files ARE synced: they're derived media served from the CDN
// alongside the audio, referenced via R2_BASE_URL in scan-media.js.
const EXCLUDE_GLOBS = ['**/*.json', '**/*.wav', '**/*.variants/**'];

interface R2Object {
  size: number;
  etag: string;
}

/**
 * Lists every object in the bucket with its size and ETag.
 *
 * Size/ETag are needed to detect *changed* files: comparing keys alone means a
 * regenerated file (e.g. a waveform rebuilt at a different bar count) is treated
 * as "already there" and silently never propagates.
 */
async function listR2Objects(): Promise<Map<string, R2Object>> {
  const objects = new Map<string, R2Object>();
  let continuationToken: string | undefined;

  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      ContinuationToken: continuationToken,
    }));
    for (const obj of res.Contents ?? []) {
      if (obj.Key) {
        objects.set(obj.Key, {
          size: obj.Size ?? -1,
          // ETag comes quoted from S3/R2; strip so it can be compared to an md5.
          etag: (obj.ETag ?? '').replace(/"/g, ''),
        });
      }
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  return objects;
}

/**
 * True when the local file differs from what's in R2.
 *
 * Size is the primary signal — cheap and catches nearly everything. ETag is only
 * a reliable md5 for single-part uploads (multipart ETags contain a "-N" suffix),
 * so it's used as a secondary check and skipped when it isn't a plain md5.
 */
function hasChanged(absPath: string, remote: R2Object): boolean {
  const localSize = fs.statSync(absPath).size;
  if (remote.size >= 0 && localSize !== remote.size) return true;

  if (/^[a-f0-9]{32}$/.test(remote.etag)) {
    const localMd5 = createHash('md5').update(fs.readFileSync(absPath)).digest('hex');
    return localMd5 !== remote.etag;
  }
  return false;
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
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function contentDisposition(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3' || ext === '.wav') {
    const fileName = path.basename(filePath);
    return `attachment; filename="${fileName}"`;
  }
  return undefined;
}

async function push(opts: { prune: boolean; dryRun: boolean }) {
  console.log('Listing R2 objects...');
  const r2Objects = await listR2Objects();
  console.log(`R2 has ${r2Objects.size} objects`);

  // Build a lowercase -> actual key map for case-insensitive comparison
  const r2KeysLower = new Map<string, string>();
  for (const key of r2Objects.keys()) {
    r2KeysLower.set(key.toLowerCase(), key);
  }

  const localFiles = listLocalFiles();
  console.log(`Local has ${localFiles.length} files to consider\n`);

  const prefix = opts.dryRun ? '[dry-run] ' : '';
  let uploaded = 0;
  let updated = 0;
  let renamed = 0;
  let skipped = 0;

  // Keys this push accounts for — used below to find orphans in R2.
  const expectedKeys = new Set<string>();

  for (const relPath of localFiles) {
    const r2Key = `media/${relPath}`;
    const absPath = path.join(mediaDir, relPath);
    expectedKeys.add(r2Key);

    const remote = r2Objects.get(r2Key);
    if (remote) {
      // Key exists — re-upload only if the content actually differs.
      if (hasChanged(absPath, remote)) {
        const mb = (fs.statSync(absPath).size / 1024 / 1024).toFixed(1);
        console.log(`${prefix}Updating (changed): ${r2Key} (${mb} MB)`);
        if (!opts.dryRun) await putObject(relPath, absPath, r2Key);
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    const existingKey = r2KeysLower.get(r2Key.toLowerCase());
    if (existingKey) {
      // Case-only mismatch — re-key by uploading correct case and removing old.
      const mb = (fs.statSync(absPath).size / 1024 / 1024).toFixed(1);
      console.log(`${prefix}Renaming: ${existingKey} -> ${r2Key} (${mb} MB)`);
      if (!opts.dryRun) {
        await putObject(relPath, absPath, r2Key);
        await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: existingKey }));
      }
      renamed++;
      continue;
    }

    // Not in R2 at all — upload
    const mb = (fs.statSync(absPath).size / 1024 / 1024).toFixed(1);
    console.log(`${prefix}Uploading: ${r2Key} (${mb} MB)`);
    if (!opts.dryRun) await putObject(relPath, absPath, r2Key);
    uploaded++;
  }

  // --- Orphan handling ---
  // Objects under media/ with no local counterpart. These accumulate from renames
  // and deletions, cost storage, and stay publicly reachable.
  //
  // Excluded local types (.wav, .json) are NOT treated as orphans just because
  // they're filtered out of the upload list — if the file exists on disk, its R2
  // copy is left alone. Only genuinely absent files are candidates.
  const orphans: string[] = [];
  for (const key of r2Objects.keys()) {
    if (!key.startsWith('media/')) continue;
    if (expectedKeys.has(key)) continue;
    const relPath = key.slice('media/'.length);
    if (fs.existsSync(path.join(mediaDir, relPath))) continue;
    orphans.push(key);
  }

  let pruned = 0;
  if (orphans.length > 0) {
    console.log(`\n${orphans.length} object(s) in R2 have no local counterpart:`);
    for (const key of orphans) {
      const mb = ((r2Objects.get(key)?.size ?? 0) / 1024 / 1024).toFixed(1);
      console.log(`  ${key} (${mb} MB)`);
    }
    if (opts.prune) {
      if (opts.dryRun) {
        console.log(`\n[dry-run] Would delete the ${orphans.length} object(s) above.`);
      } else {
        console.log(`\nDeleting ${orphans.length} orphaned object(s)...`);
        for (const key of orphans) {
          await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
          pruned++;
        }
      }
    } else {
      console.log(`\nLeft in place. Re-run with --prune to delete them.`);
    }
  }

  console.log(
    `\nDone. Uploaded: ${uploaded}, Updated: ${updated}, Renamed: ${renamed}, ` +
    `Skipped (unchanged): ${skipped}, Pruned: ${pruned}`
  );
  if (orphans.length > 0 && !opts.prune) {
    console.log(`Orphans left in R2: ${orphans.length} (use --prune to remove)`);
  }
}

function putObject(relPath: string, absPath: string, r2Key: string) {
  return client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: r2Key,
    Body: fs.readFileSync(absPath),
    ContentType: mimeType(relPath),
    ContentDisposition: contentDisposition(relPath),
  }));
}

async function pull() {
  console.log('Listing R2 objects...');
  const r2Objects = await listR2Objects();
  console.log(`R2 has ${r2Objects.size} objects\n`);

  let downloaded = 0;
  let skipped = 0;

  // Note: .keys() — listR2Objects returns a Map now, and iterating it directly
  // would yield [key, value] pairs rather than key strings.
  for (const r2Key of r2Objects.keys()) {
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
const prune = process.argv.includes('--prune');
const dryRun = process.argv.includes('--dry-run');

console.log(`R2 sync — mode: ${mode}${prune ? ' --prune' : ''}${dryRun ? ' --dry-run' : ''}\n`);
if (prune && !dryRun) {
  console.log('--prune will DELETE remote objects that no longer exist locally.');
  console.log('Local files are never touched. Run with --dry-run first to preview.\n');
}

if (mode === 'pull') {
  pull().catch(e => { console.error(e); process.exit(1); });
} else {
  push({ prune, dryRun }).catch(e => { console.error(e); process.exit(1); });
}
