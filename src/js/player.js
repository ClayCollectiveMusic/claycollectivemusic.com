/**
 * Clay Collective — Multitrack Stem Player (DAW-style)
 *
 * Uses the Web Audio API to load and play multiple stems simultaneously,
 * with per-track solo/mute controls and waveform visualization.
 *
 * Song data is inlined into the page at build time via PLAYER_SONGS global.
 * Songs with a non-empty `stems` array will appear in the player dropdown.
 */

// Build the SONGS object from the inlined data
var SONGS = {};

(window.PLAYER_SONGS || []).forEach(function(song) {
  if (song.stems && song.stems.length > 0) {
    SONGS[song.slug] = {
      title: song.title,
      albumName: song.albumName || '',
      artUrl: song.artUrl || '',
      zipUrl: song.zipUrl || '',
      spotifyUrl: song.spotifyUrl || '',
      stems: song.stems
    };
  }
});

function formatBytes(bytes) {
  if (!bytes) return null;
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

// Spotify icon SVG (inline since this is client-side JS)
var SPOTIFY_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>';

// --- Instrument Categories ---
var CATEGORIES = [
  { key: 'vocals',  label: 'Vocals',       match: ['VOC', 'VOX', 'LEAD VOC', 'BGV', 'AD LIB', 'OHHS', 'GANG', 'DBLS'], color: [78, 168, 181] },   // teal (original)
  { key: 'guitars', label: 'Guitars',       match: ['GTR', 'GUITAR'],                                                     color: [120, 180, 100] }, // muted green
  { key: 'keys',    label: 'Keys & Synths', match: ['PIANO', 'KEYS', 'PAD', 'SYNTH', 'ORGAN', 'RHODES', 'WURLI'],         color: [140, 130, 190] }, // soft purple
  { key: 'rhythm',  label: 'Rhythm',        match: ['DRUM', 'PERC', 'BASS', 'CLICK'],                                     color: [190, 140, 90] },  // warm amber
  { key: 'other',   label: 'Other',         match: [],                                                                     color: [150, 155, 160] }  // neutral grey
];

function categorize(stemName) {
  var upper = stemName.toUpperCase();
  for (var c = 0; c < CATEGORIES.length - 1; c++) {
    var cat = CATEGORIES[c];
    for (var m = 0; m < cat.match.length; m++) {
      if (upper.indexOf(cat.match[m]) !== -1) return cat.key;
    }
  }
  return 'other';
}

// --- State ---
var audioCtx = null;
var tracks = [];
var currentSongKey = null;
var isPlaying = false;
var isLoading = false;
var autoPlayWhenLoaded = false;
var loadAbortController = null;
var loadGeneration = 0;
var startTime = 0;
var pauseOffset = 0;
var duration = 0;
var animFrameId = null;
var seekPct = 0; // tracks playhead position as 0-1, even before duration is known

// Waveform settings
var WAVEFORM_SAMPLES = 800;
var TRACK_HEIGHT = 32;

function getCategoryColor(catKey) {
  var cat = CATEGORIES.find(function (c) { return c.key === catKey; });
  return cat ? cat.color : [78, 168, 181];
}

// --- DOM ---
var songListEl = document.getElementById('song-list');
var playerEl = document.getElementById('player');
var overallProgressWrap = document.getElementById('overall-progress-wrap');
var overallProgressFill = document.getElementById('overall-progress-fill');
var overallProgressLabel = document.getElementById('overall-progress-label');
var playBtn = document.getElementById('play-btn');
var timeDisplay = document.getElementById('time-display');
var trackListEl = document.getElementById('track-list');
var downloadAllWrapper = document.getElementById('download-all-wrapper');
var downloadAllBtn = document.getElementById('download-all-btn');
var playhead = document.getElementById('playhead');
var playheadTime = document.getElementById('playhead-time');
var waveformArea = document.getElementById('waveform-area');
var transportSizeWarning = document.getElementById('transport-size-warning');

// --- Init ---
function init() {
  buildSongList();

  songListEl.addEventListener('click', function (e) {
    var item = e.target.closest('[data-song]');
    if (!item) return;
    selectSong(item.getAttribute('data-song'));
  });

  playBtn.addEventListener('click', togglePlay);

  // Drag-to-seek: mousedown starts, mousemove continues, mouseup ends
  var isDragging = false;
  waveformArea.addEventListener('mousedown', function (e) {
    if (e.target.closest('.track-controls') || e.target.closest('.group-controls') || e.target.closest('.track-download-btn')) return;
    isDragging = true;
    seekToEvent(e);
  });
  document.addEventListener('mousemove', function (e) {
    if (!isDragging) return;
    seekToEvent(e);
  });
  document.addEventListener('mouseup', function () {
    isDragging = false;
  });

  // Drag-to-paint for M/S buttons + ctrl+click to clear all
  var btnDragAction = null; // 'solo' or 'mute'
  var btnDragValue = null;  // true or false (the value to paint)
  var btnDragVisited = [];  // track indices already toggled in this drag

  trackListEl.addEventListener('mousedown', function (e) {
    // Group buttons — no drag, just click
    var groupMuteBtn = e.target.closest('.group-mute-btn');
    if (groupMuteBtn) {
      if (e.ctrlKey || e.metaKey) { clearAllMutes(); } else { toggleGroupMute(groupMuteBtn.getAttribute('data-group')); }
      return;
    }
    var groupSoloBtn = e.target.closest('.group-solo-btn');
    if (groupSoloBtn) {
      if (e.ctrlKey || e.metaKey) { clearAllSolos(); } else { toggleGroupSolo(groupSoloBtn.getAttribute('data-group-solo')); }
      return;
    }

    // Track buttons — start drag-to-paint
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    e.preventDefault();
    var idx = parseInt(btn.getAttribute('data-index'), 10);
    var action = btn.getAttribute('data-action');

    if (e.ctrlKey || e.metaKey) {
      if (action === 'solo') clearAllSolos();
      if (action === 'mute') clearAllMutes();
      return;
    }

    btnDragAction = action;
    // Paint the opposite of current state
    if (action === 'solo') {
      btnDragValue = !tracks[idx].solo;
      tracks[idx].solo = btnDragValue;
    } else {
      btnDragValue = !tracks[idx].muted;
      tracks[idx].muted = btnDragValue;
    }
    btnDragVisited = [idx];
    updateGains();
    updateTrackButtons();
  });

  document.addEventListener('mousemove', function (e) {
    if (!btnDragAction) return;
    var btn = e.target.closest('button[data-action="' + btnDragAction + '"]');
    if (!btn) return;
    var idx = parseInt(btn.getAttribute('data-index'), 10);
    if (btnDragVisited.indexOf(idx) !== -1) return;
    btnDragVisited.push(idx);
    if (btnDragAction === 'solo') {
      tracks[idx].solo = btnDragValue;
    } else {
      tracks[idx].muted = btnDragValue;
    }
    updateGains();
    updateTrackButtons();
  });

  document.addEventListener('mouseup', function () {
    btnDragAction = null;
    btnDragValue = null;
    btnDragVisited = [];
  });

  // Spacebar play/pause (or trigger load if splash is showing)
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && currentSongKey) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      e.preventDefault();
      togglePlay();
    }
  });

  // Auto-select song from URL query param, or first song by default
  var params = new URLSearchParams(window.location.search);
  var songParam = params.get('song');
  var firstKey = Object.keys(SONGS)[0];
  if (songParam && SONGS[songParam]) {
    selectSong(songParam);
  } else if (firstKey) {
    selectSong(firstKey);
  }
}

function selectSong(key) {
  // Update active state in song list
  var items = songListEl.querySelectorAll('[data-song]');
  items.forEach(function (el) {
    el.classList.toggle('active', el.getAttribute('data-song') === key);
  });

  // Update URL querystring without reloading
  var url = new URL(window.location);
  url.searchParams.set('song', key);
  history.replaceState(null, '', url);

  // If this song is already loaded, just switch to it
  if (currentSongKey === key && tracks.length > 0) return;

  // Stop any current playback/loading and reset
  if (loadAbortController) { loadAbortController.abort(); loadAbortController = null; }
  loadGeneration++;
  isLoading = false;
  autoPlayWhenLoaded = false;
  stopPlayback();
  currentSongKey = key;
  tracks = [];
  duration = 0;
  pauseOffset = 0;
  seekPct = 0;
  playBtn.onclick = null;
  transportSizeWarning.style.display = 'none';
  waveformArea.classList.remove('waveforms-unloaded');
  updatePlayBtnState();

  var song = SONGS[key];
  if (!song) return;

  // Build placeholder tracks and show the player UI immediately
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  song.stems.forEach(function (stem) {
    var gainNode = audioCtx.createGain();
    gainNode.connect(audioCtx.destination);
    tracks.push({
      name: stem.name,
      category: categorize(stem.name),
      downloadUrl: stem.downloadUrl || stem.url,
      buffer: null,
      source: null,
      gainNode: gainNode,
      solo: false,
      muted: false,
      volume: 1,
      peaks: null,
      canvas: null,
      loaded: false
    });
  });

  playerEl.style.display = 'block';
  overallProgressWrap.style.display = 'none';
  downloadAllWrapper.style.display = 'none';
  renderTracks();
  updateTimeDisplay();
  updatePlayhead(0);
  renderAllFakeWaveforms();

  // Show size warning and dim waveforms until loaded
  var totalBytes = song.stems.reduce(function (sum, s) { return sum + (s.fileSize || 0); }, 0);
  var sizeStr = totalBytes > 0 ? formatBytes(totalBytes) : null;

  if (sizeStr) {
    transportSizeWarning.textContent = 'Playing will download ~' + sizeStr;
    transportSizeWarning.style.display = '';
  }

  waveformArea.classList.add('waveforms-unloaded');

  playBtn.onclick = function () {
    transportSizeWarning.style.display = 'none';
    waveformArea.classList.remove('waveforms-unloaded');
    playBtn.onclick = null;
    onSongChange(key, true);
  };
}

function buildSongList() {
  var keys = Object.keys(SONGS);

  if (keys.length === 0) {
    songListEl.innerHTML = '<p class="text-muted">No songs with stems available yet.</p>';
    return;
  }

  keys.forEach(function (key) {
    var song = SONGS[key];
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'song-item';
    item.setAttribute('data-song', key);

    var art = song.artUrl
      ? '<img class="song-item-art" src="' + song.artUrl + '" alt="">'
      : '<div class="song-item-art song-item-art-placeholder"></div>';

    item.innerHTML = art +
      '<div class="song-item-info">' +
        '<span class="song-item-title">' + song.title.split(' \u2014 ')[0] + '</span>' +
        (song.albumName ? '<span class="song-item-album">' + song.albumName + '</span>' : '') +
      '</div>';

    songListEl.appendChild(item);
  });
}

// --- Waveform Rendering ---
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
  // Normalize so the loudest peak = 1.0
  if (globalMax > 0) {
    for (var i = 0; i < numSamples; i++) {
      peaks[i] = peaks[i] / globalMax;
    }
  }
  return peaks;
}

function drawWaveform(canvas, peaks, playbackPct, rgb) {
  var ctx = canvas.getContext('2d');
  var w = canvas.width;
  var h = canvas.height;
  var barW = w / peaks.length;
  var splitX = playbackPct * w;
  var r = rgb[0], g = rgb[1], b = rgb[2];
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

function drawFakeWaveform(canvas, rgb) {
  var numSamples = 120;
  var peaks = new Float32Array(numSamples);
  // Generate smooth random peaks using a simple low-pass walk
  var val = 0.4 + Math.random() * 0.3;
  for (var i = 0; i < numSamples; i++) {
    val = val * 0.75 + (0.2 + Math.random() * 0.7) * 0.25;
    peaks[i] = val;
  }
  drawWaveform(canvas, peaks, 0, rgb);
}

function renderAllFakeWaveforms() {
  tracks.forEach(function (track) {
    if (track.canvas) {
      drawFakeWaveform(track.canvas, getCategoryColor(track.category));
    }
  });
}

function renderAllWaveforms(pct) {
  tracks.forEach(function (track) {
    if (track.canvas && track.peaks) {
      drawWaveform(track.canvas, track.peaks, pct || 0, getCategoryColor(track.category));
    }
  });
}

function updatePlayhead(pct) {
  // Position playhead relative to the canvas column, not the full waveform-area
  var firstCanvas = tracks.length > 0 && tracks[0].canvas;
  if (firstCanvas) {
    var areaRect = waveformArea.getBoundingClientRect();
    var canvasRect = firstCanvas.getBoundingClientRect();
    var canvasLeft = canvasRect.left - areaRect.left;
    var canvasW = canvasRect.width;
    var px = canvasLeft + pct * canvasW;
    playhead.style.left = px + 'px';
    playheadTime.style.left = px + 'px';
  } else {
    playhead.style.left = (pct * 100) + '%';
    playheadTime.style.left = (pct * 100) + '%';
  }
  playheadTime.textContent = formatTime(getCurrentTime());
}

// --- Song Loading ---
async function onSongChange(songKey, autoPlay) {
  if (!songKey || !SONGS[songKey]) {
    playerEl.style.display = 'none';
    downloadAllWrapper.style.display = 'none';
    return;
  }

  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  isLoading = true;
  autoPlayWhenLoaded = !!autoPlay;
  loadAbortController = new AbortController();
  var signal = loadAbortController.signal;
  var myGeneration = loadGeneration;
  updatePlayBtnState();

  var song = SONGS[songKey];

  // Show download-all if zipUrl exists
  if (song.zipUrl) {
    downloadAllBtn.href = song.zipUrl;
    downloadAllBtn.setAttribute('download', '');
    downloadAllWrapper.style.display = 'block';
  } else {
    downloadAllWrapper.style.display = 'none';
  }

  // Clear fake waveforms — blank canvases until real ones arrive
  tracks.forEach(function (track) {
    if (track.canvas) {
      var ctx = track.canvas.getContext('2d');
      ctx.clearRect(0, 0, track.canvas.width, track.canvas.height);
    }
  });

  overallProgressWrap.style.display = 'block';
  overallProgressFill.style.width = '0%';
  overallProgressLabel.style.color = '';
  overallProgressLabel.textContent = 'Loading stems\u2026';

  // Per-stem progress tracking
  // Each stem contributes two phases: download (weight 0.8) and decode+peaks (weight 0.2).
  // stemTotalBytes=0 means Content-Length unknown; we still track decode phase.
  var stemTotalBytes = new Array(song.stems.length).fill(0);
  var stemLoadedBytes = new Array(song.stems.length).fill(0);
  var stemDecoded = new Array(song.stems.length).fill(false); // true once decode+peaks done (or failed)

  function updateProgress() {
    var n = song.stems.length;
    // Download phase: use byte ratio when sizes are known, else count fully-downloaded stems
    var totalBytes = 0, loadedBytes = 0, knownCount = 0;
    for (var k = 0; k < n; k++) {
      if (stemTotalBytes[k] > 0) {
        totalBytes += stemTotalBytes[k];
        loadedBytes += stemLoadedBytes[k];
        knownCount++;
      }
    }
    var downloadPct = knownCount > 0 ? loadedBytes / totalBytes : 0;
    // Decode phase: fraction of stems fully decoded
    var decodedCount = stemDecoded.filter(Boolean).length;
    var decodePct = decodedCount / n;
    // Combined: download = 80%, decode = 20%
    var pct = (downloadPct * 0.8 + decodePct * 0.2) * 100;
    overallProgressFill.style.width = pct + '%';
  }

  // Load stems in parallel, updating waveforms as each arrives
  var loadedCount = 0;
  var failedCount = 0;
  await Promise.allSettled(
    song.stems.map(function (stem, i) {
      return fetch(stem.url, { signal: signal })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          var contentLength = r.headers.get('Content-Length');
          stemTotalBytes[i] = contentLength ? parseInt(contentLength, 10) : 0;
          // Stream the body so we can track download progress
          var reader = r.body.getReader();
          var chunks = [];
          function pump() {
            return reader.read().then(function (result) {
              if (result.done) return chunks;
              stemLoadedBytes[i] += result.value.length;
              // Update this track's loading bar
              if (tracks[i].loadingBar && stemTotalBytes[i] > 0) {
                tracks[i].loadingBar.style.width = (stemLoadedBytes[i] / stemTotalBytes[i] * 100) + '%';
              }
              updateProgress();
              chunks.push(result.value);
              return pump();
            });
          }
          return pump().then(function (chunks) {
            // Reassemble into ArrayBuffer
            var totalLen = chunks.reduce(function (s, c) { return s + c.length; }, 0);
            var combined = new Uint8Array(totalLen);
            var offset = 0;
            chunks.forEach(function (c) { combined.set(c, offset); offset += c.length; });
            // Mark stem as fully downloaded
            stemLoadedBytes[i] = stemTotalBytes[i] || totalLen;
            stemTotalBytes[i] = stemTotalBytes[i] || totalLen;
            if (tracks[i].loadingBar) {
              tracks[i].loadingBar.style.width = '100%';
            }
            updateProgress();
            return combined.buffer;
          });
        })
        .then(function (buf) { return audioCtx.decodeAudioData(buf); })
        .then(function (buffer) {
          if (loadGeneration !== myGeneration) return;
          tracks[i].buffer = buffer;
          tracks[i].peaks = getPeaks(buffer, WAVEFORM_SAMPLES);
          stemDecoded[i] = true;
          updateProgress();
          tracks[i].loaded = true;
          if (tracks[i].loadingBar) {
            tracks[i].loadingBar.remove();
            tracks[i].loadingBar = null;
          }
          // Update duration as stems load
          var wasZero = duration === 0;
          if (buffer.duration > duration) duration = buffer.duration;
          // If this is the first stem to set duration, apply any pre-seek
          if (wasZero && duration > 0 && seekPct > 0 && !isPlaying) {
            pauseOffset = seekPct * duration;
          }
          loadedCount++;
          overallProgressLabel.textContent = 'Loading stems\u2026 (' + (loadedCount + failedCount) + '/' + song.stems.length + ')';
          // Redraw this track's waveform
          var pct = duration > 0 ? getCurrentTime() / duration : seekPct;
          if (tracks[i].canvas) {
            drawWaveform(tracks[i].canvas, tracks[i].peaks, pct, getCategoryColor(tracks[i].category));
          }
          updateTimeDisplay();
          // If already playing, start this stem at the current position
          if (isPlaying && !tracks[i].source) {
            var offset = getCurrentTime();
            if (offset < buffer.duration) {
              var source = audioCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(tracks[i].gainNode);
              source.start(0, offset);
              tracks[i].source = source;
              updateGains();
            }
          }
        })
        .catch(function (err) {
          if (loadGeneration !== myGeneration) return;
          console.error('Failed to load stem "' + stem.name + '":', err);
          tracks[i].failed = true;
          failedCount++;
          // Count failed stem as fully done so the overall bar isn't stuck
          if (stemTotalBytes[i] === 0) stemTotalBytes[i] = 1;
          stemLoadedBytes[i] = stemTotalBytes[i];
          stemDecoded[i] = true;
          updateProgress();
          overallProgressLabel.textContent = 'Loading stems\u2026 (' + (loadedCount + failedCount) + '/' + song.stems.length + ')';
          // Replace the loading bar with an error indicator
          if (tracks[i].loadingBar) {
            tracks[i].loadingBar.remove();
            tracks[i].loadingBar = null;
          }
          if (tracks[i].canvas) {
            var wrap = tracks[i].canvas.parentElement;
            if (wrap) {
              var errEl = document.createElement('div');
              errEl.className = 'track-error';
              errEl.textContent = 'Failed to load';
              wrap.appendChild(errEl);
            }
          }
        });
    })
  );

  if (loadGeneration !== myGeneration) return;

  isLoading = false;
  loadAbortController = null;
  updatePlayBtnState();

  if (signal.aborted) return;

  if (failedCount > 0 && loadedCount === 0) {
    overallProgressLabel.textContent = 'Failed to load stems. Please try again.';
    overallProgressLabel.style.color = 'var(--color-error, #e05c5c)';
  } else if (failedCount > 0) {
    overallProgressLabel.textContent = failedCount + ' stem' + (failedCount > 1 ? 's' : '') + ' failed to load.';
    overallProgressLabel.style.color = 'var(--color-error, #e05c5c)';
  } else {
    overallProgressFill.style.width = '100%';
    overallProgressLabel.textContent = 'Ready';
    if (autoPlayWhenLoaded) play();
    setTimeout(function () {
      if (currentSongKey === songKey) overallProgressWrap.style.display = 'none';
    }, 800);
  }
  updatePlayhead(0);
  renderAllWaveforms(0);
}

// --- Playback ---
function updatePlayBtnState() {
  playBtn.classList.toggle('is-loading', isLoading);
  playBtn.classList.toggle('is-playing', isPlaying);
}

function togglePlay() {
  if (isLoading) {
    // Still loading — toggle whether we'll auto-play when done
    autoPlayWhenLoaded = !autoPlayWhenLoaded;
    isLoading = autoPlayWhenLoaded;
    updatePlayBtnState();
    return;
  }
  if (isPlaying) {
    pause();
  } else {
    // Pre-load state: clicking play starts loading
    if (playBtn.onclick) {
      playBtn.onclick();
    } else {
      play();
    }
  }
}

function play() {
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  var anyLoaded = false;
  tracks.forEach(function (track) {
    if (!track.buffer) return;
    var source = audioCtx.createBufferSource();
    source.buffer = track.buffer;
    source.connect(track.gainNode);
    source.start(0, pauseOffset);
    track.source = source;
    anyLoaded = true;
  });

  if (!anyLoaded) return;

  startTime = audioCtx.currentTime - pauseOffset;
  isPlaying = true;
  updatePlayBtnState();
  updateGains();
  tick();

  var firstLoadedTrack = tracks.find(function (t) { return t.source; });
  if (firstLoadedTrack) {
    firstLoadedTrack.source.onended = function () {
      if (isPlaying && getCurrentTime() >= duration - 0.1) {
        stopPlayback();
      }
    };
  }
}

function pause() {
  pauseOffset = getCurrentTime();
  stopSources();
  isPlaying = false;
  updatePlayBtnState();
  cancelAnimationFrame(animFrameId);
}

function stopPlayback() {
  stopSources();
  isPlaying = false;
  pauseOffset = 0;
  seekPct = 0;
  updatePlayBtnState();
  cancelAnimationFrame(animFrameId);
  updateTimeDisplay();
  updatePlayhead(0);
  renderAllWaveforms(0);
}

function stopSources() {
  tracks.forEach(function (track) {
    if (track.source) {
      try { track.source.stop(); } catch (e) { /* ignore */ }
      track.source = null;
    }
  });
}

function getCurrentTime() {
  if (!isPlaying) return pauseOffset;
  return audioCtx.currentTime - startTime;
}

// --- Seek ---
function seekToEvent(e) {
  // Calculate pct relative to the canvas column, not the full waveform-area
  var firstCanvas = tracks.length > 0 && tracks[0].canvas;
  var rect;
  if (firstCanvas) {
    rect = firstCanvas.getBoundingClientRect();
  } else {
    rect = waveformArea.getBoundingClientRect();
  }
  var pct = (e.clientX - rect.left) / rect.width;
  pct = Math.max(0, Math.min(1, pct));
  seekPct = pct;

  var wasPlaying = isPlaying;
  if (isPlaying) {
    stopSources();
    isPlaying = false;
  }
  pauseOffset = duration > 0 ? pct * duration : 0;
  updateTimeDisplay();
  updatePlayhead(pct);
  renderAllWaveforms(pct);

  if (wasPlaying) {
    play();
  }
}

// --- Progress Animation ---
function tick() {
  if (!isPlaying) return;
  var t = getCurrentTime();
  var pct = Math.min(t / duration, 1);
  updatePlayhead(pct);
  updateTimeDisplay();
  renderAllWaveforms(pct);
  animFrameId = requestAnimationFrame(tick);
}

function updateTimeDisplay() {
  var current = getCurrentTime();
  timeDisplay.textContent = formatTime(current) + ' / ' + formatTime(duration);
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  var m = Math.floor(sec / 60);
  var s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// --- Track Controls ---
function renderTracks() {
  trackListEl.innerHTML = '';

  // Group tracks by category
  var groups = {};
  var groupOrder = [];
  tracks.forEach(function (track, i) {
    var cat = track.category;
    if (!groups[cat]) {
      groups[cat] = [];
      groupOrder.push(cat);
    }
    groups[cat].push({ track: track, index: i });
  });

  // Sort groups by CATEGORIES order
  groupOrder.sort(function (a, b) {
    var ai = CATEGORIES.findIndex(function (c) { return c.key === a; });
    var bi = CATEGORIES.findIndex(function (c) { return c.key === b; });
    return ai - bi;
  });

  groupOrder.forEach(function (catKey) {
    var catInfo = CATEGORIES.find(function (c) { return c.key === catKey; });
    var items = groups[catKey];

    // Group container
    var groupEl = document.createElement('div');
    groupEl.className = 'track-group';

    // Group header with mute + solo toggles
    var header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML =
      '<div class="group-controls">' +
        '<button class="group-mute-btn" data-group="' + catKey + '" title="Mute/unmute group">M</button>' +
        '<button class="group-solo-btn" data-group-solo="' + catKey + '" title="Solo group">S</button>' +
      '</div>' +
      '<span class="group-label">' + catInfo.label + '</span>' +
      '<span class="group-count">' + items.length + '</span>';
    groupEl.appendChild(header);

    // Individual tracks
    items.forEach(function (item) {
      var track = item.track;
      var i = item.index;
      var row = document.createElement('div');
      row.className = 'track-row';

      // Controls (mute + solo) — on the LEFT
      var controls = document.createElement('div');
      controls.className = 'track-controls';
      controls.innerHTML =
        '<button class="track-btn-mute" data-action="mute" data-index="' + i + '" aria-label="Mute" title="Mute">M</button>' +
        '<button class="track-btn-solo" data-action="solo" data-index="' + i + '" aria-label="Solo" title="Solo">S</button>';

      // Waveform canvas with overlaid label
      var canvasWrap = document.createElement('div');
      canvasWrap.className = 'track-waveform';
      var label = document.createElement('span');
      label.className = 'track-label';
      label.textContent = track.name;
      var canvas = document.createElement('canvas');
      canvas.height = TRACK_HEIGHT * (window.devicePixelRatio || 1);
      canvas.width = 800;
      canvasWrap.appendChild(label);
      canvasWrap.appendChild(canvas);
      track.canvas = canvas;
      // Loading bar for unloaded tracks — colored to match waveform category
      if (!track.loaded) {
        var loadBar = document.createElement('div');
        loadBar.className = 'track-loading-bar';
        var rgb = getCategoryColor(track.category);
        loadBar.style.backgroundColor = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.6)';
        canvasWrap.appendChild(loadBar);
        track.loadingBar = loadBar;
      }

      // Download button — on the RIGHT
      var dlBtn = document.createElement('a');
      dlBtn.className = 'track-download-btn';
      dlBtn.href = track.downloadUrl;
      dlBtn.setAttribute('download', '');
      dlBtn.setAttribute('title', 'Download stem');
      dlBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">' +
          '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>' +
        '</svg>';

      row.appendChild(controls);
      row.appendChild(canvasWrap);
      row.appendChild(dlBtn);
      groupEl.appendChild(row);
    });

    trackListEl.appendChild(groupEl);
  });

  // Size canvases to their container
  resizeCanvases();
  window.addEventListener('resize', resizeCanvases);
}

function resizeCanvases() {
  var dpr = window.devicePixelRatio || 1;
  tracks.forEach(function (track) {
    if (track.canvas) {
      var wrap = track.canvas.parentElement;
      if (wrap) {
        track.canvas.width = wrap.clientWidth * dpr;
        track.canvas.height = TRACK_HEIGHT * dpr;
        track.canvas.style.width = wrap.clientWidth + 'px';
        track.canvas.style.height = TRACK_HEIGHT + 'px';
      }
    }
  });
  var pct = duration > 0 ? getCurrentTime() / duration : 0;
  renderAllWaveforms(pct);
}

function toggleSolo(index) {
  tracks[index].solo = !tracks[index].solo;
  updateGains();
  updateTrackButtons();
}

function toggleMute(index) {
  tracks[index].muted = !tracks[index].muted;
  updateGains();
  updateTrackButtons();
}

function clearAllSolos() {
  tracks.forEach(function (t) { t.solo = false; });
  updateGains();
  updateTrackButtons();
}

function clearAllMutes() {
  tracks.forEach(function (t) { t.muted = false; });
  updateGains();
  updateTrackButtons();
}

function toggleGroupMute(catKey) {
  var groupTracks = tracks.filter(function (t) { return t.category === catKey; });
  var anyUnmuted = groupTracks.some(function (t) { return !t.muted; });

  tracks.forEach(function (track) {
    if (track.category === catKey) {
      track.muted = anyUnmuted;
    }
  });

  updateGains();
  updateTrackButtons();
  updateGroupButtons();
}

function toggleGroupSolo(catKey) {
  var groupTracks = tracks.filter(function (t) { return t.category === catKey; });
  var allSoloed = groupTracks.every(function (t) { return t.solo; });

  tracks.forEach(function (track) {
    if (track.category === catKey) {
      track.solo = !allSoloed;
    }
  });

  updateGains();
  updateTrackButtons();
  updateGroupButtons();
}

function updateGains() {
  var anySolo = tracks.some(function (t) { return t.solo; });

  tracks.forEach(function (track) {
    var vol = track.volume;
    if (track.muted) {
      vol = 0;
    } else if (anySolo && !track.solo) {
      vol = 0;
    }
    track.gainNode.gain.setValueAtTime(vol, audioCtx ? audioCtx.currentTime : 0);
  });
}

function updateTrackButtons() {
  var rows = trackListEl.querySelectorAll('.track-row');
  rows.forEach(function (row, i) {
    // Find the track index from the mute button's data-index
    var muteBtn = row.querySelector('[data-action="mute"]');
    var soloBtn = row.querySelector('[data-action="solo"]');
    if (!muteBtn || !soloBtn) return;
    var idx = parseInt(muteBtn.getAttribute('data-index'), 10);
    soloBtn.classList.toggle('active', tracks[idx].solo);
    muteBtn.classList.toggle('active', tracks[idx].muted);
  });
  updateGroupButtons();
}

function updateGroupButtons() {
  var muteBtns = trackListEl.querySelectorAll('.group-mute-btn');
  muteBtns.forEach(function (btn) {
    var catKey = btn.getAttribute('data-group');
    var groupTracks = tracks.filter(function (t) { return t.category === catKey; });
    var allMuted = groupTracks.every(function (t) { return t.muted; });
    btn.classList.toggle('active', allMuted);
  });

  var soloBtns = trackListEl.querySelectorAll('.group-solo-btn');
  soloBtns.forEach(function (btn) {
    var catKey = btn.getAttribute('data-group-solo');
    var groupTracks = tracks.filter(function (t) { return t.category === catKey; });
    var allSoloed = groupTracks.every(function (t) { return t.solo; });
    btn.classList.toggle('active', allSoloed);
  });
}

// --- Boot ---
init();
