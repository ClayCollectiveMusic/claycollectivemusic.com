/**
 * Clay Collective — Music Page Inline Player
 *
 * Plays one track at a time with waveform seek bar and play/pause toggle.
 * Each .album-track-row with a data-mp3 attribute becomes playable.
 */

var audio = new Audio();
var activeRow = null;
var animId = null;

// Waveform state per row (keyed by mp3 url)
var waveformCache = {}; // mp3url -> { peaks, canvas }
// Peaks are extracted once at high resolution, then downsampled at draw time to
// however many device pixels the canvas actually has. Hardcoding a low bar count
// is what made this look blocky: a 400-bar waveform stretched across a ~2100px
// backing store gives 5px-wide bars with visible gaps.
var WAVEFORM_SAMPLES = 4000;
// Device-pixel width per drawn bar. At 1 the bars butt up against each other with
// no gap at all, which reads as a continuous waveform rather than a bar graph.
var WAVEFORM_BAR_PX = 1;
var WAVEFORM_HEIGHT = 32;
var WAVEFORM_COLOR = [78, 168, 181]; // teal accent
// How many frames to keep retrying a draw while the progress bar has no layout
var WAVEFORM_RENDER_ATTEMPTS = 60;

// Lazily create AudioContext for decoding (not for playback — we use HTML5 Audio)
var decodeCtx = null;
function getDecodeCtx() {
  if (!decodeCtx) decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  return decodeCtx;
}

// --- Waveform ---
function getPeaks(buffer, numSamples) {
  var numChannels = buffer.numberOfChannels;
  var length = buffer.getChannelData(0).length;
  // Hoist channel lookups out of the inner loop — getChannelData() per block is
  // needlessly expensive at this bucket count.
  var channels = [];
  for (var ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  var buckets = Math.max(1, Math.min(numSamples, length));
  var peaks = new Float32Array(buckets);
  // Fractional stride so the tail of the file isn't dropped by integer division.
  var perBucket = length / buckets;
  var globalMax = 0;

  for (var i = 0; i < buckets; i++) {
    var start = Math.floor(i * perBucket);
    var end = Math.min(length, Math.max(start + 1, Math.floor((i + 1) * perBucket)));
    var max = 0;
    for (var c = 0; c < numChannels; c++) {
      var chan = channels[c];
      for (var j = start; j < end; j++) {
        var val = chan[j];
        if (val < 0) val = -val;
        if (val > max) max = val;
      }
    }
    peaks[i] = max;
    if (max > globalMax) globalMax = max;
  }
  if (globalMax > 0) {
    for (var k = 0; k < buckets; k++) {
      peaks[k] = peaks[k] / globalMax;
    }
  }
  return peaks;
}

function drawWaveform(canvas, peaks, playbackPct) {
  var ctx = canvas.getContext('2d');
  var w = canvas.width;
  var h = canvas.height;
  var splitX = playbackPct * w;
  var r = WAVEFORM_COLOR[0], g = WAVEFORM_COLOR[1], b = WAVEFORM_COLOR[2];
  var colorPlayed = 'rgba(' + r + ',' + g + ',' + b + ',0.9)';
  var colorUnplayed = 'rgba(' + r + ',' + g + ',' + b + ',0.3)';

  ctx.clearRect(0, 0, w, h);

  // Draw one bar per WAVEFORM_BAR_PX device pixels, folding the surplus source
  // peaks into each bar with a max() so transients survive the downsample.
  var bars = Math.max(1, Math.min(peaks.length, Math.floor(w / WAVEFORM_BAR_PX)));
  var barW = w / bars;
  var perBar = peaks.length / bars;
  // Snap each bar to whole device pixels and butt it against the next one. Using
  // a fractional width here is what left faint gaps: the canvas antialiases a
  // 2.6px-wide rect into a solid core with translucent edges, reading as a seam.
  var gap = barW > 3 ? 1 : 0;

  for (var i = 0; i < bars; i++) {
    var from = Math.floor(i * perBar);
    var to = Math.min(peaks.length, Math.max(from + 1, Math.floor((i + 1) * perBar)));
    var peak = 0;
    for (var j = from; j < to; j++) {
      if (peaks[j] > peak) peak = peaks[j];
    }
    // Round both edges to whole pixels so bar N ends exactly where bar N+1
    // begins — no antialiased seam, no accumulating drift across the canvas.
    var x = Math.round(i * barW);
    var xNext = Math.round((i + 1) * barW);
    var barH = Math.max(1, peak * h * 0.95);
    var y = (h - barH) / 2;
    ctx.fillStyle = (x + barW) <= splitX ? colorPlayed : colorUnplayed;
    ctx.fillRect(x, y, Math.max(1, xNext - x - gap), barH);
  }
}

// Measure the drawable width of a progress bar. Returns 0 if it isn't laid out
// yet (e.g. still display:none), so callers can retry rather than create a
// zero-width canvas that never renders.
function measureBarWidth(bar) {
  return bar.clientWidth || bar.offsetWidth ||
    (bar.parentElement ? bar.parentElement.clientWidth : 0);
}

// Apply backing-store + CSS size for the current layout. Safe to call repeatedly.
function sizeCanvas(canvas, w) {
  var dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(WAVEFORM_HEIGHT * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = WAVEFORM_HEIGHT + 'px';
}

function setupCanvas(row) {
  var bar = row.querySelector('.music-progress-bar');
  if (!bar) return null;

  var w = measureBarWidth(bar);
  if (!w) return null; // not laid out yet — caller retries on next frame

  // Check if canvas already exists
  var existing = bar.querySelector('canvas');
  if (existing) {
    // Re-size if layout changed since creation (rotation, late layout on mobile)
    if (parseFloat(existing.style.width) !== w) sizeCanvas(existing, w);
    return existing;
  }

  var canvas = document.createElement('canvas');
  sizeCanvas(canvas, w);
  canvas.style.display = 'block';
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';

  // Hide the simple fill bar and ::after background
  var fill = bar.querySelector('.music-progress-fill');
  if (fill) fill.style.display = 'none';

  bar.appendChild(canvas);
  return canvas;
}

// Draw the waveform for a row, retrying on the next frame while the progress
// bar has no layout yet. Without this, a canvas created at width 0 on mobile
// stays blank forever because nothing re-measures it.
function renderWaveform(row, peaks, attemptsLeft) {
  var canvas = setupCanvas(row);
  if (!canvas) {
    if (attemptsLeft > 0 && activeRow === row) {
      requestAnimationFrame(function () {
        renderWaveform(row, peaks, attemptsLeft - 1);
      });
    }
    return;
  }
  var mp3 = row.getAttribute('data-mp3');
  if (mp3 && waveformCache[mp3]) waveformCache[mp3].canvas = canvas;
  var pct = audio.duration ? audio.currentTime / audio.duration : 0;
  drawWaveform(canvas, peaks, pct);
}

function loadWaveform(row) {
  var mp3 = row.getAttribute('data-mp3');
  if (!mp3) return;

  // Already cached
  if (waveformCache[mp3] && waveformCache[mp3].peaks) {
    renderWaveform(row, waveformCache[mp3].peaks, WAVEFORM_RENDER_ATTEMPTS);
    return;
  }

  // Already failed once — don't retry the (expensive) decode on every play
  if (waveformCache[mp3] && waveformCache[mp3].failed) return;

  // Mark as loading
  waveformCache[mp3] = { peaks: null, canvas: null, failed: false };

  fetch(mp3)
    .then(function (r) { return r.arrayBuffer(); })
    .then(function (buf) {
      // decodeAudioData is callback-style on older WebKit/Android — wrap so both work
      return new Promise(function (resolve, reject) {
        var ret = getDecodeCtx().decodeAudioData(buf, resolve, reject);
        if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
      });
    })
    .then(function (audioBuffer) {
      var peaks = getPeaks(audioBuffer, WAVEFORM_SAMPLES);
      waveformCache[mp3].peaks = peaks;

      // Only set up canvas if this row is still active
      if (activeRow === row) {
        renderWaveform(row, peaks, WAVEFORM_RENDER_ATTEMPTS);
      }
    })
    .catch(function (err) {
      // Decoding a whole MP3 can fail on memory-constrained mobile browsers.
      // Keep the simple fill bar visible instead of leaving an empty bar.
      console.error('Failed to decode waveform:', err);
      if (waveformCache[mp3]) waveformCache[mp3].failed = true;
      removeCanvasFromRow(row);
    });
}

function removeCanvasFromRow(row) {
  var bar = row.querySelector('.music-progress-bar');
  if (!bar) return;
  var canvas = bar.querySelector('canvas');
  if (canvas) canvas.remove();
  // Restore the simple fill bar
  var fill = bar.querySelector('.music-progress-fill');
  if (fill) {
    fill.style.display = '';
    fill.style.width = '0%';
  }
}

function clearActive() {
  if (activeRow) {
    activeRow.classList.remove('is-playing');
    removeCanvasFromRow(activeRow);
  }
  cancelAnimationFrame(animId);
  activeRow = null;
}

function updateProgress() {
  if (!activeRow || audio.paused) return;
  var pct = audio.duration ? audio.currentTime / audio.duration : 0;
  var mp3 = activeRow.getAttribute('data-mp3');
  var cached = mp3 && waveformCache[mp3];

  if (cached && cached.peaks && cached.canvas) {
    drawWaveform(cached.canvas, cached.peaks, pct);
  } else {
    // Fallback to fill bar if waveform not ready
    var fill = activeRow.querySelector('.music-progress-fill');
    if (fill) fill.style.width = (pct * 100) + '%';
  }

  animId = requestAnimationFrame(updateProgress);
}

function resetRow(r) {
  r.classList.remove('is-playing');
  r.classList.remove('has-played');
  removeCanvasFromRow(r);
  var fill = r.querySelector('.music-progress-fill');
  if (fill) fill.style.width = '0%';
}

function playRow(row) {
  var mp3 = row.getAttribute('data-mp3');
  if (!mp3) return;

  // If clicking the same row that's playing, toggle pause
  if (activeRow === row && !audio.paused) {
    audio.pause();
    row.classList.remove('is-playing');
    cancelAnimationFrame(animId);
    return;
  }

  // If clicking the same row that's paused, resume
  if (activeRow === row && audio.paused) {
    audio.play();
    row.classList.add('is-playing');
    updateProgress();
    return;
  }

  // Different track — stop old, start new
  audio.pause();
  clearActive();

  // Reset progress on all rows
  document.querySelectorAll('.album-track-row').forEach(function (r) { resetRow(r); });

  activeRow = row;
  audio.src = mp3;
  audio.play();
  row.classList.add('is-playing');
  row.classList.add('has-played');
  loadWaveform(row);
  updateProgress();
}

// Seek on progress bar
function seekFromEvent(e, row) {
  var bar = row.querySelector('.music-progress-bar');
  if (!bar) return;
  var rect = bar.getBoundingClientRect();
  var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

  // If this row isn't the active one, start playing it first
  if (activeRow !== row) {
    var mp3 = row.getAttribute('data-mp3');
    if (!mp3) return;
    audio.pause();
    clearActive();
    document.querySelectorAll('.album-track-row').forEach(function (r) { resetRow(r); });
    activeRow = row;
    audio.src = mp3;
    loadWaveform(row);
    audio.addEventListener('loadedmetadata', function onMeta() {
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.currentTime = pct * audio.duration;
      audio.play();
      row.classList.add('is-playing');
      updateProgress();
    });
    return;
  }

  if (audio.duration) {
    audio.currentTime = pct * audio.duration;
    var mp3 = row.getAttribute('data-mp3');
    var cached = mp3 && waveformCache[mp3];
    if (cached && cached.peaks && cached.canvas) {
      drawWaveform(cached.canvas, cached.peaks, pct);
    } else {
      var fill = row.querySelector('.music-progress-fill');
      if (fill) fill.style.width = (pct * 100) + '%';
    }
  }
}

// --- Track action dropdowns (Listen / Download) ---
var MENU_VIEWPORT_MARGIN = 8;

// Left-align the menu with its button, but shift it left if it would overflow
// the right edge of the viewport (and never past the left edge).
function positionTrackMenu(wrap) {
  var list = wrap.querySelector('.track-menu-list');
  if (!list) return;

  list.style.left = '0px';

  var wrapLeft = wrap.getBoundingClientRect().left;
  var width = list.offsetWidth;
  var maxLeft = window.innerWidth - MENU_VIEWPORT_MARGIN - width;
  // Desired viewport position is flush with the button; clamp into the viewport.
  var targetLeft = Math.max(MENU_VIEWPORT_MARGIN, Math.min(wrapLeft, maxLeft));

  list.style.left = (targetLeft - wrapLeft) + 'px';
}

function closeTrackMenus(except) {
  document.querySelectorAll('.track-menu.is-open').forEach(function (el) {
    if (el === except) return;
    el.classList.remove('is-open');
    var btn = el.querySelector('.track-menu-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
}

function repositionOpenTrackMenu() {
  var open = document.querySelector('.track-menu.is-open');
  if (open) positionTrackMenu(open);
}

window.addEventListener('resize', repositionOpenTrackMenu);
window.addEventListener('scroll', repositionOpenTrackMenu, true);

// Event delegation — play button + dropdown menu clicks
document.addEventListener('click', function (e) {
  var playBtn = e.target.closest('.music-play-btn');
  if (playBtn) {
    e.preventDefault();
    var row = playBtn.closest('.album-track-row');
    if (row) playRow(row);
    return;
  }

  var menuBtn = e.target.closest('.track-menu-btn');
  if (menuBtn) {
    e.preventDefault();
    var wrap = menuBtn.closest('.track-menu');
    var willOpen = !wrap.classList.contains('is-open');
    closeTrackMenus(wrap);
    wrap.classList.toggle('is-open', willOpen);
    menuBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    // Must run after it's visible — a display:none menu has no width to measure.
    if (willOpen) positionTrackMenu(wrap);
    return;
  }

  // Clicking a menu item closes the menu; clicking anywhere else closes all.
  closeTrackMenus(null);
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeTrackMenus(null);
});

// Double-click on track row to play/pause
document.addEventListener('dblclick', function (e) {
  if (e.target.closest('.music-play-btn') || e.target.closest('.album-track-actions') || e.target.closest('.music-progress-bar')) return;
  var row = e.target.closest('.album-track-row');
  if (row) playRow(row);
});

// Drag-to-seek on progress bar (mousedown starts, mousemove continues, mouseup ends)
var isDragging = false;
var dragRow = null;

document.addEventListener('mousedown', function (e) {
  var bar = e.target.closest('.music-progress-bar');
  if (bar) {
    e.preventDefault();
    var row = bar.closest('.album-track-row');
    if (row) {
      isDragging = true;
      dragRow = row;
      seekFromEvent(e, row);
    }
  }
});

document.addEventListener('mousemove', function (e) {
  if (!isDragging || !dragRow) return;
  seekFromEvent(e, dragRow);
});

document.addEventListener('mouseup', function () {
  isDragging = false;
  dragRow = null;
});

// Spacebar play/pause
document.addEventListener('keydown', function (e) {
  if (e.code === 'Space' && activeRow) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    e.preventDefault();
    playRow(activeRow);
  }
});

// When track ends, reset state
audio.addEventListener('ended', function () {
  if (activeRow) resetRow(activeRow);
  cancelAnimationFrame(animId);
  activeRow = null;
});

// Handle resize / rotation — re-measure and redraw the active waveform
function handleWaveformResize() {
  if (!activeRow) return;
  var mp3 = activeRow.getAttribute('data-mp3');
  var cached = mp3 && waveformCache[mp3];
  if (!cached || !cached.peaks) return;
  renderWaveform(activeRow, cached.peaks, WAVEFORM_RENDER_ATTEMPTS);
}

window.addEventListener('resize', handleWaveformResize);
window.addEventListener('orientationchange', handleWaveformResize);
