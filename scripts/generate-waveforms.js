/**
 * Renders a waveform SVG for each track MP3, at ingestion time.
 *
 * Why: the music page used to fetch + decodeAudioData the entire MP3 (~10 MB) a
 * second time just to draw a waveform. That doubled bandwidth and allocated a
 * large uncompressed PCM buffer, which fails on memory-constrained mobile
 * browsers. The waveform is static, so we render it once here and the page loads
 * it as a plain image.
 *
 * Output: `<track>.peaks.svg` next to the MP3, e.g.
 *   src/media/King of Glory (2026)/tracks/01 - King of Glory (Jesus Christ).peaks.svg
 *
 * The `.peaks.` infix keeps generated waveforms distinguishable from any other
 * SVG that may live in the media tree (brand art, etc.) — both here and on R2.
 *
 * The SVG is a self-contained image: fixed viewBox, one <rect> per bar, colors
 * baked in. It's loaded via <img>, so it can't inherit CSS from the page — the
 * accent color is written into the file.
 *
 * Requires ffmpeg on PATH. Runs as part of `npm run media:process`; invoke this file
 * directly for the `--force` / `--verbose` / `--variants` flags.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execFileSync } from 'child_process';

// --- Rendering geometry ---
// The SVG has a fixed coordinate space and is stretched horizontally by CSS
// (width:100%). BAR_COUNT bars across VB_W units means each slot is
// VB_W/BAR_COUNT wide; BAR_FILL is how much of that slot the bar occupies, so
// the gap stays proportional at any display size.
const VB_W = 1000;
const VB_H = 100;
// 1.0 = bars butt directly against each other (no gaps). Each bar IS the wave at
// that point, so a gap just discards signal.
const BAR_FILL = 1.0;
const MIN_BAR_H = 1.5;       // keeps near-silence visible
const PEAK_HEADROOM = 0.95;  // tallest peak stops just shy of the edges

// Waveforms render as solid black and are used as a CSS mask-image, so the page
// supplies the color via background-color. This matters for the stems player,
// where each track is tinted by category (getCategoryColor in player.js) — an
// <img> can't be recolored by CSS, but a mask can.
const WAVE_COLOR = '#000';

// Default style + resolution used by the normal (non-variant) run.
// `barsCrisp` is the safe default: square bars, ~1.5ms to rasterize. The
// non-Crisp variants of diagonal/stroked shapes cost 150ms+ — see STYLES below.
const DEFAULT_STYLE = 'barsCrisp';
const DEFAULT_BARS = 2000;

/**
 * Extension for generated waveform files. The `.peaks.` infix marks these as
 * derived output, so they can't be confused with hand-authored SVGs in the media
 * tree and can be matched/pruned as a group locally and on R2.
 */
export const WAVEFORM_SUFFIX = '.peaks.svg';

/**
 * Decodes an audio file to mono 16-bit PCM via ffmpeg and reduces it to
 * `numBars` peak values normalized to 0..1.
 */
export function computePeaks(audioPath, numBars = DEFAULT_BARS) {
  // Mono, 8kHz, signed 16-bit LE. We only need the amplitude envelope, so a low
  // sample rate keeps the buffer ~40x smaller than full-rate stereo float.
  const raw = execFileSync('ffmpeg', [
    '-v', 'quiet',
    '-i', audioPath,
    '-ac', '1',
    '-ar', '8000',
    '-f', 's16le',
    '-acodec', 'pcm_s16le',
    '-',
  ], { maxBuffer: 1024 * 1024 * 256 });

  const sampleCount = Math.floor(raw.length / 2);
  if (sampleCount === 0) throw new Error('ffmpeg produced no audio samples');

  const blockSize = Math.floor(sampleCount / numBars);
  if (blockSize === 0) throw new Error('audio too short for requested bar count');

  const peaks = new Array(numBars);
  let globalMax = 0;

  for (let i = 0; i < numBars; i++) {
    const start = i * blockSize;
    let max = 0;
    for (let j = 0; j < blockSize; j++) {
      const val = Math.abs(raw.readInt16LE((start + j) * 2));
      if (val > max) max = val;
    }
    peaks[i] = max;
    if (max > globalMax) globalMax = max;
  }

  return globalMax > 0 ? peaks.map(p => p / globalMax) : peaks.map(() => 0);
}

/**
 * Wraps shape markup in a standalone SVG document.
 *
 * preserveAspectRatio="none" lets CSS stretch the image to any width/height while
 * the bar/gap ratio stays put.
 *
 * `crisp` sets shape-rendering="crispEdges", which disables antialiasing. It is
 * NOT just a sharpness tweak — for FILLED shapes it is the biggest lever on render
 * cost: identical geometry measured 247ms antialiased versus 1.9ms crisp, a 130x
 * difference at 2000 bars / 1400x32.
 *
 * It does NOT help STROKED shapes — see `stroked` vs `strokedCrisp` in the STYLES
 * notes, both ~197ms. Stroke expansion is a separate raster-time cost.
 */
function svgDoc(body, { crisp }) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}"`,
    ` preserveAspectRatio="none"`,
    crisp ? ` shape-rendering="crispEdges"` : ``,
    `>`,
    body,
    `</svg>`,
  ].join('');
}

function barHeight(peak) {
  return Math.max(MIN_BAR_H, peak * VB_H * PEAK_HEADROOM);
}

/**
 * MEASURED RENDER COST — 2000 bars, rasterized at 1400x32 in Chrome, via
 * ctx.drawImage + a 1x1 getImageData flush (see .variants/bench.html).
 *
 * Earlier attempts to time this from the main thread all reported ~0ms, because
 * Chrome rasterizes <img> content on the compositor thread. drawImage() forces the
 * work onto the main thread where it can actually be measured.
 *
 * Full 14-variant results — single image / 8 at once:
 *
 *   envelopeCrisp   0.5ms /   3.3ms   SAFE
 *   rects           1.1ms /   7.6ms   SAFE  (crisp makes no difference)
 *   rectsCrisp      1.1ms /   6.8ms   SAFE
 *   envelope        1.3ms /   9.5ms   SAFE
 *   barsCrisp       1.6ms /  11.7ms   SAFE  <- production default
 *   spikeCrisp      1.9ms /  13.1ms   SAFE
 *   taperCrisp      2.7ms /  22.4ms   SAFE
 *   bars          197.4ms / 1575ms    AVOID
 *   stroked       197.4ms / 1577ms    AVOID
 *   strokedCrisp  197.3ms / 1580ms    AVOID
 *   round         200.9ms / 1630ms    AVOID
 *   roundCrisp    200.3ms / 1633ms    AVOID
 *   taper         218.6ms / 1762ms    AVOID
 *   spike         247.4ms / 1984ms    AVOID
 *
 * There are TWO INDEPENDENT cost factors. An earlier comment here claimed
 * crispEdges explained everything; the paired data below refutes that.
 *
 *  1. Antialiasing, avoidable via crispEdges. Byte-identical pairs:
 *       bars   197.4ms -> barsCrisp   1.6ms  (123x)
 *       spike  247.4ms -> spikeCrisp  1.9ms  (130x)
 *       taper  218.6ms -> taperCrisp  2.7ms  ( 81x)
 *
 *  2. Stroke expansion, NOT avoidable via crispEdges. Converting stroke-width
 *     into filled geometry happens at raster time regardless:
 *       stroked 197.4ms -> strokedCrisp 197.3ms  (1.0x — no help)
 *       round   200.9ms -> roundCrisp   200.3ms  (1.0x — no help)
 *     Any `stroke`-based style is therefore disqualified outright.
 *
 * Also note `rects` is unaffected by crispEdges (1.1ms both ways): with 2000
 * axis-aligned <rect> elements there are no diagonal edges to antialias. And
 * `bars` — the SAME visual output via one path — is 197ms when antialiased. The
 * takeaway is that fills are cheap only when crisp or axis-aligned; strokes are
 * never cheap.
 *
 * File size and path-command count remain useless as predictors: `strokedCrisp`
 * has the fewest commands (4,000) and smallest file (36KB) and is among the
 * slowest; `rects` has ZERO path commands and the largest file (102KB) and is the
 * fastest non-crisp option.
 */
/**
 * Geometry builders. Each returns just the shape markup — the crispEdges decision
 * is applied separately by SHAPES/STYLES below, so every shape can be emitted both
 * ways from one implementation. That's what makes the crisp-vs-smooth comparison a
 * true controlled experiment: the two files are byte-identical apart from the
 * shape-rendering attribute.
 */
const SHAPES = {
  /** Square-ended bars as individual <rect> elements. Zero path commands. */
  rects(peaks) {
    const mid = VB_H / 2;
    const slot = VB_W / peaks.length;
    const w = slot * BAR_FILL;
    let out = '';
    for (let i = 0; i < peaks.length; i++) {
      const h = barHeight(peaks[i]);
      out += `<rect x="${round(i * slot)}" y="${round(mid - h / 2)}" width="${round(w)}" height="${round(h)}"/>`;
    }
    return `<g fill="${WAVE_COLOR}">${out}</g>`;
  },

  /** Square-ended bars as one shared <path> — same look as `rects`, half the bytes. */
  bars(peaks) {
    const mid = VB_H / 2;
    const slot = VB_W / peaks.length;
    const w = slot * BAR_FILL;
    let d = '';
    for (let i = 0; i < peaks.length; i++) {
      const h = barHeight(peaks[i]);
      d += `M${round(i * slot)} ${round(mid - h / 2)}h${round(w)}v${round(h)}h${round(-w)}z`;
    }
    return `<path fill="${WAVE_COLOR}" d="${d}"/>`;
  },

  /**
   * Subtle taper: sides run straight for most of the height, then angle in to a
   * flat, narrow tip. Reads as a real waveform without looking spiky.
   */
  taper(peaks) {
    const mid = VB_H / 2;
    const slot = VB_W / peaks.length;
    const w = slot * BAR_FILL;
    const inset = w * 0.3;   // how much each side pulls in at the tip
    const shoulder = 0.85;   // fraction of half-height where the taper starts
    let d = '';
    for (let i = 0; i < peaks.length; i++) {
      const half = barHeight(peaks[i]) / 2;
      const x0 = i * slot;
      const x1 = x0 + w;
      const sh = half * shoulder;
      d += `M${round(x0)} ${round(mid - sh)}` +
           `L${round(x0 + inset)} ${round(mid - half)}` +
           `L${round(x1 - inset)} ${round(mid - half)}` +
           `L${round(x1)} ${round(mid - sh)}` +
           `L${round(x1)} ${round(mid + sh)}` +
           `L${round(x1 - inset)} ${round(mid + half)}` +
           `L${round(x0 + inset)} ${round(mid + half)}` +
           `L${round(x0)} ${round(mid + sh)}z`;
    }
    return `<path fill="${WAVE_COLOR}" d="${d}"/>`;
  },

  /** Full triangles: each bar is a spike meeting at a single apex. */
  spike(peaks) {
    const mid = VB_H / 2;
    const slot = VB_W / peaks.length;
    const w = slot * BAR_FILL;
    let d = '';
    for (let i = 0; i < peaks.length; i++) {
      const half = barHeight(peaks[i]) / 2;
      const x0 = i * slot;
      const cx = x0 + w / 2;
      d += `M${round(x0)} ${round(mid)}L${round(cx)} ${round(mid - half)}L${round(x0 + w)} ${round(mid)}` +
           `L${round(cx)} ${round(mid + half)}z`;
    }
    return `<path fill="${WAVE_COLOR}" d="${d}"/>`;
  },

  /**
   * Square-ended bars via a stroked path: 2 commands per bar (M + V) with
   * thickness from stroke-width instead of geometry. Smallest file of the bar
   * styles, and looks identical to `bars` — but DO NOT USE IT.
   *
   * Measured at ~197ms, and crispEdges does not help (strokedCrisp is also
   * ~197ms). Expanding stroke-width into filled geometry is raster-time work that
   * no rendering hint avoids. Kept only as the control that proves stroke cost is
   * independent of antialiasing cost.
   */
  stroked(peaks) {
    const mid = VB_H / 2;
    const slot = VB_W / peaks.length;
    const w = slot * BAR_FILL;
    let d = '';
    for (let i = 0; i < peaks.length; i++) {
      const half = barHeight(peaks[i]) / 2;
      const x = round(i * slot + w / 2);
      d += `M${x} ${round(mid - half)}V${round(mid + half)}`;
    }
    return `<path fill="none" stroke="${WAVE_COLOR}" stroke-width="${round(w)}" stroke-linecap="butt" d="${d}"/>`;
  },

  /**
   * Rounded caps via a stroked path. Heights are inset by half the stroke width so
   * the semicircular caps don't overshoot the true peak.
   */
  round(peaks) {
    const mid = VB_H / 2;
    const slot = VB_W / peaks.length;
    const w = slot * BAR_FILL;
    let d = '';
    for (let i = 0; i < peaks.length; i++) {
      const half = Math.max(0.01, barHeight(peaks[i]) / 2 - w / 2);
      const x = round(i * slot + w / 2);
      d += `M${x} ${round(mid - half)}V${round(mid + half)}`;
    }
    return `<path fill="none" stroke="${WAVE_COLOR}" stroke-width="${round(w)}" stroke-linecap="round" d="${d}"/>`;
  },

  /** Continuous filled envelope, no gaps — axis-aligned steps. */
  envelope(peaks) {
    const mid = VB_H / 2;
    const slot = VB_W / peaks.length;
    let d = `M0 ${round(mid - barHeight(peaks[0]) / 2)}`;
    for (let i = 0; i < peaks.length; i++) {
      const half = barHeight(peaks[i]) / 2;
      d += `V${round(mid - half)}H${round((i + 1) * slot)}`;
    }
    for (let i = peaks.length - 1; i >= 0; i--) {
      const half = barHeight(peaks[i]) / 2;
      d += `V${round(mid + half)}H${round(i * slot)}`;
    }
    return `<path fill="${WAVE_COLOR}" d="${d}Z"/>`;
  },
};

/**
 * Every shape in both rendering modes: `<shape>` (antialiased) and
 * `<shape>Crisp` (shape-rendering="crispEdges").
 *
 * Generated rather than hand-written so the pair is guaranteed identical except
 * for that one attribute — no chance of an unnoticed geometry difference
 * confounding the measurement.
 */
export const STYLES = {};
for (const [name, shapeFn] of Object.entries(SHAPES)) {
  STYLES[name] = peaks => svgDoc(shapeFn(peaks), { crisp: false });
  STYLES[name + 'Crisp'] = peaks => svgDoc(shapeFn(peaks), { crisp: true });
}

/** Renders normalized peaks to a standalone SVG in the given style. */
export function renderWaveformSvg(peaks, style = DEFAULT_STYLE) {
  const fn = STYLES[style];
  if (!fn) throw new Error(`Unknown waveform style "${style}". Options: ${Object.keys(STYLES).join(', ')}`);
  return fn(peaks);
}

// Trim float noise — keeps the file compact.
function round(n) {
  return Math.round(n * 100) / 100;
}

/** Path of the waveform SVG for a given mp3 path. */
export function waveformPathFor(mp3Path) {
  return mp3Path.replace(/\.mp3$/i, '') + WAVEFORM_SUFFIX;
}

/**
 * Generates the waveform SVG for one mp3 if missing or stale.
 * Returns 'created' | 'cached' | 'failed'.
 */
export function generateWaveform(mp3Path, { force = false, style = DEFAULT_STYLE, bars = DEFAULT_BARS } = {}) {
  const outPath = waveformPathFor(mp3Path);

  if (!force && fs.existsSync(outPath)) {
    // Regenerate only when the mp3 is newer than the rendered waveform.
    if (fs.statSync(outPath).mtimeMs >= fs.statSync(mp3Path).mtimeMs) return 'cached';
  }

  try {
    const peaks = computePeaks(mp3Path, bars);
    fs.writeFileSync(outPath, renderWaveformSvg(peaks, style));
    return 'created';
  } catch (e) {
    console.warn(`[generate-waveforms] Failed for "${path.basename(mp3Path)}": ${e.message}`);
    return 'failed';
  }
}

/**
 * Renders every style at several bar counts into `<track>.variants/` for manual
 * review. Peaks are computed once per bar count and shared across styles, so
 * ffmpeg runs a handful of times rather than once per output file.
 */
export function generateVariants(mp3Path, barCounts = [500, 1000, 2000, 3000]) {
  const base = path.basename(mp3Path).replace(/\.mp3$/i, '');
  const outDir = path.join(path.dirname(mp3Path), base + '.variants');
  fs.mkdirSync(outDir, { recursive: true });

  const rows = [];
  for (const bars of barCounts) {
    const peaks = computePeaks(mp3Path, bars);
    for (const style of Object.keys(STYLES)) {
      const svg = renderWaveformSvg(peaks, style);
      const name = `${style}-${bars}.svg`;
      fs.writeFileSync(path.join(outDir, name), svg);
      rows.push({
        style, bars, name,
        bytes: Buffer.byteLength(svg),
        gzip: gzipSize(svg),
        // Counted from inside d="..." only. A naive scan of the whole file also
        // matches the 'h' in height= and the 'H' in the xmlns URL, which made
        // <rect>-based styles report thousands of nonexistent path commands.
        //
        // Reported for reference only: measured render times did NOT track this
        // (or the crispEdges attribute) — repeated runs of the same file varied
        // by more than 20x, so browser cost is unresolved by that data.
        cmds: countPathCommands(svg),
        geo: describeGeometry(svg),
      });
    }
  }

  // A side-by-side HTML page is the only practical way to compare these; opening
  // 24 individual SVGs and eyeballing them doesn't work.
  fs.writeFileSync(path.join(outDir, 'index.html'), buildReviewPage(base, rows));
  return { outDir, rows };
}

function gzipSize(str) {
  return zlib.gzipSync(Buffer.from(str), { level: 9 }).length;
}

/** Counts SVG path commands, looking only inside d="..." attributes. */
function countPathCommands(svg) {
  let total = 0;
  for (const m of svg.matchAll(/\sd="([^"]*)"/g)) {
    total += (m[1].match(/[MmLlHhVvCcSsQqTtAaZz]/g) || []).length;
  }
  return total;
}

/**
 * Describes a style's drawing primitives: how many DOM elements the renderer has
 * to instantiate, and how many path commands it walks.
 *
 * Both matter, and reporting only one is misleading — `rects` draws 2000 separate
 * <rect> elements with ZERO path commands, which made it look free next to
 * path-based styles when it's actually the largest file of the bar-like styles.
 */
function describeGeometry(svg) {
  const shapeEls = (svg.match(/<(rect|line|circle|polygon|polyline)\b/g) || []).length;
  const paths = (svg.match(/<path\b/g) || []).length;
  const cmds = countPathCommands(svg);

  const parts = [];
  if (shapeEls) parts.push(`${shapeEls.toLocaleString()} elements`);
  if (paths) parts.push(`${paths} path / ${cmds.toLocaleString()} cmds`);
  return parts.join(' + ') || 'empty';
}

function kb(n) {
  return (n / 1024).toFixed(1) + ' KB';
}

/** Builds a dark-themed review page showing every variant at realistic width. */
function buildReviewPage(trackName, rows) {
  const byBars = new Map();
  for (const r of rows) {
    if (!byBars.has(r.bars)) byBars.set(r.bars, []);
    byBars.get(r.bars).push(r);
  }

  let sections = '';
  for (const [bars, list] of byBars) {
    sections += `<h2>${bars} bars</h2>`;
    for (const r of list) {
      // loading="lazy" + decoding="async" so opening the page doesn't rasterize
      // every variant at once — that's what made this page freeze Chrome.
      sections += `
        <div class="row">
          <div class="meta"><strong>${r.style}</strong> · ${kb(r.bytes)} raw · ${kb(r.gzip)} gzip · ${r.geo}</div>
          <div class="bar"><img loading="lazy" decoding="async" src="${encodeURI(r.name)}" alt="${r.style} ${bars}"></div>
        </div>`;
    }
  }

  return `<!doctype html>
<meta charset="utf-8">
<title>Waveform variants — ${trackName}</title>
<style>
  body { background:#0f0f0f; color:#eee; font:14px "Segoe UI",sans-serif; margin:0; padding:32px; }
  h1 { font-family:Georgia,serif; font-weight:normal; }
  h2 { margin:40px 0 12px; font-size:15px; color:#4ea8b5; border-bottom:1px solid #333; padding-bottom:6px; }
  .row { margin-bottom:18px; }
  .meta { font-size:12px; color:#999; margin-bottom:4px; }
  .meta strong { color:#eee; }
  .warn { color:#ff8080; font-weight:600; }
  /* Mirrors .music-progress-bar so widths/height match the real page. */
  .bar { height:32px; background:rgba(0,0,0,0.3); border-radius:3px; overflow:hidden; }
  .bar img { display:block; width:100%; height:100%; opacity:0.55; }
  .narrow { max-width:380px; }
  .note { color:#888; font-size:12px; margin-top:4px; }
</style>
<h1>Waveform variants</h1>
<p class="note">${trackName} — rendered at 32px tall, matching <code>.music-progress-bar</code>.
Images use <code>opacity:.55</code> as the page does. Resize the window to check scaling.</p>
<p class="note"><strong>Render cost:</strong> path-command count is the thing to watch, not file size.
Anything over ~15,000 commands is slow enough for Chrome to visibly hitch while rasterizing —
those are flagged in red. Images here are lazy-loaded so this page itself stays responsive;
see <a href="bench.html" style="color:#4ea8b5">bench.html</a> to time each file in isolation.</p>
${sections}
<h2>Mobile width check (380px)</h2>
<p class="note">Same files constrained to a phone-ish width — this is where dense bar counts blur together.</p>
${byBars.get(Math.max(...byBars.keys())).map(r => `
  <div class="row narrow">
    <div class="meta"><strong>${r.style}</strong> · ${r.bars} bars</div>
    <div class="bar"><img src="${encodeURI(r.name)}" alt=""></div>
  </div>`).join('')}
`;
}

// --- CLI ---

/**
 * Walks every mp3 under src/media/ — both full tracks (`<album>/tracks/*.mp3`) and
 * individual stems (`<album>/stems/<track>/*.mp3`). Stems matter because the
 * multitrack player renders one waveform per stem, and a 50-stem song is the
 * heaviest case on the site.
 *
 * Callback receives (absolutePath, label, kind) where kind is 'track' | 'stem'.
 */
function eachMp3(mediaDir, fn) {
  const albumDirs = fs.readdirSync(mediaDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  for (const albumDir of albumDirs) {
    // Skip our own scratch output from --variants runs.
    if (albumDir.endsWith('.variants')) continue;

    const tracksDir = path.join(mediaDir, albumDir, 'tracks');
    if (fs.existsSync(tracksDir)) {
      for (const file of fs.readdirSync(tracksDir).filter(f => /\.mp3$/i.test(f)).sort()) {
        fn(path.join(tracksDir, file), `${albumDir}/tracks/${file}`, 'track');
      }
    }

    const stemsDir = path.join(mediaDir, albumDir, 'stems');
    if (fs.existsSync(stemsDir)) {
      const stemFolders = fs.readdirSync(stemsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
      for (const folder of stemFolders) {
        const dir = path.join(stemsDir, folder);
        for (const file of fs.readdirSync(dir).filter(f => /\.mp3$/i.test(f)).sort()) {
          fn(path.join(dir, file), `${albumDir}/stems/${folder}/${file}`, 'stem');
        }
      }
    }
  }
}

/**
 * Deletes generated waveform SVGs that no longer correspond to an mp3.
 *
 * Covers two cases: an mp3 that was renamed or removed (its waveform is now
 * dead weight, and would linger on R2 as a live URL), and waveforms written
 * under the older `<track>.svg` naming before the `.peaks.svg` convention.
 *
 * Only files that sit beside audio in tracks/ or stems/ are considered, and a
 * bare `<name>.svg` is removed only when `<name>.mp3` exists — so hand-authored
 * SVGs elsewhere in the media tree are never touched.
 */
function pruneOrphanWaveforms(mediaDir, { dryRun = false } = {}) {
  const live = new Set();
  eachMp3(mediaDir, mp3Path => {
    live.add(path.resolve(waveformPathFor(mp3Path)));
  });

  const removed = [];
  eachAudioDir(mediaDir, dir => {
    for (const file of fs.readdirSync(dir)) {
      if (!/\.svg$/i.test(file)) continue;
      const abs = path.join(dir, file);
      if (live.has(path.resolve(abs))) continue;

      // Legacy `<name>.svg` — only prune when it's clearly a waveform, i.e. the
      // matching mp3 is right there.
      const isLegacy = !/\.peaks\.svg$/i.test(file)
        && fs.existsSync(path.join(dir, file.replace(/\.svg$/i, '.mp3')));
      const isStalePeaks = /\.peaks\.svg$/i.test(file);
      if (!isLegacy && !isStalePeaks) continue;

      if (!dryRun) fs.unlinkSync(abs);
      removed.push(path.relative(mediaDir, abs).replace(/\\/g, '/'));
    }
  });

  return removed;
}

/** Calls fn for every directory that holds audio: `<album>/tracks` and `<album>/stems/<track>`. */
function eachAudioDir(mediaDir, fn) {
  for (const albumDir of fs.readdirSync(mediaDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.endsWith('.variants'))
    .map(d => d.name)
    .sort()) {
    const tracksDir = path.join(mediaDir, albumDir, 'tracks');
    if (fs.existsSync(tracksDir)) fn(tracksDir);

    const stemsDir = path.join(mediaDir, albumDir, 'stems');
    if (!fs.existsSync(stemsDir)) continue;
    for (const folder of fs.readdirSync(stemsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()) {
      fn(path.join(stemsDir, folder));
    }
  }
}

// The --variants review harness only ever ran against one track; keep that
// narrow so it doesn't render hundreds of comparison files.
const VARIANT_SAMPLE_ALBUM = 'King of Glory (2026)';

function main() {
  const force = process.argv.includes('--force');
  const variants = process.argv.includes('--variants');
  const styleArg = (process.argv.find(a => a.startsWith('--style=')) || '').split('=')[1];
  const barsArg = (process.argv.find(a => a.startsWith('--bars=')) || '').split('=')[1];
  const mediaDir = path.join(process.cwd(), 'src', 'media');

  if (!fs.existsSync(mediaDir)) {
    console.error(`[generate-waveforms] No media dir at ${mediaDir}`);
    process.exit(1);
  }

  if (variants) {
    // --variant-bars=2000 (or a comma list) narrows which resolutions are built.
    const vbArg = (process.argv.find(a => a.startsWith('--variant-bars=')) || '').split('=')[1];
    const barCounts = vbArg
      ? vbArg.split(',').map(n => parseInt(n, 10)).filter(n => n > 0)
      : [500, 1000, 2000, 3000];

    const tracksDir = path.join(mediaDir, VARIANT_SAMPLE_ALBUM, 'tracks');
    const sample = fs.existsSync(tracksDir)
      ? fs.readdirSync(tracksDir).filter(f => /\.mp3$/i.test(f)).sort()[0]
      : null;
    if (!sample) {
      console.error(`[generate-waveforms] No sample track in "${VARIANT_SAMPLE_ALBUM}" for --variants`);
      process.exit(1);
    }
    console.log(`Rendering variants for ${sample} at ${barCounts.join(', ')} bars ...`);
    const { outDir, rows } = generateVariants(path.join(tracksDir, sample), barCounts);
    const widest = Math.max(...rows.map(r => r.style.length));
    for (const r of rows) {
      console.log(`  ${r.style.padEnd(widest)}  ${String(r.bars).padStart(5)} bars  ${kb(r.bytes).padStart(9)} raw  ${kb(r.gzip).padStart(9)} gzip`);
    }
    console.log(`\n  Review page: ${path.join(outDir, 'index.html')}`);
    return;
  }

  const style = styleArg || DEFAULT_STYLE;
  const bars = barsArg ? parseInt(barsArg, 10) : DEFAULT_BARS;
  if (!STYLES[style]) {
    console.error(`[generate-waveforms] Unknown style "${style}". Options: ${Object.keys(STYLES).join(', ')}`);
    process.exit(1);
  }

  const verbose = process.argv.includes('--verbose');
  let created = 0, cached = 0, failed = 0, stems = 0, trackCount = 0;

  eachMp3(mediaDir, (mp3Path, label, kind) => {
    const result = generateWaveform(mp3Path, { force, style, bars });
    if (kind === 'stem') stems++; else trackCount++;
    if (result === 'created') {
      created++;
      console.log(`  rendered   ${label}`);
    } else if (result === 'cached') {
      cached++;
      if (verbose) console.log(`  up-to-date ${label}`);
    } else {
      failed++;
    }
  });

  // Drop waveforms whose mp3 is gone or renamed, plus any left over from the
  // pre-`.peaks.svg` naming. Without this the R2 push would keep re-uploading
  // (and never removing) dead files.
  const orphans = pruneOrphanWaveforms(mediaDir);
  for (const rel of orphans) console.log(`  removed    ${rel}`);

  console.log(
    `[generate-waveforms] style=${style} bars=${bars} — ` +
    `${created} rendered, ${cached} up-to-date, ${failed} failed, ` +
    `${orphans.length} orphaned removed ` +
    `(${trackCount} tracks, ${stems} stems)`
  );
  if (cached && !verbose) console.log(`  (pass --verbose to list up-to-date files, --force to rebuild all)`);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('generate-waveforms.js')) {
  main();
}
