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
var WAVEFORM_SAMPLES = 400;
var WAVEFORM_HEIGHT = 32;
var WAVEFORM_COLOR = [78, 168, 181]; // teal accent

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
  var blockSize = Math.floor(length / numSamples);
  var peaks = new Float32Array(numSamples);
  var globalMax = 0;
  for (var i = 0; i < numSamples; i++) {
    var start = i * blockSize;
    var max = 0;
    for (var ch = 0; ch < numChannels; ch++) {
      var chan = buffer.getChannelData(ch);
      for (var j = 0; j < blockSize; j++) {
        var val = Math.abs(chan[start + j]);
        if (val > max) max = val;
      }
    }
    peaks[i] = max;
    if (max > globalMax) globalMax = max;
  }
  if (globalMax > 0) {
    for (var i = 0; i < numSamples; i++) {
      peaks[i] = peaks[i] / globalMax;
    }
  }
  return peaks;
}

function drawWaveform(canvas, peaks, playbackPct) {
  var ctx = canvas.getContext('2d');
  var w = canvas.width;
  var h = canvas.height;
  var barW = w / peaks.length;
  var splitX = playbackPct * w;
  var r = WAVEFORM_COLOR[0], g = WAVEFORM_COLOR[1], b = WAVEFORM_COLOR[2];
  var colorPlayed = 'rgba(' + r + ',' + g + ',' + b + ',0.9)';
  var colorUnplayed = 'rgba(' + r + ',' + g + ',' + b + ',0.3)';

  ctx.clearRect(0, 0, w, h);

  for (var i = 0; i < peaks.length; i++) {
    var x = i * barW;
    var barH = Math.max(1, peaks[i] * h * 0.95);
    var y = (h - barH) / 2;
    ctx.fillStyle = (x + barW) <= splitX ? colorPlayed : colorUnplayed;
    ctx.fillRect(x, y, Math.max(1, barW - 1), barH);
  }
}

function setupCanvas(row) {
  var bar = row.querySelector('.music-progress-bar');
  if (!bar) return null;

  // Check if canvas already exists
  var existing = bar.querySelector('canvas');
  if (existing) return existing;

  var canvas = document.createElement('canvas');
  var dpr = window.devicePixelRatio || 1;
  var w = bar.clientWidth;
  canvas.width = w * dpr;
  canvas.height = WAVEFORM_HEIGHT * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = WAVEFORM_HEIGHT + 'px';
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

function loadWaveform(row) {
  var mp3 = row.getAttribute('data-mp3');
  if (!mp3) return;

  // Already cached
  if (waveformCache[mp3] && waveformCache[mp3].peaks) {
    var canvas = setupCanvas(row);
    if (canvas) {
      waveformCache[mp3].canvas = canvas;
      var pct = audio.duration ? audio.currentTime / audio.duration : 0;
      drawWaveform(canvas, waveformCache[mp3].peaks, pct);
    }
    return;
  }

  // Mark as loading
  waveformCache[mp3] = { peaks: null, canvas: null };

  fetch(mp3)
    .then(function (r) { return r.arrayBuffer(); })
    .then(function (buf) { return getDecodeCtx().decodeAudioData(buf); })
    .then(function (audioBuffer) {
      var peaks = getPeaks(audioBuffer, WAVEFORM_SAMPLES);
      waveformCache[mp3].peaks = peaks;

      // Only set up canvas if this row is still active
      if (activeRow === row) {
        var canvas = setupCanvas(row);
        if (canvas) {
          waveformCache[mp3].canvas = canvas;
          var pct = audio.duration ? audio.currentTime / audio.duration : 0;
          drawWaveform(canvas, peaks, pct);
        }
      }
    })
    .catch(function (err) {
      console.error('Failed to decode waveform:', err);
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

// Event delegation — play button click
document.addEventListener('click', function (e) {
  var playBtn = e.target.closest('.music-play-btn');
  if (playBtn) {
    e.preventDefault();
    var row = playBtn.closest('.album-track-row');
    if (row) playRow(row);
    return;
  }
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

// Handle window resize — update canvas size for active waveform
window.addEventListener('resize', function () {
  if (!activeRow) return;
  var mp3 = activeRow.getAttribute('data-mp3');
  var cached = mp3 && waveformCache[mp3];
  if (!cached || !cached.peaks) return;
  var bar = activeRow.querySelector('.music-progress-bar');
  if (!bar) return;
  var canvas = bar.querySelector('canvas');
  if (!canvas) return;
  var dpr = window.devicePixelRatio || 1;
  var w = bar.clientWidth;
  canvas.width = w * dpr;
  canvas.height = WAVEFORM_HEIGHT * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = WAVEFORM_HEIGHT + 'px';
  cached.canvas = canvas;
  var pct = audio.duration ? audio.currentTime / audio.duration : 0;
  drawWaveform(canvas, cached.peaks, pct);
});
