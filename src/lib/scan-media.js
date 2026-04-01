/**
 * Scans src/media/ at build time and returns structured album/track/stem data.
 * Each album folder is expected to follow: "Album Name (Year)/"
 * Tracks live in: "Album Name (Year)/tracks/NN - Track Name.mp3"
 * Stems live in:  "Album Name (Year)/stems/NN - Track Name/<StemName>.mp3"
 * Album art:      "Album Name (Year)/folder.jpg"
 * Optional:       "Album Name (Year)/album.json" with per-track metadata (stemsLink, etc.)
 */

import fs from 'fs';
import path from 'path';
import fastGlob from 'fast-glob';

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

    // Album art
    const artFile = 'folder.jpg';
    const hasArt = fs.existsSync(path.join(albumPath, artFile));
    const artUrl = hasArt ? `/media/${dirName}/${artFile}` : null;

    // Load album.json if it exists
    let albumMeta = {};
    const albumJsonPath = path.join(albumPath, 'album.json');
    if (fs.existsSync(albumJsonPath)) {
      albumMeta = JSON.parse(fs.readFileSync(albumJsonPath, 'utf8'));
    }

    // Find tracks — check tracks/ subfolder first, then album root
    const tracksDir = path.join(albumPath, 'tracks');
    let trackFiles;
    let trackBasePath;

    if (fs.existsSync(tracksDir)) {
      trackFiles = fastGlob.sync('*.mp3', { cwd: tracksDir }).sort();
      trackBasePath = `media/${dirName}/tracks`;
    } else {
      trackFiles = fastGlob.sync('*.mp3', { cwd: albumPath }).sort();
      trackBasePath = `media/${dirName}`;
    }

    const tracks = [];

    for (const file of trackFiles) {
      // Parse "NN - Track Name.mp3"
      const trackMatch = file.match(/^(\d+)\s*-\s*(.+)\.mp3$/);
      if (!trackMatch) continue;

      const trackNum = parseInt(trackMatch[1], 10);
      const trackName = trackMatch[2].trim();
      const trackSlug = slugify(trackName);
      const mp3Url = `${R2_BASE_URL}/${trackBasePath}/${file}`;

      // Look up metadata from album.json
      const metaTrack = (albumMeta.tracks || []).find(t => t.name.toLowerCase() === trackName.toLowerCase());
      const stemsLink = metaTrack?.stemsUrl || metaTrack?.stemsLink || null;
      const masterUrl = metaTrack?.masterUrl || null;
      const spotifyUrl = metaTrack?.spotifyUrl || null;

      // Find stems for this track — try exact "NN - Track Name" match first,
      // then fall back to any folder ending in "- Track Name" (handles mismatched numbers)
      const stemFolderName = `${trackMatch[1]} - ${trackName}`;
      const stemsBaseDir = path.join(albumPath, 'stems');
      let resolvedStemFolder = null;

      if (fs.existsSync(path.join(stemsBaseDir, stemFolderName))) {
        resolvedStemFolder = stemFolderName;
      } else if (fs.existsSync(stemsBaseDir)) {
        // Search for a folder matching by track name with any number prefix
        const stemDirs = fs.readdirSync(stemsBaseDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        resolvedStemFolder = stemDirs.find(d => {
          const m = d.match(/^\d+\s*-\s*(.+)$/);
          return m && m[1].trim() === trackName;
        }) || null;
      }

      let stems = [];
      if (resolvedStemFolder) {
        const stemFolderPath = path.join(stemsBaseDir, resolvedStemFolder);
        const stemFiles = fastGlob.sync('*.mp3', { cwd: stemFolderPath }).sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true })
        );
        stems = stemFiles.map(sf => {
          // Parse "Song Name_INSTRUMENT.mp3" -> just the instrument part
          const stemMatch = sf.match(/^.+?_(.+)\.mp3$/);
          const stemName = stemMatch ? stemMatch[1] : sf.replace('.mp3', '');
          return {
            name: stemName,
            url: `${R2_BASE_URL}/media/${dirName}/stems/${resolvedStemFolder}/${sf}`,
          };
        });
      }

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

    // releaseDate from album.json, fall back to year from folder name
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
        slug: track.slug,
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
        })),
      });
    }
  }

  return songs;
}
