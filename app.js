// ambiloop v1.1 — ambient audio layer composer
// Pure client-side: Web Audio API + OLA pitch shifting + WAV export
// Added: per-layer trim, offset, timeline blocks with drag, crossfade looping

const LAYER_COLORS = ['#e94560','#0f3460','#533483','#2ecc71','#f39c12','#3498db','#e74c3c','#1abc9c'];

const state = {
  layers: [],           // { id, name, buffer, gain, pitchSemitones, color, muted, trimStart, trimEnd, offset }
  audioCtx: null,       // AudioContext for preview
  playing: false,
  nextId: 1,
  loopCrossfade: 2.0,   // seconds, 0 = disabled
  dragging: null,        // { id, startX, startOffset }
  splitMode: false,      // split tool active
  zoom: 40,             // pixels per second — timeline scale
  previewStartTime: 0,  // AudioContext.currentTime when preview started (for playhead)
  animFrame: null       // requestAnimationFrame ID for playhead
};

// ── DOM refs ──────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const dropZone = $('#dropZone');
const fileInput = $('#fileInput');
const layerList = $('#layerList');
const layerCount = $('#layerCount');
const timelineRuler = $('#timelineRuler');
const timelineTracks = $('#timelineTracks');
const timelineScroll = $('#timelineScroll');
const playBtn = $('#playBtn');
const stopBtn = $('#stopBtn');
const exportBtn = $('#exportBtn');
const statusBar = $('#statusBar');
const crossfadeToggle = $('#crossfadeToggle');
const crossfadeDur = $('#crossfadeDur');
const splitBtn = $('#splitBtn');
const zoomSlider = $('#zoomSlider');
const masterTimeline = $('#masterTimeline');
const masterPlayhead = $('#masterPlayhead');
const masterTime = $('#masterTime');

// ── State helpers ──────────────────────────────────────
function setStatus(msg) { statusBar.textContent = msg; }
function updateButtons() {
  const hasLayers = state.layers.length > 0;
  playBtn.disabled = !hasLayers;
  stopBtn.disabled = !hasLayers;
  exportBtn.disabled = !hasLayers;
}

function getTrimmedDuration(layer) {
  return layer.trimEnd - layer.trimStart;
}

function getTotalDuration() {
  let maxEnd = 0;
  for (const l of state.layers) {
    const end = l.offset + getTrimmedDuration(l);
    if (end > maxEnd) maxEnd = end;
  }
  return Math.max(maxEnd, 1); // at least 1 second
}

// ── Audio context (lazy init on user gesture) ──────────
function getAudioCtx() {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (state.audioCtx.state === 'suspended') {
    state.audioCtx.resume();
  }
  return state.audioCtx;
}

// ── File loading ───────────────────────────────────────
async function loadFiles(files) {
  const ctx = getAudioCtx();
  setStatus(`Loading ${files.length} file(s)...`);

  for (const file of files) {
    if (!file.type.startsWith('audio/') && !file.name.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i)) continue;

    try {
      const arrayBuf = await file.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrayBuf);

      const layer = {
        id: state.nextId++,
        name: file.name,
        buffer: audioBuf,
        gain: 0.8,
        pitchSemitones: 0,
        color: LAYER_COLORS[(state.layers.length) % LAYER_COLORS.length],
        muted: false,
        trimStart: 0,
        trimEnd: audioBuf.duration,
        offset: 0
      };

      state.layers.push(layer);
      setStatus(`Loaded: ${file.name}`);
    } catch (err) {
      setStatus(`Failed to load ${file.name}: ${err.message}`);
    }
  }

  renderAll();
}

// ── Render ─────────────────────────────────────────────
function renderAll() {
  renderLayers();
  renderTimeline();
  renderMasterTimeline();
  updateButtons();
  layerCount.textContent = state.layers.length;
}

function renderLayers() {
  if (state.layers.length === 0) {
    layerList.innerHTML = '<div class="empty-state">Drop audio files to begin</div>';
    return;
  }

  layerList.innerHTML = state.layers.map(l => {
    const dur = l.buffer.duration;
    return `
    <div class="layer-card" data-id="${l.id}">
      <div class="layer-header">
        <span class="layer-color" style="background:${l.color}"></span>
        <span class="layer-name" title="${l.name}">${l.name}</span>
        <span class="layer-dur">${formatTime(dur)}</span>
        <button class="layer-duplicate" data-action="duplicate" data-id="${l.id}" title="Duplicate">&#9112;</button>
        <button class="layer-remove" data-action="remove" data-id="${l.id}">&times;</button>
      </div>

      <div class="layer-controls">
        <div class="layer-control">
          <span class="layer-label">Vol</span>
          <input type="range" min="0" max="100" value="${Math.round(l.gain * 100)}"
                 data-action="gain" data-id="${l.id}" class="slider">
          <span class="layer-value">${Math.round(l.gain * 100)}%</span>
        </div>

        <div class="layer-control">
          <span class="layer-label">Pitch</span>
          <input type="range" min="-24" max="24" value="${l.pitchSemitones}" step="0.5"
                 data-action="pitch" data-id="${l.id}" class="slider">
          <span class="layer-value">${l.pitchSemitones > 0 ? '+' : ''}${l.pitchSemitones.toFixed(1)} st</span>
        </div>

        <div class="layer-control trim-offset-row">
          <div class="layer-control">
            <span class="layer-label">Offset</span>
            <input type="number" value="${l.offset.toFixed(1)}" step="0.1" min="0"
                   data-action="offset" data-id="${l.id}" class="num-input">
            <span class="layer-value">s</span>
          </div>

          <div class="layer-control">
            <span class="layer-label">Trim</span>
            <input type="number" value="${l.trimStart.toFixed(1)}" step="0.1" min="0" max="${dur.toFixed(1)}"
                   data-action="trimStart" data-id="${l.id}" class="num-input">
            <span class="layer-value">→</span>
            <input type="number" value="${l.trimEnd.toFixed(1)}" step="0.1" min="0" max="${dur.toFixed(1)}"
                   data-action="trimEnd" data-id="${l.id}" class="num-input">
            <span class="layer-value">s</span>
          </div>
        </div>
      </div>
    </div>
    `;
  }).join('');
}

function renderTimeline() {
  if (state.layers.length === 0) {
    timelineRuler.innerHTML = '';
    timelineTracks.innerHTML = '<div class="empty-state">Add layers to see the timeline</div>';
    return;
  }

  const totalDur = getTotalDuration();
  const totalWidth = totalDur * state.zoom;

  // Ruler with time markers
  let rulerHTML = '';
  const tickInterval = totalDur > 60 ? 10 : (totalDur > 30 ? 5 : 1);
  for (let t = 0; t <= totalDur; t += tickInterval) {
    const x = t * state.zoom;
    rulerHTML += `<span class="ruler-tick" style="left:${x}px">${formatTime(t)}</span>`;
  }
  timelineRuler.innerHTML = rulerHTML;
  timelineRuler.style.width = totalWidth + 'px';

  // Tracks with waveform canvases
  timelineTracks.innerHTML = state.layers.map(l => {
    const trimmedDur = getTrimmedDuration(l);
    const left = l.offset * state.zoom;
    const width = Math.max(trimmedDur * state.zoom, 4); // min 4px

    return `
    <div class="timeline-track">
      <canvas class="timeline-block" data-id="${l.id}"
           width="${width}" height="28"
           style="left:${left}px; width:${width}px;"
           title="${l.name} (offset: ${l.offset.toFixed(1)}s, trim: ${l.trimStart.toFixed(1)}→${l.trimEnd.toFixed(1)}s)">
      </canvas>
      <span class="block-label" style="left:${left + 4}px">${l.name}</span>
    </div>
    `;
  }).join('');

  timelineTracks.style.width = totalWidth + 'px';

  // Draw waveforms after DOM settles
  requestAnimationFrame(() => {
    state.layers.forEach(l => {
      const canvas = timelineTracks.querySelector(`canvas[data-id="${l.id}"]`);
      if (canvas) drawWaveform(canvas, l);
    });
  });
}

// ── Waveform drawing ────────────────────────────────────
function drawWaveform(canvas, layer) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // Subtle background fill at low opacity
  ctx.fillStyle = layer.color + '18';
  ctx.fillRect(0, 0, w, h);

  const sr = layer.buffer.sampleRate;
  const trimStartSample = Math.floor(layer.trimStart * sr);
  const trimEndSample = Math.floor(Math.min(layer.trimEnd, layer.buffer.duration) * sr);
  const data = layer.buffer.getChannelData(0).subarray(trimStartSample, trimEndSample);
  const len = data.length;

  if (len < 1) return;

  const mid = h / 2;
  const maxAmp = mid - 1;

  ctx.strokeStyle = layer.color;
  ctx.lineWidth = 1;

  for (let px = 0; px < w; px++) {
    const bucketStart = Math.floor((px / w) * len);
    const bucketEnd = Math.floor(((px + 1) / w) * len);
    let peak = 0;
    for (let i = bucketStart; i < bucketEnd; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }

    const drawHeight = peak * maxAmp;
    ctx.beginPath();
    ctx.moveTo(px + 0.5, mid - drawHeight);
    ctx.lineTo(px + 0.5, mid + drawHeight);
    ctx.stroke();
  }
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Event delegation for layer controls ────────────────
layerList.addEventListener('input', (e) => {
  const id = parseInt(e.target.dataset.id);
  const layer = state.layers.find(l => l.id === id);
  if (!layer) return;

  const action = e.target.dataset.action;
  if (action === 'gain') {
    layer.gain = e.target.value / 100;
  } else if (action === 'pitch') {
    layer.pitchSemitones = parseFloat(e.target.value);
  } else if (action === 'offset') {
    layer.offset = parseFloat(e.target.value) || 0;
  } else if (action === 'trimStart') {
    const val = parseFloat(e.target.value) || 0;
    layer.trimStart = Math.max(0, Math.min(val, layer.buffer.duration));
  } else if (action === 'trimEnd') {
    const val = parseFloat(e.target.value) || layer.buffer.duration;
    layer.trimEnd = Math.max(0, Math.min(val, layer.buffer.duration));
  }

  renderAll();
});

layerList.addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  const id = parseInt(e.target.dataset.id);

  if (action === 'remove') {
    state.layers = state.layers.filter(l => l.id !== id);
    renderAll();
    if (state.playing) stopPreview();
  } else if (action === 'duplicate') {
    duplicateLayer(id);
  }
});

// ── File drop / pick ───────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) loadFiles(fileInput.files);
  fileInput.value = '';
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

// ── Timeline block dragging ────────────────────────────
timelineTracks.addEventListener('mousedown', (e) => {
  const block = e.target.closest('.timeline-block');
  if (!block) return;
  e.preventDefault();

  const id = parseInt(block.dataset.id);
  const layer = state.layers.find(l => l.id === id);
  if (!layer) return;

  if (state.splitMode) {
    splitLayerAt(layer, block, e);
    return;
  }

  state.dragging = {
    id: id,
    startX: e.clientX,
    startOffset: layer.offset
  };
  block.classList.add('dragging');
});

document.addEventListener('mousemove', (e) => {
  if (!state.dragging) return;
  e.preventDefault();

  const layer = state.layers.find(l => l.id === state.dragging.id);
  if (!layer) return;

  const dx = e.clientX - state.dragging.startX;
  const newOffset = state.dragging.startOffset + dx / state.zoom;
  layer.offset = Math.max(0, Math.round(newOffset * 10) / 10); // snap to 0.1s

  // Live update the block position
  const block = timelineTracks.querySelector(`.timeline-block[data-id="${layer.id}"]`);
  if (block) {
    block.style.left = (layer.offset * state.zoom) + 'px';
  }

  // Update ruler/tracks width if needed
  const totalDur = getTotalDuration();
  const totalWidth = totalDur * state.zoom;
  timelineRuler.style.width = totalWidth + 'px';
  timelineTracks.style.width = totalWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (!state.dragging) return;

  const block = timelineTracks.querySelector(`.timeline-block[data-id="${state.dragging.id}"]`);
  if (block) block.classList.remove('dragging');

  state.dragging = null;
  renderAll(); // sync layer list inputs
});

// ── Split tool ──────────────────────────────────────────
function splitLayerAt(layer, block, clickEvent) {
  const rect = block.getBoundingClientRect();
  const clickX = clickEvent.clientX - rect.left;
  const fraction = Math.max(0.05, Math.min(0.95, clickX / rect.width));
  const trimmedDur = layer.trimEnd - layer.trimStart;
  const splitTime = layer.trimStart + fraction * trimmedDur;

  // Snap to 0.1s
  const cutPoint = Math.round(splitTime * 10) / 10;

  // Reject if cut is too close to edges
  if (cutPoint <= layer.trimStart + 0.15 || cutPoint >= layer.trimEnd - 0.15) {
    setStatus('Click closer to the middle of the block to split');
    return;
  }

  // Right side becomes a new layer
  const rightLayer = {
    id: state.nextId++,
    name: layer.name + ' (split)',
    buffer: layer.buffer,
    gain: layer.gain,
    pitchSemitones: layer.pitchSemitones,
    color: LAYER_COLORS[(state.layers.length) % LAYER_COLORS.length],
    muted: false,
    trimStart: cutPoint,
    trimEnd: layer.trimEnd,
    offset: layer.offset + (cutPoint - layer.trimStart)
  };

  // Current layer gets trimmed at the cut point
  layer.trimEnd = cutPoint;

  // Insert right after the current layer
  const idx = state.layers.indexOf(layer);
  state.layers.splice(idx + 1, 0, rightLayer);

  setStatus(`Split at ${cutPoint.toFixed(1)}s → new layer "${rightLayer.name}"`);
  renderAll();
}

// ── Duplicate layer ─────────────────────────────────────
function duplicateLayer(id) {
  const layer = state.layers.find(l => l.id === id);
  if (!layer) return;

  const clone = {
    id: state.nextId++,
    name: layer.name + ' (copy)',
    buffer: layer.buffer,
    gain: layer.gain,
    pitchSemitones: layer.pitchSemitones,
    color: LAYER_COLORS[(state.layers.length) % LAYER_COLORS.length],
    muted: layer.muted,
    trimStart: layer.trimStart,
    trimEnd: layer.trimEnd,
    offset: layer.offset
  };

  const idx = state.layers.indexOf(layer);
  state.layers.splice(idx + 1, 0, clone);

  setStatus(`Duplicated "${layer.name}"`);
  renderAll();
}

// ── Preview playback ───────────────────────────────────
let previewNodes = [];

function stopPreview() {
  previewNodes.forEach(n => {
    try { n.source.stop(); } catch(e) {}
  });
  previewNodes = [];
  state.playing = false;
  playBtn.classList.remove('playing');
  playBtn.innerHTML = '&#9654; Play';
  if (state.animFrame) { cancelAnimationFrame(state.animFrame); state.animFrame = null; }
  if (masterPlayhead) masterPlayhead.style.display = 'none';
}

async function startPreview() {
  if (state.layers.length === 0) return;
  if (state.playing) { stopPreview(); return; }

  const ctx = getAudioCtx();
  stopPreview();

  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.7;
  masterGain.connect(ctx.destination);

  const now = ctx.currentTime;

  for (const layer of state.layers) {
    if (layer.muted) continue;

    const source = ctx.createBufferSource();
    source.buffer = layer.buffer;
    source.loop = true;

    // Trim as loop region
    if (layer.trimStart > 0 || layer.trimEnd < layer.buffer.duration) {
      source.loopStart = layer.trimStart;
      source.loopEnd = layer.trimEnd;
    }

    const rate = Math.pow(2, layer.pitchSemitones / 12);
    source.playbackRate.value = rate;

    const gainNode = ctx.createGain();
    gainNode.gain.value = layer.gain;

    source.connect(gainNode);
    gainNode.connect(masterGain);
    source.start(now + layer.offset, 0);

    previewNodes.push({ source, gain: gainNode });
  }

  state.playing = true;
  playBtn.classList.add('playing');
  playBtn.innerHTML = '&#9646;&#9646; Pause';
  setStatus('Playing...');

  // Start playhead animation
  state.previewStartTime = ctx.currentTime;
  if (masterPlayhead) masterPlayhead.style.display = 'block';
  animatePlayhead();
}

// ── Playhead animation ──────────────────────────────────
function animatePlayhead() {
  if (!state.playing) return;
  const elapsed = state.audioCtx.currentTime - state.previewStartTime;
  const totalDur = getTotalDuration();

  if (masterPlayhead) {
    const pct = Math.min((elapsed / totalDur) * 100, 100);
    masterPlayhead.style.left = pct + '%';
  }
  if (masterTime) {
    masterTime.textContent = formatTime(elapsed) + ' / ' + formatTime(totalDur);
  }

  state.animFrame = requestAnimationFrame(animatePlayhead);
}

// ── Master timeline (overview + seek) ────────────────────
function renderMasterTimeline() {
  if (!masterTimeline) return;
  if (state.layers.length === 0) {
    masterTimeline.innerHTML = '';
    if (masterPlayhead) masterPlayhead.style.display = 'none';
    if (masterTime) masterTime.textContent = '';
    return;
  }

  const totalDur = getTotalDuration();
  // Draw a thin colored band for each layer showing its position in the total mix
  masterTimeline.innerHTML = state.layers.map(l => {
    const trimmedDur = getTrimmedDuration(l);
    const leftPct = (l.offset / totalDur) * 100;
    const widthPct = (trimmedDur / totalDur) * 100;
    return `<div class="master-layer-band" style="left:${leftPct}%;width:${widthPct}%;background:${l.color}" title="${l.name}"></div>`;
  }).join('');

  if (masterTime) {
    masterTime.textContent = '0:00 / ' + formatTime(totalDur);
  }
}

// ── Seek to position ────────────────────────────────────
function seekTo(frac) {
  if (state.playing) stopPreview();

  const totalDur = getTotalDuration();
  const seekTime = frac * totalDur;

  // Update playhead position visually
  if (masterPlayhead) {
    masterPlayhead.style.left = (frac * 100) + '%';
    masterPlayhead.style.display = 'block';
  }
  if (masterTime) {
    masterTime.textContent = formatTime(seekTime) + ' / ' + formatTime(totalDur);
  }

  // Always start from seek position
  startPreviewFrom(seekTime);
}

// ── Preview from specific time ───────────────────────────
async function startPreviewFrom(seekTime) {
  if (state.layers.length === 0) return;

  const ctx = getAudioCtx();
  stopPreview();

  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.7;
  masterGain.connect(ctx.destination);

  const now = ctx.currentTime;

  for (const layer of state.layers) {
    if (layer.muted) continue;

    const trimmedDur = getTrimmedDuration(layer);
    const layerEnd = layer.offset + trimmedDur;
    const source = ctx.createBufferSource();
    source.buffer = layer.buffer;
    source.loop = true;

    if (layer.trimStart > 0 || layer.trimEnd < layer.buffer.duration) {
      source.loopStart = layer.trimStart;
      source.loopEnd = layer.trimEnd;
    }

    const rate = Math.pow(2, layer.pitchSemitones / 12);
    source.playbackRate.value = rate;

    const gainNode = ctx.createGain();
    gainNode.gain.value = layer.gain;

    source.connect(gainNode);
    gainNode.connect(masterGain);

    // Calculate when (relative to 'now') this layer should start
    // and what offset into its audio to begin at
    if (seekTime <= layer.offset) {
      // Layer hasn't started yet — schedule it
      const delay = layer.offset - seekTime;
      source.start(now + delay, 0);
    } else if (seekTime < layerEnd) {
      // Layer is mid-playback
      const localPos = seekTime - layer.offset;
      source.start(now, layer.trimStart + localPos);
    } else {
      // Layer already finished — skip
      continue;
    }

    previewNodes.push({ source, gain: gainNode });
  }

  state.playing = true;
  playBtn.classList.add('playing');
  playBtn.innerHTML = '&#9646;&#9646; Pause';
  setStatus('Playing from ' + formatTime(seekTime) + '...');

  state.previewStartTime = ctx.currentTime - seekTime; // so elapsed = ctx.currentTime - previewStartTime = seekTime
  if (masterPlayhead) masterPlayhead.style.display = 'block';
  animatePlayhead();
}

playBtn.addEventListener('click', () => {
  if (state.playing) stopPreview();
  else startPreview();
});
stopBtn.addEventListener('click', stopPreview);

// ── OLA Time Stretch (preserves pitch, changes duration) ──
function olaTimeStretch(input, factor) {
  const inLen = input.length;
  const outLen = Math.floor(inLen * factor);
  if (outLen < 1 || inLen < 1) return new Float32Array(0);

  const output = new Float32Array(outLen);
  const norm = new Float32Array(outLen);

  const frameSize = Math.min(4096, Math.floor(inLen / 4));
  if (frameSize < 64) {
    for (let i = 0; i < outLen; i++) {
      const srcIdx = Math.floor(i / factor);
      output[i] = input[Math.min(srcIdx, inLen - 1)];
    }
    return output;
  }

  const hopSize = Math.max(1, Math.floor(frameSize / 8));

  // Hann window
  const window = new Float32Array(frameSize);
  for (let i = 0; i < frameSize; i++) {
    window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (frameSize - 1)));
  }

  let outPos = 0;
  while (outPos + frameSize <= outLen) {
    const inPos = Math.floor(outPos / factor);

    if (inPos + frameSize <= inLen) {
      for (let i = 0; i < frameSize; i++) {
        const w = window[i];
        output[outPos + i] += input[inPos + i] * w;
        norm[outPos + i] += w;
      }
    }
    outPos += hopSize;
  }

  // Normalize
  for (let i = 0; i < outLen; i++) {
    if (norm[i] > 1e-6) {
      output[i] /= norm[i];
    }
  }

  return output;
}

// ── True pitch shift: OLA stretch + playbackRate ────────
async function pitchShiftBuffer(buffer, semitones) {
  if (Math.abs(semitones) < 0.01) return buffer;

  const rate = Math.pow(2, semitones / 12);
  const sr = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const origLen = buffer.length;

  // Step 1: Time-stretch by rate -> longer, same pitch
  const stretchedLen = Math.max(1, Math.floor(origLen * rate));
  const stretchedCtx = new OfflineAudioContext(channels, stretchedLen, sr);
  const stretchedBuffer = stretchedCtx.createBuffer(channels, stretchedLen, sr);

  for (let ch = 0; ch < channels; ch++) {
    const input = buffer.getChannelData(ch);
    const stretched = olaTimeStretch(input, rate);
    const padded = new Float32Array(stretchedLen);
    padded.set(stretched.subarray(0, Math.min(stretched.length, stretchedLen)));
    stretchedBuffer.copyToChannel(padded, ch, 0);
  }

  // Step 2: Render stretched buffer at playbackRate=rate -> true pitch shift, original duration
  const outCtx = new OfflineAudioContext(channels, origLen, sr);
  const source = outCtx.createBufferSource();
  source.buffer = stretchedBuffer;
  source.playbackRate.value = rate;

  const gainNode = outCtx.createGain();
  gainNode.gain.value = 1.0;

  source.connect(gainNode);
  gainNode.connect(outCtx.destination);
  source.start(0);

  return await outCtx.startRendering();
}

// ── WAV encoding ───────────────────────────────────────
function encodeWAV(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitsPerSample = 16;

  const data = audioBuffer.getChannelData(0);
  const length = data.length;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = length * numChannels * bitsPerSample / 8;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write samples
  let offset = 44;
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, data[i]));
    const intVal = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    view.setInt16(offset, intVal, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ── Export ──────────────────────────────────────────────
async function exportWAV() {
  if (state.layers.length === 0) return;

  setStatus('Rendering...');
  exportBtn.disabled = true;

  try {
    const sr = state.layers[0].buffer.sampleRate;
    const totalDur = getTotalDuration();
    const totalSamples = Math.ceil(totalDur * sr);
    const channels = 1; // Mono output

    // Mix buffer
    const mixBuffer = new Float32Array(totalSamples);

    for (const layer of state.layers) {
      if (layer.muted) continue;

      setStatus(`Processing: ${layer.name}...`);

      const trimStartSample = Math.floor(layer.trimStart * sr);
      const trimEndSample = Math.floor(Math.min(layer.trimEnd, layer.buffer.duration) * sr);
      const trimmedLen = trimEndSample - trimStartSample;

      if (trimmedLen < 1) continue;

      // Create buffer with trimmed audio
      const trimCtx = new OfflineAudioContext(channels, trimmedLen, sr);
      const trimBuf = trimCtx.createBuffer(channels, trimmedLen, sr);
      for (let ch = 0; ch < Math.min(channels, layer.buffer.numberOfChannels); ch++) {
        const chanData = layer.buffer.getChannelData(ch).subarray(trimStartSample, trimEndSample);
        trimBuf.copyToChannel(chanData, ch, 0);
      }

      // Apply true pitch shift
      const shifted = await pitchShiftBuffer(trimBuf, layer.pitchSemitones);
      const shiftedData = shifted.getChannelData(0);
      const gain = layer.gain;

      // Place at offset
      const offsetSample = Math.floor(layer.offset * sr);
      const endSample = Math.min(offsetSample + shiftedData.length, totalSamples);
      for (let i = offsetSample; i < endSample; i++) {
        mixBuffer[i] += shiftedData[i - offsetSample] * gain;
      }
    }

    // Crossfade for seamless looping
    const cfDur = parseFloat(crossfadeDur.value) || 0;
    if (crossfadeToggle.checked && cfDur > 0) {
      const fadeSamples = Math.min(Math.floor(cfDur * sr), Math.floor(totalSamples / 3));
      if (fadeSamples > 0) {
        // Mix tail into head with crossfade
        const tailStart = totalSamples - fadeSamples;
        for (let i = 0; i < fadeSamples; i++) {
          const fadeIn = i / fadeSamples;
          const fadeOut = 1 - fadeIn;
          mixBuffer[i] = mixBuffer[i] * fadeOut + mixBuffer[tailStart + i] * fadeIn;
        }
        // Truncate to remove the tail that was merged
        // (we keep the full buffer but the tail portion after crossfade is silent)
        for (let i = tailStart; i < totalSamples; i++) {
          mixBuffer[i] *= 0;
        }
      }
    }

    // Normalize to prevent clipping
    const peak = mixBuffer.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
    if (peak > 1.0) {
      const scale = 0.95 / peak;
      for (let i = 0; i < totalSamples; i++) {
        mixBuffer[i] *= scale;
      }
    }

    setStatus('Encoding WAV...');

    // Create output AudioBuffer
    const outCtx = new OfflineAudioContext(1, totalSamples, sr);
    const outBuf = outCtx.createBuffer(1, totalSamples, sr);
    outBuf.copyToChannel(mixBuffer, 0, 0);

    // Encode to WAV
    const wavBlob = encodeWAV(outBuf);

    // Download
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ambiloop-export.wav';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus(`Export complete! (${formatTime(totalDur)})`);
  } catch (err) {
    setStatus(`Export failed: ${err.message}`);
    console.error(err);
  }

  exportBtn.disabled = false;
}

exportBtn.addEventListener('click', exportWAV);

// ── Keyboard shortcuts ─────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); if (state.playing) stopPreview(); else startPreview(); }
});

// ── Crossfade controls ─────────────────────────────────
if (crossfadeToggle && crossfadeDur) {
  crossfadeToggle.addEventListener('change', () => {
    crossfadeDur.disabled = !crossfadeToggle.checked;
  });
}

// ── Split tool toggle ──────────────────────────────────
if (splitBtn) {
  splitBtn.addEventListener('click', () => {
    state.splitMode = !state.splitMode;
    splitBtn.classList.toggle('active', state.splitMode);
    splitBtn.textContent = state.splitMode ? '\u2702 Split (ON)' : '\u2702 Split';
    timelineScroll.classList.toggle('split-mode', state.splitMode);
    setStatus(state.splitMode ? 'Split tool active — click a block to cut it' : 'Ready');
  });
}

// ── Zoom control ────────────────────────────────────────
if (zoomSlider) {
  zoomSlider.addEventListener('input', () => {
    state.zoom = parseInt(zoomSlider.value);
    renderTimeline();
    renderMasterTimeline();
  });
}

// ── Master timeline click-to-seek ───────────────────────
if (masterTimeline) {
  masterTimeline.addEventListener('click', (e) => {
    if (state.layers.length === 0) return;
    const rect = masterTimeline.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(frac);
  });
}

// ── Init ────────────────────────────────────────────────
updateButtons();
setStatus('Ready. Drop audio files to begin.');
