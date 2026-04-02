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
 *         "spotifyUrl": "https://..."
 *       }
 *     ]
 *   }
 */

import fs from 'fs';
import path from 'path';

const R2_BASE_URL = 'https://cdn.claycollectivemusic.com';

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
    const artUrl = `${R2_BASE_URL}/media/${dirName}/folder.jpg`;

    // album.json is required — it's the source of truth for tracks
    const albumJsonPath = path.join(albumPath, 'album.json');
    if (!fs.existsSync(albumJsonPath)) continue;
    const albumMeta = JSON.parse(fs.readFileSync(albumJsonPath, 'utf8'));

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
      const mp3Url = `${R2_BASE_URL}/media/${dirName}/tracks/${fileName}`;

      const stemsLink = meta.stemsUrl || meta.stemsLink || null;
      const masterUrl = meta.masterUrl || null;
      const spotifyUrl = meta.spotifyUrl || null;

      // Stems: read from album.json (populated by npm run process-media)
      // Each stem entry has { name, file } where file is the actual mp3 filename
      const metaStems = meta.stems || [];
      const stemFolderName = `${trackNumStr} - ${trackName}`;
      const stems = metaStems.map(stem => ({
        name: stem.name,
        url: `${R2_BASE_URL}/media/${dirName}/stems/${stem.folder || stemFolderName}/${stem.file}`,
        fileSize: stem.fileSize || 0,
      }));

      tracks.push({
        num: trackNum,
        name: trackName,
        slug: trackSlug,
        mp3Url,
        stemsLink,
        masterUrl,
        spotifyUrl,
        stems,
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
        albumName: album.name,
        artUrl: album.artUrl || '',
        zipUrl: track.stemsLink || '',
        stemsUrl: track.stemsLink || '',
        spotifyUrl: track.spotifyUrl || '',
        stems: track.stems.map(s => ({
          name: s.name,
          url: s.url,
          downloadUrl: s.url,
          fileSize: s.fileSize || 0,
        })),
      });
    }
  }

  return songs;
}
