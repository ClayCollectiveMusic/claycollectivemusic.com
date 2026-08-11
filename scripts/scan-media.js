/**
 * Scans src/media/ at build time and returns structured album/track/stem data.
 *
 * Source of truth:
 *   - Album/track metadata comes from album.json (committed to git)
 *   - Stem folder/file structure comes from the stems/ directory (folders committed, MP3s not)
 *   - All audio URLs point to R2 (cdn.claycollectivemusic.com)
 *
 * album.json format:
 *   {
 *     "releaseDate": "2025-03-27",
 *     "spotifyUrl": "https://...",   // optional album-level spotify
 *     "tracks": [
 *       {
 *         "name": "Track Name",      // must match "NN - Track Name.mp3" on disk
 *         "trackNum": 1,             // optional, falls back to array index + 1
 *         "stemsUrl": "https://...", // Google Drive zip link
 *         "masterUrl": "https://...",
 *         "spotifyUrl": "https://...",
 *         "youtubeUrl": "https://...",
 *         "appleMusicUrl": "https://...",
 *         "amazonMusicUrl": "https://..."
 *       }
 *     ]
 *   }
 */

import fs from 'fs';
import path from 'path';
import { WAVEFORM_SUFFIX } from './generate-waveforms.js';

const R2_BASE_URL = 'https://cdn.claycollectivemusic.com';

/**
 * Builds a CDN URL from path segments, percent-encoding each one.
 *
 * Every segment MUST be encoded. Album and stem names contain spaces and
 * parentheses ("Living Stones (2021)"), which are not legal in a URL. Attribute
 * contexts hide this — browsers silently fix up `<img src>` and `<a href>` — but
 * `fetch()` and CSS `url()` do not, so the multitrack player's fetch() of every
 * stem failed outright while the same links worked elsewhere on the page.
 *
 * encodeURIComponent (not encodeURI) because segment names can contain '#', '?'
 * and '&', which encodeURI would leave intact and corrupt the path.
 */
function mediaUrl(...segments) {
  return `${R2_BASE_URL}/media/` + segments.map(encodeURIComponent).join('/');
}

export function scanMedia(mediaDir) {
  if (!fs.existsSync(mediaDir)) return [];

  const albumDirs = fs.readdirSync(mediaDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  const albums = [];

  for (const dirName of albumDirs) {
    const albumPath = path.join(mediaDir, dirName);

    // Parse "Album Name (Year)" pattern
    const match = dirName.match(/^(.+?)\s*\((\d{4})\)$/);
    if (!match) continue;

    const albumName = match[1].trim();
    const year = parseInt(match[2], 10);
    const slug = slugify(albumName);

    // Album art — served from R2
    const artUrl = mediaUrl(dirName, 'folder.jpg');

    // album.json is required — it's the source of truth for tracks
    const albumJsonPath = path.join(albumPath, 'album.json');
    if (!fs.existsSync(albumJsonPath)) continue;

    // Don't let a malformed album.json (e.g. mid-edit in the dev server) crash the build/watcher.
    let albumMeta;
    try {
      albumMeta = JSON.parse(fs.readFileSync(albumJsonPath, 'utf8'));
    } catch (e) {
      console.warn(`[scan-media] Skipping "${dirName}" — invalid album.json: ${e.message}`);
      continue;
    }

    const metaTracks = albumMeta.tracks || [];
    if (metaTracks.length === 0) continue;

    const tracks = [];

    for (let i = 0; i < metaTracks.length; i++) {
      const meta = metaTracks[i];
      const trackName = meta.name?.trim();
      if (!trackName) continue;

      const trackNum = meta.trackNum ?? (i + 1);
      const trackNumStr = String(trackNum).padStart(2, '0');
      const trackSlug = slugify(trackName);
      const fileName = `${trackNumStr} - ${trackName}.mp3`;
      const mp3Url = mediaUrl(dirName, 'tracks', fileName);

      // Prerendered waveform image, generated at ingestion by
      // `npm run media:process` and served from R2 alongside the audio.
      // Presence is checked against the LOCAL file (R2 isn't reachable at build
      // time); null when absent, and the client then falls back to decoding the
      // mp3 on demand. A missing waveform after adding audio means the R2 push
      // hasn't run yet.
      // URL-encode each path segment: album/track names contain spaces and
      // parentheses, which break an unquoted CSS url() and are invalid in a URL.
      const svgFileName = fileName.replace(/\.mp3$/i, WAVEFORM_SUFFIX);
      const hasWaveform = fs.existsSync(path.join(albumPath, 'tracks', svgFileName));
      const waveformUrl = hasWaveform
        ? mediaUrl(dirName, 'tracks', svgFileName)
        : null;

      const stemsLink = meta.stemsUrl || meta.stemsLink || null;
      const masterUrl = meta.masterUrl || null;
      const spotifyUrl = meta.spotifyUrl || null;
      const youtubeUrl = meta.youtubeUrl || null;
      const appleMusicUrl = meta.appleMusicUrl || null;
      const amazonMusicUrl = meta.amazonMusicUrl || null;

      // Stems: read from album.json (populated by npm run media:process)
      // Each stem entry has { name, file } where file is the actual mp3 filename
      const metaStems = meta.stems || [];
      const stemFolderName = `${trackNumStr} - ${trackName}`;
      const stems = metaStems.map(stem => {
        const folder = stem.folder || stemFolderName;
        // Per-stem waveform, same convention as tracks: <stem>.peaks.svg next to the mp3.
        const stemSvg = stem.file.replace(/\.mp3$/i, WAVEFORM_SUFFIX);
        const hasStemWaveform = fs.existsSync(
          path.join(albumPath, 'stems', folder, stemSvg)
        );
        return {
          name: stem.name,
          url: mediaUrl(dirName, 'stems', folder, stem.file),
          waveformUrl: hasStemWaveform
            ? mediaUrl(dirName, 'stems', folder, stemSvg)
            : null,
          fileSize: stem.fileSize || 0,
          // Optional hand-authored link to the full-quality file (the .wav
          // master, hosted off-site — wavs are too large for R2). Hand-edited in
          // album.json and carried across regenerations by process-media.ts
          // (PRESERVED_STEM_FIELDS). Null when unset, and the mp3 is offered
          // for download instead.
          downloadUrl: stem.downloadUrl || null,
        };
      });

      tracks.push({
        num: trackNum,
        name: trackName,
        slug: trackSlug,
        mp3Url,
        stemsLink,
        masterUrl,
        spotifyUrl,
        youtubeUrl,
        appleMusicUrl,
        amazonMusicUrl,
        stems,
        waveformUrl,
      });
    }

    if (tracks.length === 0) continue;

    const releaseDate = albumMeta.releaseDate || `${year}-01-01`;

    albums.push({
      name: albumName,
      year,
      releaseDate,
      slug,
      artUrl,
      dirName,
      tracks,
    });
  }

  // Sort albums by releaseDate descending (newest first)
  albums.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));

  return albums;
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Generates the songs.json structure expected by player.js
 * Only includes songs that have stems.
 */
export function generatePlayerData(albums) {
  const songs = [];

  for (const album of albums) {
    for (const track of album.tracks) {
      if (track.stems.length === 0) continue;

      const title = track.name === album.name
        ? track.name
        : `${track.name} — ${album.name}`;

      songs.push({
        slug: album.slug + '--' + track.slug,
        title,
        trackNum: track.num,
        albumName: album.name,
        albumSlug: album.slug,
        albumYear: album.year || '',
        artUrl: album.artUrl || '',
        zipUrl: track.stemsLink || '',
        stemsUrl: track.stemsLink || '',
        spotifyUrl: track.spotifyUrl || '',
        // Two URLs per stem, split by purpose rather than by format:
        //   streamUrl   — what the player fetches and decodes. Always the R2
        //                 mp3; an off-site share link can't be fed to the Web
        //                 Audio API.
        //   downloadUrl — what a "download" link points at. The hand-authored
        //                 full-quality file when one is set, otherwise the same
        //                 mp3, so every stem stays downloadable either way.
        stems: track.stems.map(s => ({
          name: s.name,
          streamUrl: s.url,
          downloadUrl: s.downloadUrl || s.url,
          waveformUrl: s.waveformUrl || '',
          fileSize: s.fileSize || 0,
        })),
      });
    }
  }

  return songs;
}
