import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';

const envPath = path.join(process.cwd(), '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = process.env[m[1].trim()] ?? m[2].trim();
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
});

const res = await client.send(new ListObjectsV2Command({ Bucket: 'claycollectivemusic' }));
const keys = (res.Contents ?? []).map(o => o.Key!).filter(k => k.toLowerCase().includes('pour'));
for (const k of keys) console.log(JSON.stringify(k));
