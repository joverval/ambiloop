// ambiloop v1.1 — ambient audio layer composer
// Pure client-side: Web Audio API + OLA pitch shifting + WAV export
// Added: per-layer trim, offset, timeline blocks with drag, crossfade looping

const LAYER_COLORS = ['#e94560','#0f3460','#533483','#2ecc71','#f39c12','#3498db','#e74c3c','#1abc9c'];
const TIMELINE_SCALE = 40; // pixels per second

const state = {
  layers: [],           // { id, name, buffer, gain, pitchSemitones, color, muted, trimStart, trimEnd, offset }
  audioCtx: null,       // AudioContext for preview
  playing: false,
  nextId: 1,
  loopCrossfade: 2.0,   // seconds, 0 = disabled
  dragging: null        // { id, startX, startOffset }
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
  const totalWidth = totalDur * TIMELINE_SCALE;

  // Ruler with time markers
  let rulerHTML = '';
  const tickInterval = totalDur > 60 ? 10 : (totalDur > 30 ? 5 : 1);
  for (let t = 0; t <= totalDur; t += tickInterval) {
    const x = t * TIMELINE_SCALE;
    rulerHTML += `<span class="ruler-tick" style="left:${x}px">${formatTime(t)}</span>`;
  }
  timelineRuler.innerHTML = rulerHTML;
  timelineRuler.style.width = totalWidth + 'px';

  // Tracks with blocks
  timelineTracks.innerHTML = state.layers.map(l => {
    const trimmedDur = getTrimmedDuration(l);
    const left = l.offset * TIMELINE_SCALE;
    const width = Math.max(trimmedDur * TIMELINE_SCALE, 4); // min 4px
    const leftPct = (l.offset / l.buffer.duration * 100).toFixed(0);
    const widthPct = (trimmedDur / l.buffer.duration * 100).toFixed(0);

    return `
    <div class="timeline-track">
      <div class="timeline-block" data-id="${l.id}"
           style="left:${left}px; width:${width}px; background:${l.color}"
           title="${l.name} (offset: ${l.offset.toFixed(1)}s, trim: ${l.trimStart.toFixed(1)}→${l.trimEnd.toFixed(1)}s)">
        <span class="block-label">${l.name}</span>
        <span class="block-range">${leftPct}%–${widthPct}%</span>
      </div>
    </div>
    `;
  }).join('');

  timelineTracks.style.width = totalWidth + 'px';
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
  if (e.target.dataset.action === 'remove') {
    const id = parseInt(e.target.dataset.id);
    state.layers = state.layers.filter(l => l.id !== id);
    renderAll();
    if (state.playing) stopPreview();
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
  const newOffset = state.dragging.startOffset + dx / TIMELINE_SCALE;
  layer.offset = Math.max(0, Math.round(newOffset * 10) / 10); // snap to 0.1s

  // Live update the block position
  const block = timelineTracks.querySelector(`.timeline-block[data-id="${layer.id}"]`);
  if (block) {
    block.style.left = (layer.offset * TIMELINE_SCALE) + 'px';
  }

  // Update ruler/tracks width if needed
  const totalDur = getTotalDuration();
  const totalWidth = totalDur * TIMELINE_SCALE;
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

// ── Init ────────────────────────────────────────────────
updateButtons();
setStatus('Ready. Drop audio files to begin.');
