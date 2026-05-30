// ambiloop v1 — ambient audio layer composer
// Pure client-side: Web Audio API + OLA pitch shifting + WAV export

const LAYER_COLORS = ['#e94560','#0f3460','#533483','#2ecc71','#f39c12','#3498db','#e74c3c','#1abc9c'];

const state = {
  layers: [],           // { id, name, buffer, gain, pitchSemitones, color, muted }
  audioCtx: null,       // AudioContext for preview
  playing: false,
  nextId: 1
};

// ── DOM refs ──────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const dropZone = $('#dropZone');
const fileInput = $('#fileInput');
const layerList = $('#layerList');
const layerCount = $('#layerCount');
const timelineContent = $('#timelineContent');
const playBtn = $('#playBtn');
const stopBtn = $('#stopBtn');
const exportBtn = $('#exportBtn');
const statusBar = $('#statusBar');

// ── State helpers ──────────────────────────────────────
function setStatus(msg) { statusBar.textContent = msg; }
function updateButtons() {
  const hasLayers = state.layers.length > 0;
  playBtn.disabled = !hasLayers;
  stopBtn.disabled = !hasLayers;
  exportBtn.disabled = !hasLayers;
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
        muted: false
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
  
  layerList.innerHTML = state.layers.map(l => `
    <div class="layer-card" data-id="${l.id}">
      <div class="layer-header">
        <span class="layer-color" style="background:${l.color}"></span>
        <span class="layer-name" title="${l.name}">${l.name}</span>
        <button class="layer-remove" data-action="remove" data-id="${l.id}">&times;</button>
      </div>
      
      <div class="layer-control">
        <div class="layer-label">
          <span>Volume</span>
          <span class="value">${Math.round(l.gain * 100)}%</span>
        </div>
        <input type="range" min="0" max="100" value="${Math.round(l.gain * 100)}"
               data-action="gain" data-id="${l.id}">
      </div>
      
      <div class="layer-control">
        <div class="layer-label">
          <span>Pitch</span>
          <span class="value">${l.pitchSemitones > 0 ? '+' : ''}${l.pitchSemitones.toFixed(1)} st</span>
        </div>
        <input type="range" min="-24" max="24" value="${l.pitchSemitones}" step="0.5"
               data-action="pitch" data-id="${l.id}">
      </div>
    </div>
  `).join('');
}

function renderTimeline() {
  if (state.layers.length === 0) {
    timelineContent.innerHTML = '<div class="empty-state">Add layers to see the timeline</div>';
    return;
  }
  
  const maxDur = Math.max(...state.layers.map(l => l.buffer.duration));
  
  timelineContent.innerHTML = state.layers.map(l => {
    const dur = l.buffer.duration;
    const widthPct = (dur / maxDur * 100).toFixed(1);
    return `
      <div class="timeline-row">
        <span class="row-color" style="background:${l.color}"></span>
        <span class="row-name">${l.name}</span>
        <span class="row-info">${formatTime(dur)}</span>
      </div>
    `;
  }).join('');
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
  
  if (e.target.dataset.action === 'gain') {
    layer.gain = e.target.value / 100;
  } else if (e.target.dataset.action === 'pitch') {
    layer.pitchSemitones = parseFloat(e.target.value);
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

// ── Preview playback (playbackRate = pitch+speed change) ──
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
  stopPreview(); // clean up any stale nodes
  
  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.7;
  masterGain.connect(ctx.destination);
  
  for (const layer of state.layers) {
    if (layer.muted) continue;
    
    const source = ctx.createBufferSource();
    source.buffer = layer.buffer;
    source.loop = true;
    
    const rate = Math.pow(2, layer.pitchSemitones / 12);
    source.playbackRate.value = rate;
    
    const gainNode = ctx.createGain();
    gainNode.gain.value = layer.gain;
    
    source.connect(gainNode);
    gainNode.connect(masterGain);
    source.start(0);
    
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
    // Too short for OLA, just copy/resample
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
  
  // Step 1: Time-stretch by rate → longer, same pitch
  const stretchedLen = Math.max(1, Math.floor(origLen * rate));
  
  // Create stretched buffer with time-stretched data per channel
  const stretchedBuffer = new OfflineAudioContext(channels, stretchedLen, sr).createBuffer(channels, stretchedLen, sr);
  
  for (let ch = 0; ch < channels; ch++) {
    const input = buffer.getChannelData(ch);
    const stretched = olaTimeStretch(input, rate);
    // copyToChannel expects the array to be at least stretchedLen long
    const padded = new Float32Array(stretchedLen);
    padded.set(stretched.subarray(0, Math.min(stretched.length, stretchedLen)));
    stretchedBuffer.copyToChannel(padded, ch, 0);
  }
  
  // Step 2: Render stretched buffer at playbackRate=rate → true pitch shift, original duration
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
    const maxDur = Math.max(...state.layers.map(l => l.buffer.duration));
    const totalSamples = Math.ceil(maxDur * sr);
    const channels = 1; // Mono output
    
    // Mix buffer: accumulate all layers
    const mixBuffer = new Float32Array(totalSamples);
    
    for (const layer of state.layers) {
      if (layer.muted) continue;
      
      setStatus(`Processing: ${layer.name}...`);
      
      // Apply true pitch shift
      const shifted = await pitchShiftBuffer(layer.buffer, layer.pitchSemitones);
      const layerData = shifted.getChannelData(0);
      const gain = layer.gain;
      
      // Mix into output (mono)
      for (let i = 0; i < Math.min(layerData.length, totalSamples); i++) {
        mixBuffer[i] += layerData[i] * gain;
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
    
    setStatus('Export complete!');
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

// ── Init ────────────────────────────────────────────────
updateButtons();
setStatus('Ready. Drop audio files to begin.');