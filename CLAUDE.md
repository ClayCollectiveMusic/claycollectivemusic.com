# Clay Collective Music — Project Guide

## What This Is
A static website for Clay Collective, a worship music collective based in Central PA. The site showcases their music catalog, provides MP3 downloads, stem downloads, and an interactive multitrack stem player. **Chord charts do not exist yet** — copy may say they're "on the way" but must never promise them as available.

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
  story.html                # Our Story (replaced the old people.html)
  merch.html                # Merch landing page
  css/styles.css             # All styles (shared across pages)
  js/player.js               # Multitrack stem player (Web Audio API)
  js/music-player.js          # Inline track player for music.html (HTML5 Audio)
  images/                     # Logo, icons (SVG brand icons in images/icons/, referenced via relative <img> paths)
  partials/
    head.ejs                 # <head> partial (meta, CSS link)
    nav.ejs                  # Navigation bar
    footer.ejs               # Site footer
  media/                     # NOT in git — .gitignore has `src/media/**` and
                             # re-includes ONLY album.json. Audio/wav/svg are
                             # local-only; the mp3s and svgs live on R2.
    <Album Name> (<Year>)/
      folder.jpg             # Album art
      album.json             # <- the only tracked file in here
      tracks/
        01 - Track Name.mp3        # Full track MP3s
        01 - Track Name.peaks.svg  # Prerendered waveform (generated)
      stems/
        01 - Track Name/     # Stem folder per track
          Song - Instrument.wav        # Master (kept as source of truth, never uploaded)
          Song - Instrument.mp3        # Derived, uploaded to R2
          Song - Instrument.peaks.svg  # Prerendered waveform (generated)

scripts/
  process-media.ts           # Creates missing album.json, converts .wav to .mp3 via
                             # ffmpeg (KEEPS the .wav originals), then generates waveforms
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

### Prerendered Waveforms (the important one)
Waveforms are **generated at ingestion, not in the browser**. `scripts/generate-waveforms.js`
runs ffmpeg over every track and stem mp3 and writes a sibling `<name>.peaks.svg`
(the suffix is exported as `WAVEFORM_SUFFIX` — `scan-media.js` imports it rather than
hardcoding the extension, so the two can't drift).

- **Orphan pruning.** After rendering, the script deletes any `.peaks.svg` with no
  matching mp3, plus legacy `<name>.svg` files sitting next to a `<name>.mp3`. Without
  this, renamed/removed audio leaves dead waveforms that the R2 push keeps re-uploading
  and never removes. Hand-authored SVGs elsewhere in the media tree are untouched — only
  `tracks/` and `stems/<track>/` directories are scanned, and a bare `.svg` is removed
  only when its sibling mp3 exists.

- **Style/resolution:** `barsCrisp` at 2000 bars. Chosen by measurement — see the big
  comment block above `STYLES` in that file for the full table. Two rules that matter:
  `shape-rendering="crispEdges"` makes filled shapes ~130x cheaper to rasterize, and
  **any `stroke`-based style is disqualified** (~197ms vs ~1.6ms, and crispEdges does
  NOT help strokes). Don't change the style without re-measuring.
- **Rendered as a CSS `mask-image`, not an `<img>`.** The SVG is monochrome black; color
  comes from `background-color`. This is required for the stems player, which tints each
  track by category (`getCategoryColor`) — an `<img>` can't be recolored by CSS.
- **Progress is a `clip-path`** on a second mask layer, driven by the `--played` custom
  property. The waveform rasterizes once and never redraws.
- **URLs must be `encodeURIComponent`'d per segment.** Album/track names contain spaces
  and parentheses; a raw CSS `url()` silently fails on them (unlike `src`/`href`, which
  browsers auto-encode).
- **Fallback is intact:** no `waveformUrl` → the old fetch-mp3-and-decode canvas path
  runs unchanged. That's what happens for any file whose `.svg` hasn't been generated.
- Off-screen rows use `content-visibility: auto` to defer rasterization (`loading="lazy"`
  isn't available — these are divs with masks, not images).

Why: the old path downloaded the mp3 a *second* time and ran `decodeAudioData` on it
(~84MB of PCM per track) purely to draw a waveform. That broke mobile Chrome. It also
redrew every canvas every animation frame — at 50 stems, ~30ms/frame (~180% of the frame
budget). Both costs are now gone.

### Multitrack Stem Player (DAW-style)
`src/js/player.js` uses the **Web Audio API** to play multiple stems simultaneously.
- Song data is inlined at build time via `window.PLAYER_SONGS` global (set in player.html)
- Features: play/pause, seek, per-track solo/mute with circular buttons
- **Waveform visualization**: prerendered SVG mask per stem (see above); falls back to
  drawing AudioBuffer peaks on a Canvas when no SVG exists. `getPeaks()` is skipped
  entirely for stems that have a prerendered waveform.
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

### Media
**`npm run media:sync`** is the one to run — it does all three steps below, in order.
The individual steps exist for when you only need one:

- `npm run media:download` — Pull from R2 anything missing locally. Gets a fresh machine
  (or one missing files) back into a good state. Never deletes local files.
- `npm run media:process` — Convert any `.wav` without an `.mp3` sibling (requires
  ffmpeg), create missing album.json, render waveforms, prune orphaned waveforms.
  Local only, never touches R2. Keeps the `.wav` originals.
- `npm run media:upload` — Make R2 match local: upload new *and changed* files (size,
  then md5-vs-ETag) and **delete remote objects with no local counterpart**.
  **Local files are never deleted.**
  - `npm run media:upload:dry-run` — Preview exactly that. Changes nothing.

For waveform-specific flags (`--force`, `--verbose`, `--variants`) run the script
directly: `node scripts/generate-waveforms.js --force`.

## Deployment
- **Beta site** auto-deploys via GitHub Actions (`.github/workflows/deploy.yml`) on every push to `master`
- Uses `actions/deploy-pages@v4` — builds with Vite, uploads full `dist/` as artifact
- Custom domain `beta.claycollectivemusic.com` set via `public/CNAME`
- DNS managed in Cloudflare (CNAME pointing to GitHub Pages)

## Branches
- `master` — main development branch
- `gh-pages` — deployed site (GitHub Pages, legacy)

## Copy & Voice
- **Never use em dashes** in copy, comments, or commit messages. Use a comma, semicolon, or a rewrite.
- **The region is named: Central PA.** Earlier copy said "the region" everywhere without ever
  naming it, which read as evasive and was worthless for SEO. Don't reintroduce the vague form.
- **Don't promise what doesn't ship.** Chord charts and WAV stem downloads were both advertised
  prominently while being undeliverable. Stems stream as **mp3**; `.wav` appears only when a stem
  has a hand-authored `downloadUrl` in album.json. Per-track **volume sliders were removed** — copy
  should say "solo and mute", never "adjust volume".
- **Voice:** plain, warm, and positive. **Not witty.** Avoid clever turns of phrase, dry asides,
  and anything that sounds like it's pleased with itself ("the ceiling moved", "that turns out to be
  a real constraint", "tired of waiting for someone else"). Say the thing straightforwardly.
- **Never frame the story negatively.** Motivation is what the team wanted to build, never what
  they were frustrated by or reacting against. Don't invent motives that aren't documented.
- `site.json` `copyright` holds **no year** — the footer prepends the current year at render time.
  Don't add one back. Rights statement is deliberately not Creative Commons: songs/stems are free
  for church use, all other rights reserved.

## Recent Changes
- **Full copy audit (all pages).** Fixed factual overclaims (WAV stems, per-track volume, chord
  charts), named Central PA in place of "the region", rewrote the story timeline, and rewrote every
  page's `<title>`/`description`/`og:*`.
  - **The home page's "What We're Working On" / "Our Process" section was deleted outright.** It
    described the writing-then-recording seasonal rhythm. Cut as something nobody cares about; don't
    reintroduce a process/behind-the-scenes section. Removing it also made `.mission-block` and the
    already-unused `.stat-*` rules dead, so those went too.
    - Home section bands were re-alternated after the removal (alt / plain / alt). Two adjacent
      `.section-alt` blocks merge into one continuous band, so check this when adding or removing a
      home section.
  - **The home hero blurb ("We're a collective of songwriters, singers, and musicians with one
    driving passion…") is deliberate and stays as-is.** It was rewritten during this audit and
    reverted on request. Don't "improve" it.
  - Also: 
  - Home hero tagline is now **one line with a bullet separator**, wrapping to two lines when it
    doesn't fit. Replaces two stacked `<p>`s with a 3px gap that looked like a rendering bug.
    - Three `<span>`s (half, `.tagline-sep` bullet, half). **The stack and the bullet's visibility
      are driven by the same `@media (max-width: 700px)` block** — `display: block` on the halves,
      `display: none` on the bullet. Keeping both in one query is the whole trick: CSS cannot detect
      that text has wrapped, so if the two ever diverge the bullet strands at a line edge.
    - Two earlier attempts failed, don't repeat them: (a) flex + `flex-wrap`, which breaks between
      items regardless of available width; (b) relying on natural inline wrapping, which leaves the
      bullet trailing at the end of line one. Both are unfixable by media query alone.
    - **700px is deliberate**, not the site's usual 768px: the phrases need ~490px at this size, so
      the switch fires with headroom before natural wrapping could occur while the bullet still
      shows. **If either phrase gets longer, re-check that margin.**
    - **Gotcha:** a `content: '\2022'` in single quotes inside the inline `<style>` broke Vite's
      `html-inline-proxy` at build time. Double quotes work. Build the site after touching inline CSS.
  - `activePage` for story.html was still `'people'` (dead leftover); now `'story'` in both
    story.html and nav.ejs.
  - **Removed a duplicate `id="overall-progress-wrap"` block** in player.html (also duplicated
    `overall-progress-fill` / `-label`). Invalid HTML, and `getElementById` only ever bound the
    first — dead leftover from when the progress bar moved into the transport bar.
  - "Download All" → "Download All Stems (.zip)"; the load-failure message no longer says
    "Please try again" (there's no retry affordance) and points at reloading instead.
  - Footer "Music & Charts" → "Music & Downloads". Merch page now uses its previously-unused
    `.merch-note` class, and the "we take no cut" line moved from the `<meta>` tag into the visible lede.
- **Per-stem `downloadUrl` in album.json.** `.wav` masters are too large for R2, so they're
  hosted off-site (Google Drive) and linked per stem.
  - Stem URLs are named by purpose, not format: `streamUrl` = always the R2 mp3 (an
    off-site share link can't be fetched into the Web Audio API); `downloadUrl` = the
    hand-authored link when set, else the same mp3, so every stem stays downloadable.
  - Renamed `stem.url` → `stem.streamUrl` in `generatePlayerData` + both `player.js` uses.
  - `process-media.ts` rebuilds `stems` wholesale from disk, so hand-typed fields must be
    carried across. `PRESERVED_STEM_FIELDS` does that, keyed on `file` (stable across
    regenerations). **Add new hand-authored stem fields to that list or they vanish.**
  - **Per-stem download is a dropdown** when a `.wav` link exists (`.mp3` / `.wav`), and
    stays a plain one-click button when it doesn't — a one-item menu is pure friction.
    Built by `buildStemDownloadMenu()` in `player.js`, reusing the `.track-menu` CSS from
    the music page.
  - **`<a download>` is ignored cross-origin.** An off-site .wav would otherwise navigate
    the current tab to a Drive viewer and destroy the loaded player, so `applyDownloadHref()`
    sends those to a new tab and keeps true download behavior for same-origin R2 files.
  - Menu open/close is duplicated in `player.js` (`initStemDownloadMenus`) rather than
    shared — `music-player.js` isn't loaded on the player page.
- **Waveforms renamed `<name>.svg` → `<name>.peaks.svg`.** 159 files renamed locally,
  uploaded, and the 159 old R2 objects pruned. The suffix lives in one place
  (`WAVEFORM_SUFFIX`, exported from `generate-waveforms.js`, imported by `scan-media.js`)
  so the generator and scanner can't drift.
- **npm scripts renamed and reduced from 7 media commands to 4.** Now three steps —
  `media:download` / `media:process` / `media:upload` — plus `media:sync` which runs all
  three in order, and a `media:upload:dry-run`. Replaces the old `process-media`, `media`,
  `generate-waveforms`, `r2:push`, `r2:push:prune`, `r2:dry-run`, `r2:pull`. Dropped the
  plain no-prune push (strictly weaker than `media:upload`) and the top-level
  `generate-waveforms` (already a step in `media:process`; run the script directly for
  `--force`/`--variants`). Only docs/comments referenced the old names — nothing in CI.
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
