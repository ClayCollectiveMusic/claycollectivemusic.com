# Clay Collective Music — Project Guide

## What This Is
A static website for Clay Collective, a worship music collective. The site showcases their music catalog, provides MP3 downloads, chord charts, and an interactive multitrack stem player.

**Live site:** https://claycollectivemusic.com
**Beta site:** https://beta.claycollectivemusic.com (deployed via GitHub Actions on push to master)

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
  images/                     # Logo, icons (SVG brand icons in images/icons/, referenced via relative <img> paths)
  partials/
    head.ejs                 # <head> partial (meta, CSS link)
    nav.ejs                  # Navigation bar
    footer.ejs               # Site footer
  media/                     # Music files (committed to git)
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
  scan-media.js               # Build-time media scanner (imported by vite.config.js — not a manual-run script, but build tooling, so it lives outside src/)

public/
  bg.png                     # Background image
  coming-soon.png            # Placeholder image

vite.config.js               # Vite config — loads site.json, scans media, defines EJS data
src/site.json                # Global site config (name, tagline, social links, streaming links)
```

## Key Concepts

### Media Scanning (Build Time)
`scripts/scan-media.js` scans `src/media/` at build time (called from `vite.config.js`). It:
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
- **Loading progress**: real byte-level download progress via `ReadableStream` — per-track bars + overall progress bar with label above the player; fades away on completion
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

## Deployment
- **Beta site** auto-deploys via GitHub Actions (`.github/workflows/deploy.yml`) on every push to `master`
- Uses `actions/deploy-pages@v4` — builds with Vite, uploads full `dist/` as artifact
- Custom domain `beta.claycollectivemusic.com` set via `public/CNAME`
- DNS managed in Cloudflare (CNAME pointing to GitHub Pages)

## Branches
- `master` — main development branch
- `gh-pages` — deployed site (GitHub Pages, legacy)

## Recent Changes
- **Player song picker grouped by album.** `player.html`'s flat list of song cards (which repeated the album name under every song) is now one horizontal `.album-row` per album: album art + name + `year · N songs` on the left, all that album's songs as pill-shaped `.song-chip` buttons wrapping on the right. Everything stays visible — no menus/accordions. `generatePlayerData` in `scripts/scan-media.js` now also emits `albumSlug` (grouping key) and `albumYear`. `buildSongList` in `src/js/player.js` does the grouping, preserving the scanner's newest-first album order. The delegated `[data-song]` click handler and the `.active` toggle in `selectSong` needed no changes — chips carry `data-song` just like the old cards did. Old `.song-item*` CSS replaced by `.album-row*` / `.song-chip`; under 768px the album header goes full-width above its chips.
- Fixed `src/js/player.js`: "Download All Stems (ZIP)" button now shows as soon as a song is selected (in `selectSong`) instead of only appearing once playback starts (previously set in `onSongChange`, which only ran on play). Removed the now-redundant duplicate zipUrl check that was left in `onSongChange`.
- Moved the Download All ZIP button (`src/player.html`) into `.player-transport`, right-aligned via `margin-left: auto` on new `.download-all-wrapper` class, so it sits at the top of the player alongside the loading progress bar instead of below the waveforms. Added mobile rule (`.download-all-wrapper { margin-left: 0; width: 100%; order: 10 }`) so it wraps to its own full-width row under 768px.
- Added `youtubeUrl` and `appleMusicUrl` support: read in `scripts/scan-media.js`, passed through to track data.
- **Icons moved to static files.** All icons (`spotify`, `apple-music`, `youtube`, `instagram`, `facebook`, `amazon-music`) live as real `.svg` files in `src/images/icons/`, referenced directly with relative `<img src="images/icons/name.svg">` tags in templates (same pattern as the existing `images/logo-icon-white.png` reference in `nav.ejs`) — no helper function, no Vite public dir. Vite's HTML asset pipeline picks up the relative `src=` references and copies the files into `dist/` automatically at build time. `youtube.svg` and `apple-music.svg` are official brand SVGs (multi-color/gradient); the rest are still hand-recreated placeholder path data pending official source files — safe to overwrite those files directly later, no code changes needed elsewhere. Since `<img>` can't be recolored via CSS `currentColor`, hover states on icon links (`.social-links a`, `.track-action-btn`) use opacity/transform/background-color on the wrapping link/button instead of a color swap on the icon itself.
- Moved `scan-media.js` from `src/lib/` to `scripts/` (removed `src/lib/`) — it's build-time tooling imported by `vite.config.js`, not shipped site source, so it belongs alongside `process-media.ts` rather than under `src/`.
- **Favicons** copied from `vote.claycollectivemusic.com` into `src/images/` (16/32/48/512 PNGs, apple-touch-icon, favicon.ico) and wired into `src/partials/head.ejs`.
- **Malformed-JSON resilience.** A bad `album.json` (e.g. mid-edit) used to crash the whole dev server. `scripts/scan-media.js` now try/catches the `JSON.parse` and skips that album with a warning; `vite.config.js` guards both the `site.json` reload (keeps last-good values) and the media `rescan()` so a watcher error can never kill the server.
- **Track action row (music.html) consolidated into dropdowns.** The `.wav` / `.mp3` / stems-ZIP buttons merged into one **Download** dropdown (`Download mp3` / `Download master` / `Download stems`), and Spotify/YouTube/Apple Music merged into a **Listen** dropdown (brand icons shown as labels inside the menu). Row is now `[stem player] [listen] [download]` — one button per *kind* of action. Stem-player button moved to the leftmost slot so the right-aligned row stays aligned across tracks with and without stems. Shared `.track-menu` / `.track-menu-btn` / `.track-menu-list` CSS + a single delegated handler in `music-player.js` drive both dropdowns (mutually exclusive, Escape and outside-click close).
  - **Gotcha:** `.track-download-btn` is already taken by the *stem player page* (`player.js` creates them, styled at ~line 1160 of styles.css with a hardcoded `26x26`). That rule appears later in the stylesheet and silently overrode the music-page button's size. Music-page classes are deliberately named `.track-menu-*` to avoid this collision — don't reuse `track-download-btn`.
  - Buttons enlarged from 30x28 to **38x36** (44x42 on mobile for touch targets). Inline `<svg>` glyphs render at 26px vs 20px for the brand `<img>` icons, because the SVGs have padding baked into their 24x24 viewBox and would otherwise look optically smaller. Removed `overflow: hidden` from `.album-card` (it clipped the dropdown on the last track) and the now-unused `.track-action-label`.

## Design
- Dark theme with teal accent (#4ea8b5)
- Serif headings (Georgia), sans-serif body (Segoe UI)
- Mobile responsive with hamburger nav at 768px
- CSS variables defined in `:root` of styles.css

## Key instructions
- Keep your output brief. I don't need to see everything you "read". Focus on solving the problem instead of blabbing about it.
- After every iterable step, please update this document with what you changed. To help future conversations.
