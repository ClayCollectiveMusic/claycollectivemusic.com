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
- **Player song picker is now a two-level album tab strip.** `player.html` used to dump every song as a flat card list (repeating the album name under each), which didn't scale past a few albums. Now: a row of compact `.album-tab` buttons (art + name + `year · N songs`) across the top, and only the **selected** album's songs render below as pill-shaped `.song-chip` buttons, separated by a hairline divider.
  - `generatePlayerData` in `scripts/scan-media.js` emits `albumSlug` (grouping key) and `albumYear` alongside the existing `albumName`.
  - `src/js/player.js`: `groupSongsByAlbum()` builds the module-level `albumGroups` model (order = SONGS insertion order = scanner's newest-album-first); `buildSongList()` renders the tab strip once; `showAlbum(albumKey)` swaps the chips + marks the active tab; `albumKeyForSong(songKey)` maps the other direction. `selectSong` calls `showAlbum` first so a `?song=` deep link opens on the correct album.
  - **Clicking an album tab selects that album's first song** (`album.songKeys[0]`) rather than just revealing chips — otherwise the visible tab and the loaded song can disagree, which reads as a bug.
  - The single delegated `[data-song]` listener on `#song-list` still handles chips (they're descendants), so no per-chip wiring.
  - CSS at `styles.css` ~786: `.album-tab*` (inactive tabs dimmed — muted text + 70% art opacity, brightening on hover/`.active`) replaced the earlier `.album-row*` block. Under 768px `.album-tabs` scrolls horizontally (`flex-wrap: nowrap; overflow-x: auto`) instead of stacking into a tall block that pushes the player off-screen.
- **Stem files renamed to `<Song Title> - <Part>.<ext>`** (222 files: 156 in Pour out Your Spirit as paired mp3/wav, 66 wav-only in Living Stones). The old `POYS_ACS GTR.mp3` / `vocals.cm_01-05.wav` forms are gone; `.mp3` and `.wav` siblings share one base name. Notable resolutions: no lead-vs-rhythm distinction (both are `Electric Guitar N`), Glory to the King's unnumbered `PIANO`/`PAD` became `Piano 1`/`Pad 1` since a `2` exists, Freedom's lone `lead` is unnumbered `Electric Guitar`, and `DULCI` → `Dulcimer`. `album.json` `file` values were rewritten to match. **These need re-uploading to R2** — the player loads audio from `cdn.claycollectivemusic.com`, so stems 404 until synced.
- **Casing:** the correct forms are `Pour out Your Spirit` and `Pour out Your Spirit (Acoustic)` — lowercase `out`. Fixed in the stems folder name and `src/index.html`.
- **`categorize()` matches full stem names, not just DAW abbreviations.** Match lists in `src/js/player.js` cover both. **ORDER MATTERS** — first substring match wins, so `bass` must precede `guitars`/`keys` or "Bass Guitar" (contains `GUITAR`) and "Synth Bass" (contains `SYNTH`) land in the wrong group. Added a `bass` category (dusty red) and a `strings` one (soft gold, for Strings/Dulcimer, which previously fell to "Other"); renamed the `rhythm` label to "Percussion" (its `key` is still `rhythm`).
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
