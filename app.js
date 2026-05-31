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
const fileBtn = $('#fileBtn');
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
        offset: 0,
        eqEnabled: false,
        eqType: 'peaking',
        eqFreq: 1000,
        eqQ: 1.0,
        eqGain: 0,
        pan: 0,             // -1 (left) to 1 (right), 0 = center
        spectrum: null       // frequency spectrum data (computed async)
      };

      state.layers.push(layer);
      setStatus(`Loaded: ${file.name}`);

      // Compute frequency spectrum asynchronously
      computeSpectrum(audioBuf, 0, audioBuf.duration).then(spec => {
        layer.spectrum = spec;
        console.debug(`Spectrum ready for layer ${layer.id} (${layer.name}), bins:`, spec?.length);
        renderAll();
      }).catch(err => {
        console.warn('Spectrum computation failed for', file.name, err);
        layer.spectrum = null;
      });
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
  // Draw spectrums after DOM settles
  requestAnimationFrame(() => {
    state.layers.forEach(l => {
      if (l.spectrum) {
        const canvas = document.querySelector(`canvas[data-spectrum-id="${l.id}"]`);
        if (canvas) {
          drawSpectrum(canvas, l.spectrum, l.color);
        } else {
          console.debug(`Spectrum canvas not found for layer ${l.id}`);
        }
      }
    });
  });
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
          <input type="number" value="${Math.round(l.gain * 100)}" min="0" max="100"
                 data-action="gain" data-id="${l.id}" class="layer-value num-input">
        </div>

        <div class="layer-control">
          <span class="layer-label">Pitch</span>
          <input type="range" min="-24" max="24" value="${l.pitchSemitones}" step="0.5"
                 data-action="pitch" data-id="${l.id}" class="slider">
          <input type="number" value="${l.pitchSemitones.toFixed(1)}" min="-24" max="24" step="0.5"
                 data-action="pitch" data-id="${l.id}" class="layer-value num-input">
        </div>

        <div class="layer-control">
          <span class="layer-label">Pan</span>
          <input type="range" min="-100" max="100" value="${Math.round(l.pan * 100)}"
                 data-action="pan" data-id="${l.id}" class="slider">
          <input type="number" value="${Math.round(l.pan * 100)}" min="-100" max="100"
                 data-action="pan" data-id="${l.id}" class="layer-value num-input">
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

        <!-- EQ Toggle: enable checkbox + expand arrow -->
        <div class="eq-toggle-row">
          <label class="eq-enable-label">
            <input type="checkbox" data-action="eqEnabled" data-id="${l.id}" ${l.eqEnabled ? 'checked' : ''}>
            <span>EQ</span>
          </label>
          ${l.eqEnabled ? `<button class="eq-expand active" data-action="eqExpand" data-id="${l.id}" title="Show/hide EQ controls">${(l.eqExpanded !== false) ? '▼' : '▶'}</button>` : ''}
        </div>
        <div class="eq-section ${l.eqEnabled && (l.eqExpanded !== false) ? '' : 'hidden'}">
          <div class="layer-control">
            <span class="layer-label">Type</span>
            <select data-action="eqType" data-id="${l.id}" class="eq-select">
              ${['lowpass','highpass','bandpass','notch','peaking','lowshelf','highshelf'].map(t =>
                `<option value="${t}" ${l.eqType === t ? 'selected' : ''}>${t}</option>`
              ).join('')}
            </select>
          </div>
          <div class="layer-control">
            <span class="layer-label">Freq</span>
            <input type="range" min="20" max="20000" value="${l.eqFreq}" step="1"
                   data-action="eqFreq" data-id="${l.id}" class="slider">
            <input type="number" value="${l.eqFreq}" min="20" max="20000" step="1"
                   data-action="eqFreq" data-id="${l.id}" class="layer-value num-input">
          </div>
          <div class="layer-control">
            <span class="layer-label">Q</span>
            <input type="range" min="0.1" max="10" value="${l.eqQ}" step="0.1"
                   data-action="eqQ" data-id="${l.id}" class="slider">
            <input type="number" value="${l.eqQ.toFixed(1)}" min="0.1" max="10" step="0.1"
                   data-action="eqQ" data-id="${l.id}" class="layer-value num-input">
          </div>
          <div class="layer-control eq-gain-row ${l.eqType === 'lowpass' || l.eqType === 'highpass' || l.eqType === 'bandpass' || l.eqType === 'notch' ? 'hidden' : ''}">
            <span class="layer-label">Gain</span>
            <input type="range" min="-20" max="20" value="${l.eqGain}" step="0.5"
                   data-action="eqGain" data-id="${l.id}" class="slider">
            <input type="number" value="${l.eqGain.toFixed(1)}" min="-20" max="20" step="0.5"
                   data-action="eqGain" data-id="${l.id}" class="layer-value num-input">
          </div>
        </div>
      </div>
      ${l.spectrum ? `<canvas class="spectrum-canvas" data-spectrum-id="${l.id}" width="260" height="32"></canvas>` : ''}
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

// ── Frequency spectrum visualization ──────────────────
async function computeSpectrum(buffer, trimStart, trimEnd) {
  // Yield to event loop so UI stays responsive during DFT
  await new Promise(r => setTimeout(r, 0));

  const sr = buffer.sampleRate;
  const startSample = Math.floor(trimStart * sr);
  const endSample = Math.floor(Math.min(trimEnd, buffer.duration) * sr);
  const rawData = buffer.getChannelData(0);
  const len = endSample - startSample;
  if (len < 64) return null;

  // Downsample to ~2048 samples for fast DFT computation
  const targetLen = 2048;
  const step = Math.max(1, Math.floor(len / targetLen));
  const dlen = Math.floor((len - 1) / step) + 1;
  const downsampled = new Float32Array(dlen);
  for (let i = 0, j = startSample; i < dlen; i++, j += step) {
    downsampled[i] = rawData[Math.min(j, endSample - 1)];
  }

  // Direct DFT at 40 log-spaced frequency bins
  const numBins = 40;
  const nyquist = sr / 2;
  const effSr = sr / step;
  const effNyquist = effSr / 2;
  const spectrum = new Float32Array(numBins);

  for (let i = 0; i < numBins; i++) {
    const freq = Math.min(20 * Math.pow(nyquist / 20, i / (numBins - 1)), effNyquist * 0.95);
    let real = 0, imag = 0;
    for (let j = 0; j < dlen; j++) {
      const phase = 2 * Math.PI * freq * j / effSr;
      real += downsampled[j] * Math.cos(phase);
      imag -= downsampled[j] * Math.sin(phase);
    }
    const magnitude = Math.sqrt(real * real + imag * imag) / dlen;
    spectrum[i] = magnitude > 1e-10 ? 20 * Math.log10(magnitude) : -100;
  }

  return spectrum;
}

function drawSpectrum(canvas, spectrumData, color) {
  if (!spectrumData || !canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const bars = spectrumData.length;
  const barWidth = (w / bars) - 1;
  if (barWidth < 1) return;

  // dB range: -100 (silent) to 0 (loud) → map to 0..h
  const minDB = -80;
  const maxDB = -10;

  for (let i = 0; i < bars; i++) {
    const db = Math.max(minDB, spectrumData[i]);
    const fraction = (db - minDB) / (maxDB - minDB);
    const barH = Math.max(1, fraction * h);
    const x = i * (barWidth + 1);
    const y = h - barH;

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.15 + fraction * 0.85;
    ctx.fillRect(x, y, barWidth, barH);
  }
  ctx.globalAlpha = 1;
}

// ── Event delegation for layer controls ────────────────
// Apply a value to a layer property based on action
function applyLayerValue(layer, action, value) {
  if (action === 'gain') {
    layer.gain = value / 100;
  } else if (action === 'pitch') {
    layer.pitchSemitones = parseFloat(value);
  } else if (action === 'pan') {
    layer.pan = parseInt(value) / 100;
  } else if (action === 'offset') {
    layer.offset = parseFloat(value) || 0;
  } else if (action === 'trimStart') {
    const val = parseFloat(value) || 0;
    layer.trimStart = Math.max(0, Math.min(val, layer.buffer.duration));
  } else if (action === 'trimEnd') {
    const val = parseFloat(value) || layer.buffer.duration;
    layer.trimEnd = Math.max(0, Math.min(val, layer.buffer.duration));
  } else if (action === 'eqFreq') {
    layer.eqFreq = parseInt(value);
  } else if (action === 'eqQ') {
    layer.eqQ = parseFloat(value);
  } else if (action === 'eqGain') {
    layer.eqGain = parseFloat(value);
  } else if (action === 'eqType') {
    layer.eqType = value;
  }
}

// Sliders: live update on 'input' (continuous drag)
layerList.addEventListener('input', (e) => {
  if (e.target.type !== 'range') return;
  const id = parseInt(e.target.dataset.id);
  const layer = state.layers.find(l => l.id === id);
  if (!layer) return;
  applyLayerValue(layer, e.target.dataset.action, e.target.value);
  renderAll();
});

// Number inputs + selects: update on 'change' (blur/Enter — keeps focus during typing)
layerList.addEventListener('change', (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  const tag = e.target.tagName;
  const type = e.target.type;

  // Only handle number inputs and selects here
  if (!((tag === 'INPUT' && type === 'number') || tag === 'SELECT')) return;

  const id = parseInt(e.target.dataset.id);
  const layer = state.layers.find(l => l.id === id);
  if (!layer) return;

  applyLayerValue(layer, action, e.target.value);
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
  } else if (action === 'eqEnabled') {
    const layer = state.layers.find(l => l.id === id);
    if (layer) {
      layer.eqEnabled = e.target.checked;
      renderAll();
    }
  } else if (action === 'eqExpand') {
    // Just re-render to toggle expand/collapse — handled via a CSS class toggle
    const layer = state.layers.find(l => l.id === id);
    if (layer) {
      // Toggle visibility by storing in a data attribute on the DOM? 
      // Better: track expanded state in layer, default to expanded when enabled
      if (!layer.hasOwnProperty('eqExpanded')) layer.eqExpanded = true;
      layer.eqExpanded = !layer.eqExpanded;
      renderAll();
    }
  }
});

// ── File load: button + drag/drop on body ──────────────
fileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) loadFiles(fileInput.files);
  fileInput.value = '';
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer.types.includes('Files')) document.body.classList.add('drag-over');
});
document.addEventListener('dragleave', (e) => {
  if (!document.body.contains(e.relatedTarget)) document.body.classList.remove('drag-over');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('drag-over');
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
    offset: layer.offset + (cutPoint - layer.trimStart),
    eqEnabled: layer.eqEnabled,
    eqType: layer.eqType,
    eqFreq: layer.eqFreq,
    eqQ: layer.eqQ,
    eqGain: layer.eqGain,
    pan: layer.pan,
    spectrum: null  // recomputed on render for trimmed region
  };

  // Current layer gets trimmed at the cut point
  layer.trimEnd = cutPoint;

  // Insert right after the current layer
  const idx = state.layers.indexOf(layer);
  state.layers.splice(idx + 1, 0, rightLayer);

  setStatus(`Split at ${cutPoint.toFixed(1)}s → new layer "${rightLayer.name}"`);
  // Recompute spectrums for both trimmed halves — re-render when both done
  let done = 0;
  function onSpecDone() { if (++done === 2) renderAll(); }
  computeSpectrum(layer.buffer, layer.trimStart, layer.trimEnd).then(spec => {
    layer.spectrum = spec;
    onSpecDone();
  }).catch(err => { console.warn('Spectrum failed for split left', err); onSpecDone(); });
  computeSpectrum(rightLayer.buffer, rightLayer.trimStart, rightLayer.trimEnd).then(spec => {
    rightLayer.spectrum = spec;
    onSpecDone();
  }).catch(err => { console.warn('Spectrum failed for split right', err); onSpecDone(); });
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
    offset: layer.offset,
    eqEnabled: layer.eqEnabled,
    eqType: layer.eqType,
    eqFreq: layer.eqFreq,
    eqQ: layer.eqQ,
    eqGain: layer.eqGain,
    pan: layer.pan,
    spectrum: layer.spectrum  // same buffer, same trim = same spectrum
  };

  const idx = state.layers.indexOf(layer);
  state.layers.splice(idx + 1, 0, clone);

  setStatus(`Duplicated "${layer.name}"`);
  renderAll();
}

// ── Preview playback ───────────────────────────────────
let previewNodes = [];

function createEQFilter(ctx, layer) {
  if (!layer.eqEnabled) return null;
  const filter = ctx.createBiquadFilter();
  filter.type = layer.eqType;
  filter.frequency.value = layer.eqFreq;
  filter.Q.value = layer.eqQ;
  // Gain only applies to peaking, lowshelf, highshelf
  if (['peaking','lowshelf','highshelf'].includes(layer.eqType)) {
    filter.gain.value = layer.eqGain;
  }
  return filter;
}

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

    // EQ filter chain
    const eqFilter = createEQFilter(ctx, layer);
    let prevNode = source;
    if (eqFilter) {
      prevNode.connect(eqFilter);
      prevNode = eqFilter;
    }
    prevNode.connect(gainNode);

    // Stereo pan
    const panner = ctx.createStereoPanner();
    panner.pan.value = layer.pan || 0;
    gainNode.connect(panner);
    panner.connect(masterGain);

    source.start(now + layer.offset, 0);

    previewNodes.push({ source, gain: gainNode, eq: eqFilter, panner });
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

    // EQ filter chain
    const eqFilter = createEQFilter(ctx, layer);
    let prevNode = source;
    if (eqFilter) {
      prevNode.connect(eqFilter);
      prevNode = eqFilter;
    }
    prevNode.connect(gainNode);

    // Stereo pan
    const panner = ctx.createStereoPanner();
    panner.pan.value = layer.pan || 0;
    gainNode.connect(panner);
    panner.connect(masterGain);

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

    previewNodes.push({ source, gain: gainNode, eq: eqFilter, panner });
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

  // Write interleaved samples (handles mono and stereo)
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const chanData = numChannels > 1 ? audioBuffer.getChannelData(ch) : data;
      const sample = Math.max(-1, Math.min(1, chanData[i]));
      const intVal = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, intVal, true);
      offset += 2;
    }
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
    const channels = 2; // Stereo output

    // Stereo mix buffers
    const mixBufferL = new Float32Array(totalSamples);
    const mixBufferR = new Float32Array(totalSamples);

    for (const layer of state.layers) {
      if (layer.muted) continue;

      setStatus(`Processing: ${layer.name}...`);

      const trimStartSample = Math.floor(layer.trimStart * sr);
      const trimEndSample = Math.floor(Math.min(layer.trimEnd, layer.buffer.duration) * sr);
      const trimmedLen = trimEndSample - trimStartSample;

      if (trimmedLen < 1) continue;

      // Create buffer with trimmed audio (mono source for processing)
      const trimCtx = new OfflineAudioContext(1, trimmedLen, sr);
      const trimBuf = trimCtx.createBuffer(1, trimmedLen, sr);
      const chanData = layer.buffer.getChannelData(0).subarray(trimStartSample, trimEndSample);
      trimBuf.copyToChannel(chanData, 0, 0);

      // Apply true pitch shift
      const shifted = await pitchShiftBuffer(trimBuf, layer.pitchSemitones);

      // Apply EQ if enabled
      let eqBuffer = shifted;
      if (layer.eqEnabled) {
        const eqCtx = new OfflineAudioContext(shifted.numberOfChannels, shifted.length, sr);
        const eqSource = eqCtx.createBufferSource();
        eqSource.buffer = shifted;

        const eqFilter = eqCtx.createBiquadFilter();
        eqFilter.type = layer.eqType;
        eqFilter.frequency.value = layer.eqFreq;
        eqFilter.Q.value = layer.eqQ;
        if (['peaking','lowshelf','highshelf'].includes(layer.eqType)) {
          eqFilter.gain.value = layer.eqGain;
        }

        eqSource.connect(eqFilter);
        eqFilter.connect(eqCtx.destination);
        eqSource.start(0);
        eqBuffer = await eqCtx.startRendering();
      }

      const shiftedData = eqBuffer.getChannelData(0);

      // Equal-power panning
      const pan = layer.pan || 0;
      const panAngle = (pan + 1) * Math.PI / 4;  // maps -1..1 to 0..PI/2
      const gain = layer.gain;
      const leftGain = Math.cos(panAngle) * gain;
      const rightGain = Math.sin(panAngle) * gain;

      // Place at offset — mix into stereo buffers
      const offsetSample = Math.floor(layer.offset * sr);
      const endSample = Math.min(offsetSample + shiftedData.length, totalSamples);
      for (let i = offsetSample; i < endSample; i++) {
        const sample = shiftedData[i - offsetSample];
        mixBufferL[i] += sample * leftGain;
        mixBufferR[i] += sample * rightGain;
      }
    }

    // Crossfade for seamless looping
    const cfDur = parseFloat(crossfadeDur.value) || 0;
    if (crossfadeToggle.checked && cfDur > 0) {
      const fadeSamples = Math.min(Math.floor(cfDur * sr), Math.floor(totalSamples / 3));
      if (fadeSamples > 0) {
        const tailStart = totalSamples - fadeSamples;
        for (let i = 0; i < fadeSamples; i++) {
          const fadeIn = i / fadeSamples;
          const fadeOut = 1 - fadeIn;
          mixBufferL[i] = mixBufferL[i] * fadeOut + mixBufferL[tailStart + i] * fadeIn;
          mixBufferR[i] = mixBufferR[i] * fadeOut + mixBufferR[tailStart + i] * fadeIn;
        }
        for (let i = tailStart; i < totalSamples; i++) {
          mixBufferL[i] = 0;
          mixBufferR[i] = 0;
        }
      }
    }

    // Normalize to prevent clipping (both channels)
    const peakL = mixBufferL.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
    const peakR = mixBufferR.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
    const peak = Math.max(peakL, peakR);
    if (peak > 1.0) {
      const scale = 0.95 / peak;
      for (let i = 0; i < totalSamples; i++) {
        mixBufferL[i] *= scale;
        mixBufferR[i] *= scale;
      }
    }

    setStatus('Encoding WAV...');

    // Create stereo output AudioBuffer
    const outCtx = new OfflineAudioContext(2, totalSamples, sr);
    const outBuf = outCtx.createBuffer(2, totalSamples, sr);
    outBuf.copyToChannel(mixBufferL, 0, 0);
    outBuf.copyToChannel(mixBufferR, 1, 0);

    // Encode to WAV (stereo)
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
