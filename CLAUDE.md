# Clay Collective Music — Project Guide

## What This Is
A static website for Clay Collective, a worship music collective. The site showcases their music catalog, provides MP3 downloads, chord charts, and an interactive multitrack stem player.

**Live site:** https://claycollectivemusic.com

## Tech Stack
- **Vite** — build tool and dev server (`npm run dev`, `npm run build`)
- **EJS** — HTML templating via `vite-plugin-ejs`
- **Vanilla JS** — no frameworks, plain browser JavaScript
- **CSS** — single shared stylesheet, no preprocessor
- **TypeScript** — only used for build scripts (not the site itself)

## Project Structure

```
src/                        # Vite root
  index.html                # Home page
  music.html                # Music catalog (albums + tracks)
  player.html               # Multitrack stem player page
  people.html               # Team/people page
  css/styles.css             # All styles (shared across pages)
  js/player.js               # Multitrack stem player (Web Audio API)
  js/music-player.js          # Inline track player for music.html (HTML5 Audio)
  lib/scan-media.js          # Build-time media scanner (used by vite config)
  partials/
    head.ejs                 # <head> partial (meta, CSS link)
    nav.ejs                  # Navigation bar
    footer.ejs               # Site footer
  media/                     # Music files (not committed — large binaries)
    <Album Name> (<Year>)/
      folder.jpg             # Album art
      album.json             # Optional per-track metadata (stemsLink, etc.)
      tracks/
        01 - Track Name.mp3  # Full track MP3s
      stems/
        01 - Track Name/     # Stem folder per track
          SongName_INSTRUMENT.mp3

scripts/
  process-media.ts           # Creates missing album.json files, converts .wav to .mp3 via ffmpeg, deletes originals

public/
  bg.png                     # Background image
  coming-soon.png            # Placeholder image

vite.config.js               # Vite config — loads site.json, scans media, defines EJS data
src/site.json                # Global site config (name, tagline, social links, streaming links)
```

## Key Concepts

### Media Scanning (Build Time)
`src/lib/scan-media.js` scans `src/media/` at build time (called from `vite.config.js`). It:
- Discovers albums by folder name pattern: `"Album Name (Year)"`
- Finds tracks in `tracks/` subfolder: `"NN - Track Name.mp3"`
- Finds stems in `stems/NN - Track Name/` subfolder
- Reads optional `album.json` for metadata (stemsUrl, masterUrl — Google Drive links)
- Returns structured album/track/stem data used by EJS templates

### Multitrack Stem Player (DAW-style)
`src/js/player.js` uses the **Web Audio API** to play multiple stems simultaneously.
- Song data is inlined at build time via `window.PLAYER_SONGS` global (set in player.html)
- Features: play/pause, seek, per-track solo/mute with circular buttons
- **Waveform visualization**: each track renders its AudioBuffer data on an HTML5 Canvas
- **Vertical playhead**: a single white line spans all tracks, with a time tooltip above it
- **Seeking**: clicking anywhere in the waveform area seeks to that position
- **Transport bar**: circular outline play/pause button + time display
- Per-track volume sliders and individual download links removed (Download All ZIP remains)
- URL param `?song=slug-name` auto-selects a song

### EJS Template Data
`vite.config.js` passes these to all EJS templates:
- `site` — from `src/site.json` (name, tagline, socials, streaming links)
- `icon(name, w, h)` — SVG icon helper (spotify, apple-music, youtube, instagram, facebook, amazon-music)
- `albums` — scanned album/track/stem data
- `generatePlayerData(albums)` — transforms albums into player-compatible format

## Commands
- `npm run dev` — Start Vite dev server (auto-opens browser)
- `npm run build` — Build to `dist/`
- `npm run process-media` — Create missing album.json, convert .wav files to .mp3 (requires ffmpeg)

## Branches
- `master` — main development branch
- `gh-pages` — deployed site (GitHub Pages)

## Design
- Dark theme with teal accent (#4ea8b5)
- Serif headings (Georgia), sans-serif body (Segoe UI)
- Mobile responsive with hamburger nav at 768px
- CSS variables defined in `:root` of styles.css

## Key instructions
- At the start of every conversation, greet me with "ahoy" before proceeding
- Keep your output brief. I don't need to see everything you "read". Focus on solving the problem instead of blabbing about it.
- After every iterable step, please update this document with what you changed. To help future conversations.
