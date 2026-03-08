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

export function scanMedia(mediaDir) {
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
      const mp3Url = `/${trackBasePath}/${file}`;

      // Look up metadata from album.json
      const metaTrack = (albumMeta.tracks || []).find(t => t.name === trackName);
      const stemsLink = metaTrack?.stemsLink || null;

      // Find stems for this track
      const stemsDir = path.join(albumPath, 'stems', `${trackMatch[0].replace('.mp3', '')}`);
      // Try matching by the folder name pattern "NN - Track Name"
      const stemFolderName = `${trackMatch[1]} - ${trackName}`;
      const stemFolderPath = path.join(albumPath, 'stems', stemFolderName);

      let stems = [];
      if (fs.existsSync(stemFolderPath)) {
        const stemFiles = fastGlob.sync('*.mp3', { cwd: stemFolderPath }).sort();
        stems = stemFiles.map(sf => {
          // Parse "Song Name_INSTRUMENT.mp3" -> just the instrument part
          const stemMatch = sf.match(/^.+?_(.+)\.mp3$/);
          const stemName = stemMatch ? stemMatch[1] : sf.replace('.mp3', '');
          return {
            name: stemName,
            url: `/media/${dirName}/stems/${stemFolderName}/${sf}`,
          };
        });
      }

      tracks.push({
        num: trackNum,
        name: trackName,
        slug: trackSlug,
        mp3Url,
        stemsLink,
        stems,
      });
    }

    if (tracks.length === 0) continue;

    albums.push({
      name: albumName,
      year,
      slug,
      artUrl,
      dirName,
      tracks,
    });
  }

  // Sort albums by year descending (newest first)
  albums.sort((a, b) => b.year - a.year);

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
        zipUrl: track.stemsLink || '',
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
