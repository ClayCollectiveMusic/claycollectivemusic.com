/**
 * Clay Collective — Multitrack Stem Player
 *
 * Uses the Web Audio API to load and play multiple stems simultaneously,
 * with per-track solo, mute, volume controls, and download links.
 *
 * CONFIGURATION:
 * Edit the SONGS object below to add your songs and stem URLs.
 * Each stem needs a `name`, `url` (for playback), and optional `downloadUrl`
 * (if different from url). Add a `zipUrl` for the "Download All" button.
 */

var SONGS = {
  // Example song configuration — replace with real audio file URLs
  // 'song-title-one': {
  //   title: 'Song Title One',
  //   zipUrl: 'audio/song1/all-stems.zip',
  //   stems: [
  //     { name: 'Lead Vocal',   url: 'audio/song1/lead-vocal.mp3',     downloadUrl: 'audio/song1/lead-vocal.wav' },
  //     { name: 'BG Vocals',    url: 'audio/song1/bg-vocals.mp3',      downloadUrl: 'audio/song1/bg-vocals.wav' },
  //     { name: 'Electric Gtr', url: 'audio/song1/electric-guitar.mp3', downloadUrl: 'audio/song1/electric-guitar.wav' },
  //     { name: 'Acoustic Gtr', url: 'audio/song1/acoustic-guitar.mp3', downloadUrl: 'audio/song1/acoustic-guitar.wav' },
  //     { name: 'Keys',         url: 'audio/song1/keys.mp3',           downloadUrl: 'audio/song1/keys.wav' },
  //     { name: 'Bass',         url: 'audio/song1/bass.mp3',           downloadUrl: 'audio/song1/bass.wav' },
  //     { name: 'Drums',        url: 'audio/song1/drums.mp3',          downloadUrl: 'audio/song1/drums.wav' },
  //   ]
  // },
};

// --- State ---
var audioCtx = null;
var tracks = [];
var currentSongKey = null;
var isPlaying = false;
var startTime = 0;
var pauseOffset = 0;
var duration = 0;
var animFrameId = null;

// --- DOM ---
var songSelect = document.getElementById('song-select');
var playerEl = document.getElementById('player');
var loadingMsg = document.getElementById('loading-msg');
var playBtn = document.getElementById('play-btn');
var progressBar = document.getElementById('progress-bar');
var progressFill = document.getElementById('progress-fill');
var timeDisplay = document.getElementById('time-display');
var trackListEl = document.getElementById('track-list');
var downloadAllWrapper = document.getElementById('download-all-wrapper');
var downloadAllBtn = document.getElementById('download-all-btn');

// --- Init ---
function init() {
  populateSongSelect();
  songSelect.addEventListener('change', onSongChange);
  playBtn.addEventListener('click', togglePlay);
  progressBar.addEventListener('click', onSeek);
}

function populateSongSelect() {
  var keys = Object.keys(SONGS);
  keys.forEach(function (key) {
    var opt = document.createElement('option');
    opt.value = key;
    opt.textContent = SONGS[key].title;
    songSelect.appendChild(opt);
  });

  if (keys.length === 0) {
    var opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No songs configured yet';
    opt.disabled = true;
    songSelect.appendChild(opt);
  }
}

// --- Song Loading ---
async function onSongChange() {
  stopPlayback();

  var songKey = songSelect.value;
  if (!songKey || !SONGS[songKey]) {
    playerEl.style.display = 'none';
    downloadAllWrapper.style.display = 'none';
    return;
  }

  loadingMsg.style.display = 'block';
  loadingMsg.textContent = 'Loading stems\u2026';
  playerEl.style.display = 'none';
  downloadAllWrapper.style.display = 'none';

  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  var song = SONGS[songKey];
  currentSongKey = songKey;
  tracks = [];

  try {
    var buffers = await Promise.all(
      song.stems.map(function (stem) {
        return fetch(stem.url)
          .then(function (r) { return r.arrayBuffer(); })
          .then(function (buf) { return audioCtx.decodeAudioData(buf); });
      })
    );

    buffers.forEach(function (buffer, i) {
      var gainNode = audioCtx.createGain();
      gainNode.connect(audioCtx.destination);

      tracks.push({
        name: song.stems[i].name,
        downloadUrl: song.stems[i].downloadUrl || song.stems[i].url,
        buffer: buffer,
        source: null,
        gainNode: gainNode,
        solo: false,
        muted: false,
        volume: 1
      });
    });

    duration = Math.max.apply(null, buffers.map(function (b) { return b.duration; }));
    pauseOffset = 0;

    renderTracks();
    updateTimeDisplay();

    // Show download-all if zipUrl exists
    if (song.zipUrl) {
      downloadAllBtn.href = song.zipUrl;
      downloadAllBtn.setAttribute('download', '');
      downloadAllWrapper.style.display = 'block';
    } else {
      downloadAllWrapper.style.display = 'none';
    }

    loadingMsg.style.display = 'none';
    playerEl.style.display = 'block';
  } catch (err) {
    loadingMsg.textContent = 'Error loading stems. Please try again.';
    console.error('Failed to load stems:', err);
  }
}

// --- Playback ---
function togglePlay() {
  if (isPlaying) {
    pause();
  } else {
    play();
  }
}

function play() {
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  tracks.forEach(function (track) {
    var source = audioCtx.createBufferSource();
    source.buffer = track.buffer;
    source.connect(track.gainNode);
    source.start(0, pauseOffset);
    track.source = source;
  });

  startTime = audioCtx.currentTime - pauseOffset;
  isPlaying = true;
  playBtn.innerHTML = '&#9646;&#9646;';
  updateGains();
  tick();

  if (tracks.length > 0) {
    tracks[0].source.onended = function () {
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
  playBtn.innerHTML = '&#9654;';
  cancelAnimationFrame(animFrameId);
}

function stopPlayback() {
  stopSources();
  isPlaying = false;
  pauseOffset = 0;
  playBtn.innerHTML = '&#9654;';
  progressFill.style.width = '0%';
  cancelAnimationFrame(animFrameId);
  updateTimeDisplay();
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
function onSeek(e) {
  var rect = progressBar.getBoundingClientRect();
  var pct = (e.clientX - rect.left) / rect.width;
  pct = Math.max(0, Math.min(1, pct));
  var seekTime = pct * duration;

  var wasPlaying = isPlaying;
  if (isPlaying) {
    stopSources();
    isPlaying = false;
  }
  pauseOffset = seekTime;
  updateTimeDisplay();
  progressFill.style.width = (pct * 100) + '%';

  if (wasPlaying) {
    play();
  }
}

// --- Progress Animation ---
function tick() {
  if (!isPlaying) return;
  var t = getCurrentTime();
  var pct = Math.min(t / duration, 1);
  progressFill.style.width = (pct * 100) + '%';
  updateTimeDisplay();
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
  tracks.forEach(function (track, i) {
    var row = document.createElement('div');
    row.className = 'track-row';
    row.innerHTML =
      '<span class="track-name">' + track.name + '</span>' +
      '<div class="track-controls">' +
        '<button data-action="solo" data-index="' + i + '">S</button>' +
        '<button data-action="mute" data-index="' + i + '">M</button>' +
      '</div>' +
      '<input type="range" class="track-volume" min="0" max="1" step="0.01" value="1" data-index="' + i + '" />' +
      '<span class="track-download"><a href="' + track.downloadUrl + '" download>Download</a></span>';
    trackListEl.appendChild(row);
  });

  trackListEl.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var idx = parseInt(btn.getAttribute('data-index'), 10);
    var action = btn.getAttribute('data-action');
    if (action === 'solo') toggleSolo(idx);
    if (action === 'mute') toggleMute(idx);
  });

  trackListEl.addEventListener('input', function (e) {
    if (e.target.matches('.track-volume')) {
      var idx = parseInt(e.target.getAttribute('data-index'), 10);
      tracks[idx].volume = parseFloat(e.target.value);
      updateGains();
    }
  });
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
    var soloBtn = row.querySelector('[data-action="solo"]');
    var muteBtn = row.querySelector('[data-action="mute"]');
    soloBtn.className = tracks[i].solo ? 'active-solo' : '';
    muteBtn.className = tracks[i].muted ? 'active-mute' : '';
  });
}

// --- Boot ---
init();
