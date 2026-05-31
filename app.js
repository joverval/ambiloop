// ambiloop v1.1 — ambient audio layer composer
// Pure client-side: Web Audio API + OLA pitch shifting + WAV export
// Added: per-layer trim, offset, timeline blocks with drag, crossfade looping

const LAYER_COLORS = ['#c0392b','#2980b9','#8e44ad','#27ae60','#e67e22','#2c3e50','#d35400','#16a085'];

const state = {
  layers: [],           // { id, name, buffer, gain, pitchSemitones, color, muted, solo, trimStart, trimEnd, offset, fadeIn, fadeOut }
  audioCtx: null,       // AudioContext for preview
  playing: false,
  nextId: 1,
  loopCrossfade: 2.0,   // seconds, 0 = disabled
  dragging: null,        // { id, startX, startOffset }
  splitMode: false,      // split tool active
  zoom: 40,             // pixels per second -- timeline scale
  previewStartTime: 0,  // AudioContext.currentTime when preview started (for playhead)
  animFrame: null,       // requestAnimationFrame ID for playhead
  selectedId: null,      // selected layer ID for keyboard shortcuts
  undoStack: [],         // [{layers, loopCrossfade}, ...]
  redoStack: []
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
const masterSpectrum = $('#masterSpectrum');
const infoBtn = $('#infoBtn');
const infoModal = $('#infoModal');
const infoClose = $('#infoClose');

// ── State helpers ──────────────────────────────────────
function setStatus(msg) { statusBar.textContent = msg; }
function updateButtons() {
  const hasLayers = state.layers.length > 0;
  playBtn.disabled = !hasLayers;
  stopBtn.disabled = !hasLayers;
  exportBtn.disabled = !hasLayers;
  if (exportMp3Btn) exportMp3Btn.disabled = !hasLayers;
}

function pushUndo() {
  const snapshot = {
    layers: state.layers.map(l => ({...l, buffer: l.buffer})),
    loopCrossfade: state.loopCrossfade
  };
  state.undoStack.push(snapshot);
  if (state.undoStack.length > 50) state.undoStack.shift();
  state.redoStack = [];
}

function undo() {
  if (state.undoStack.length === 0) return;
  const current = {
    layers: state.layers.map(l => ({...l, buffer: l.buffer})),
    loopCrossfade: state.loopCrossfade
  };
  state.redoStack.push(current);
  const prev = state.undoStack.pop();
  state.layers = prev.layers;
  state.loopCrossfade = prev.loopCrossfade;
  if (state.playing) stopPreview();
  state.selectedId = null;
  renderAll();
  setStatus('Undo');
}

function redo() {
  if (state.redoStack.length === 0) return;
  const current = {
    layers: state.layers.map(l => ({...l, buffer: l.buffer})),
    loopCrossfade: state.loopCrossfade
  };
  state.undoStack.push(current);
  const next = state.redoStack.pop();
  state.layers = next.layers;
  state.loopCrossfade = next.loopCrossfade;
  if (state.playing) stopPreview();
  state.selectedId = null;
  renderAll();
  setStatus('Redo');
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
        volumeActive: true,
        pitchSemitones: 0,
        color: LAYER_COLORS[(state.layers.length) % LAYER_COLORS.length],
        muted: false,
        solo: false,
        trimStart: 0,
        trimEnd: audioBuf.duration,
        offset: 0,
        fadeIn: 0,
        fadeOut: 0,
        eqEnabled: false,
        eqType: 'peaking',
        eqFreq: 1000,
        eqQ: 1.0,
        eqGain: 0,
        pan: 0,             // -1 (left) to 1 (right), 0 = center
        rawSpectrum: null,  // raw frequency spectrum (dB), before EQ
        binFreqs: null      // center frequencies (Hz) for each spectrum bin
      };

      state.layers.push(layer);
      setStatus(`Loaded: ${file.name}`);

      // Compute frequency spectrum asynchronously
      computeSpectrum(audioBuf, 0, audioBuf.duration).then(result => {
        layer.rawSpectrum = result.spectrum;
        layer.binFreqs = result.binFreqs;
        console.debug(`Spectrum ready for layer ${layer.id} (${layer.name}), bins:`, result.spectrum.length);
        renderAll();
      }).catch(err => {
        console.warn('Spectrum computation failed for', file.name, err);
        layer.rawSpectrum = null;
        layer.binFreqs = null;
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
      if (l.rawSpectrum) {
        const canvas = document.querySelector(`canvas[data-spectrum-id="${l.id}"]`);
        if (canvas) {
          drawSpectrum(canvas, l);
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
    const isSelected = l.id === state.selectedId;
    return `
    <div class="layer-card ${isSelected ? 'selected' : ''}" data-id="${l.id}">
      <div class="layer-header">
        <span class="layer-color" style="background:${l.color}"></span>
        <div class="layer-mute-solo">
          <button class="layer-mute-btn ${l.muted ? 'active' : ''}" data-action="mute" data-id="${l.id}" title="Mute">M</button>
          <button class="layer-solo-btn ${l.solo ? 'active' : ''}" data-action="solo" data-id="${l.id}" title="Solo">S</button>
        </div>
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
          <label class="vol-active-label" title="Enable/disable layer output">
            <input type="checkbox" data-action="volumeActive" data-id="${l.id}" ${l.volumeActive !== false ? 'checked' : ''}>
          </label>
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

        <!-- Fade controls -->
        <div class="layer-control">
          <span class="layer-label">Fade</span>
          <span class="layer-value" style="font-size:0.65rem">in</span>
          <input type="number" value="${l.fadeIn.toFixed(1)}" step="0.1" min="0" max="10"
                 data-action="fadeIn" data-id="${l.id}" class="num-input" style="width:44px">
          <span class="layer-value">s</span>
          <span class="layer-value" style="font-size:0.65rem">out</span>
          <input type="number" value="${l.fadeOut.toFixed(1)}" step="0.1" min="0" max="10"
                 data-action="fadeOut" data-id="${l.id}" class="num-input" style="width:44px">
          <span class="layer-value">s</span>
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
      ${l.rawSpectrum ? `<canvas class="spectrum-canvas" data-spectrum-id="${l.id}" width="260" height="52"></canvas>` : ''}
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
  // Yield to event loop so UI stays responsive
  await new Promise(r => setTimeout(r, 0));

  const sr = buffer.sampleRate;
  const startSample = Math.floor(trimStart * sr);
  const endSample = Math.floor(Math.min(trimEnd, buffer.duration) * sr);
  const rawData = buffer.getChannelData(0);
  const len = endSample - startSample;
  if (len < 64) return { spectrum: null, binFreqs: null };

  const numBins = 40;
  const nyquist = sr / 2;
  const spectrum = new Float32Array(numBins);
  const binFreqs = new Float32Array(numBins);

  // Compute one DFT bin at a time using Goertzel algorithm
  // (no trig inside the sample loop -- fast even for long files)
  // Yield every 4 bins so the UI stays responsive.
  for (let i = 0; i < numBins; i++) {
    const freq = 20 * Math.pow(nyquist / 20, i / (numBins - 1));
    binFreqs[i] = freq;

    const omega = 2 * Math.PI * freq / sr;
    const coeff = 2 * Math.cos(omega);
    let s0 = 0, s1 = 0, s2 = 0;

    for (let j = startSample; j < endSample; j++) {
      s0 = coeff * s1 - s2 + rawData[j];
      s2 = s1;
      s1 = s0;
    }

    const real = s1 - s2 * Math.cos(omega);
    const imag = s2 * Math.sin(omega);
    const magnitude = Math.sqrt(real * real + imag * imag) / len;
    spectrum[i] = magnitude > 1e-10 ? 20 * Math.log10(magnitude) : -100;

    if (i % 4 === 3) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return { spectrum, binFreqs };
}

function drawSpectrum(canvas, layer) {
  const rawSpectrum = layer.rawSpectrum;
  const binFreqs = layer.binFreqs;
  if (!rawSpectrum || !canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const bars = rawSpectrum.length;
  const barAreaH = h - 14;  // leave 14px for frequency labels
  const barWidth = (w / bars) - 1;
  if (barWidth < 1) return;

  // dB range: -100 (silent) to 0 (loud) → map to 0..barAreaH
  const minDB = -80;
  const maxDB = -10;

  // Apply EQ transfer function if EQ is enabled
  const eqEnabled = layer.eqEnabled;
  const eqType = layer.eqType;
  const eqFreq = layer.eqFreq;
  const eqQ = layer.eqQ;
  const eqGain = layer.eqGain;

  // Pitch shift: +N semitones multiplies all frequencies by 2^(N/12)
  // For each output bin, find the source frequency that maps to it
  const pitchRatio = Math.pow(2, layer.pitchSemitones / 12);

  for (let i = 0; i < bars; i++) {
    // Which raw frequency maps to this bin after pitch shift?
    const srcFreq = binFreqs[i] / pitchRatio;
    // Interpolate raw spectrum at that shifted frequency
    let db = interpolateSpectrum(rawSpectrum, binFreqs, srcFreq);
    db = Math.max(minDB, db);

    if (eqEnabled && binFreqs) {
      db += computeEQGain(binFreqs[i], eqType, eqFreq, eqQ, eqGain);
    }
    const fraction = Math.min(1, Math.max(0, (db - minDB) / (maxDB - minDB)));
    const barH = Math.max(1, fraction * barAreaH);
    const x = i * (barWidth + 1);
    const y = barAreaH - barH;

    ctx.fillStyle = layer.color;
    ctx.globalAlpha = 0.15 + fraction * 0.85;
    ctx.fillRect(x, y, barWidth, barH);
  }
  ctx.globalAlpha = 1;

  // Frequency labels at reference points
  if (!binFreqs) return;
  ctx.fillStyle = '#666';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  const labelY = h - 2;

  // Find bin indices closest to reference frequencies
  const refs = [20, 100, 1000, 5000, 20000];
  for (const ref of refs) {
    // Find the bin whose frequency is closest to the reference
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < binFreqs.length; i++) {
      const dist = Math.abs(binFreqs[i] - ref);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    const x = bestIdx * (barWidth + 1) + barWidth / 2;
    // Format: 20, 100, 1k, 5k, 20k
    const label = ref >= 1000 ? (ref / 1000) + 'k' : String(ref);
    // Avoid overlapping labels — skip if too close to previous
    ctx.fillText(label, x, labelY);
  }
}

// Linear interpolation of spectrum dB value at targetFreq
function interpolateSpectrum(spectrum, binFreqs, targetFreq) {
  if (!binFreqs || binFreqs.length < 2) return spectrum[0] || -100;
  if (targetFreq <= binFreqs[0]) return spectrum[0];
  if (targetFreq >= binFreqs[binFreqs.length - 1]) return spectrum[binFreqs.length - 1];
  for (let j = 0; j < binFreqs.length - 1; j++) {
    if (targetFreq >= binFreqs[j] && targetFreq <= binFreqs[j + 1]) {
      const t = (targetFreq - binFreqs[j]) / (binFreqs[j + 1] - binFreqs[j]);
      return spectrum[j] + t * (spectrum[j + 1] - spectrum[j]);
    }
  }
  return spectrum[spectrum.length - 1];
}

// ── EQ filter transfer function ────────────────────────
// Computes the magnitude response (dB) of a BiquadFilter at a given frequency.
// Uses RBJ Audio EQ Cookbook formulas matching Web Audio API's BiquadFilterNode.
function computeEQGain(freq, type, f0, Q, gainDB) {
  if (freq <= 0 || f0 <= 0) return 0;

  const fs = 44100; // standard sample rate for filter design
  const w0 = 2 * Math.PI * f0 / fs;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);

  let b0, b1, b2, a0, a1, a2;

  switch (type) {
    case 'lowpass': {
      const alpha = sinW0 / (2 * Q);
      b0 = (1 - cosW0) / 2;
      b1 = 1 - cosW0;
      b2 = (1 - cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    case 'highpass': {
      const alpha = sinW0 / (2 * Q);
      b0 = (1 + cosW0) / 2;
      b1 = -(1 + cosW0);
      b2 = (1 + cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    case 'bandpass': {
      const alpha = sinW0 / (2 * Q);
      b0 = Q * alpha;
      b1 = 0;
      b2 = -Q * alpha;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    case 'notch': {
      const alpha = sinW0 / (2 * Q);
      b0 = 1;
      b1 = -2 * cosW0;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    case 'peaking': {
      const A = Math.pow(10, gainDB / 40);
      const alpha = sinW0 / (2 * Q);
      b0 = 1 + alpha * A;
      b1 = -2 * cosW0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosW0;
      a2 = 1 - alpha / A;
      break;
    }
    case 'lowshelf': {
      const A = Math.pow(10, gainDB / 40);
      const alpha = sinW0 / 2 * Math.sqrt((A + 1 / A) * (1 - 1) + 2);
      const sqrtA = Math.sqrt(A);
      const twoSqrtAAlpha = 2 * sqrtA * alpha;
      b0 = A * ((A + 1) - (A - 1) * cosW0 + twoSqrtAAlpha);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosW0);
      b2 = A * ((A + 1) - (A - 1) * cosW0 - twoSqrtAAlpha);
      a0 = (A + 1) + (A - 1) * cosW0 + twoSqrtAAlpha;
      a1 = -2 * ((A - 1) + (A + 1) * cosW0);
      a2 = (A + 1) + (A - 1) * cosW0 - twoSqrtAAlpha;
      break;
    }
    case 'highshelf': {
      const A = Math.pow(10, gainDB / 40);
      const alpha = sinW0 / 2 * Math.sqrt((A + 1 / A) * (1 - 1) + 2);
      const sqrtA = Math.sqrt(A);
      const twoSqrtAAlpha = 2 * sqrtA * alpha;
      b0 = A * ((A + 1) + (A - 1) * cosW0 + twoSqrtAAlpha);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosW0);
      b2 = A * ((A + 1) + (A - 1) * cosW0 - twoSqrtAAlpha);
      a0 = (A + 1) - (A - 1) * cosW0 + twoSqrtAAlpha;
      a1 = 2 * ((A - 1) - (A + 1) * cosW0);
      a2 = (A + 1) - (A - 1) * cosW0 - twoSqrtAAlpha;
      break;
    }
    default:
      return 0;
  }

  // Evaluate |H(e^jw)| at w = 2*PI*freq/fs
  const w = 2 * Math.PI * freq / fs;
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);

  // H(z) = (b0 + b1*z^-1 + b2*z^-2) / (a0 + a1*z^-1 + a2*z^-2)  where z = e^jw
  const numReal = b0 + b1 * cosW + b2 * Math.cos(2 * w);
  const numImag = -(b1 * sinW + b2 * Math.sin(2 * w));
  const denReal = a0 + a1 * cosW + a2 * Math.cos(2 * w);
  const denImag = -(a1 * sinW + a2 * Math.sin(2 * w));

  const magNum = Math.sqrt(numReal * numReal + numImag * numImag);
  const magDen = Math.sqrt(denReal * denReal + denImag * denImag);

  if (magDen < 1e-12) return 0;
  return 20 * Math.log10(magNum / magDen);
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

  // Live-update running audio nodes during playback
  if (state.playing) {
    const node = previewNodes.find(n => n.layerId === id);
    if (node) {
      const action = e.target.dataset.action;
      const val = e.target.value;
      if (action === 'pitch') {
        node.source.playbackRate.value = Math.pow(2, parseFloat(val) / 12);
      } else if (action === 'gain') {
        node.gain.gain.value = layer.volumeActive !== false ? val / 100 : 0;
      } else if (action === 'pan') {
        node.panner.pan.value = parseInt(val) / 100;
      } else if (action === 'eqFreq' && node.eq) {
        node.eq.frequency.value = parseInt(val);
      } else if (action === 'eqQ' && node.eq) {
        node.eq.Q.value = parseFloat(val);
      } else if (action === 'eqGain' && node.eq) {
        node.eq.gain.value = parseFloat(val);
      }
    }
  }

  renderAll();
});

// Number inputs + selects: update on 'change' (blur/Enter — keeps focus during typing)
layerList.addEventListener('change', (e) => {
  const action = e.target.dataset.action;

  // Click on layer card itself (not a button) to select/deselect
  if (!action && e.target.closest('.layer-card')) {
    const card = e.target.closest('.layer-card');
    const id = parseInt(card.dataset.id);
    state.selectedId = (state.selectedId === id) ? null : id;
    renderAll();
    return;
  }

  if (!action) return;
  const tag = e.target.tagName;
  const type = e.target.type;

  // Only handle number inputs and selects here
  if (!((tag === 'INPUT' && type === 'number') || tag === 'SELECT')) return;

  const id = parseInt(e.target.dataset.id);
  const layer = state.layers.find(l => l.id === id);
  if (!layer) return;

  applyLayerValue(layer, action, e.target.value);
  pushUndo();
  renderAll();
});

layerList.addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  const id = parseInt(e.target.dataset.id);

  if (action === 'remove') {
    pushUndo();
    state.layers = state.layers.filter(l => l.id !== id);
    state.selectedId = (state.selectedId === id) ? null : state.selectedId;
    renderAll();
    if (state.playing) stopPreview();
  } else if (action === 'duplicate') {
    duplicateLayer(id);
  } else if (action === 'volumeActive') {
    const layer = state.layers.find(l => l.id === id);
    if (layer) {
      layer.volumeActive = e.target.checked;
      // If playing, live-update the gain node
      if (state.playing) {
        const node = previewNodes.find(n => n.layerId === id);
        if (node) {
          node.gain.gain.value = e.target.checked ? layer.gain : 0;
        }
      }
    }
  } else if (action === 'mute') {
    const layer = state.layers.find(l => l.id === id);
    if (layer) {
      pushUndo();
      layer.muted = !layer.muted;
      // If muted and was soloed, clear solo
      if (layer.muted) layer.solo = false;
      if (state.playing) stopPreview();
      renderAll();
    }
  } else if (action === 'solo') {
    const layer = state.layers.find(l => l.id === id);
    if (layer) {
      pushUndo();
      const hasAnySolo = state.layers.some(l => l.solo);
      if (hasAnySolo && !layer.solo) {
        // Adding a new solo: only this layer
        state.layers.forEach(l => l.solo = (l.id === id));
      } else {
        // Toggle this layer's solo
        layer.solo = !layer.solo;
        // If no layers left soloed, exit solo mode
        if (!state.layers.some(l => l.solo)) {
          // All clear
        }
      }
      if (state.playing) stopPreview();
      renderAll();
    }
  } else if (action === 'fadeIn') {
    const layer = state.layers.find(l => l.id === id);
    if (layer) {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val >= 0) {
        pushUndo();
        layer.fadeIn = Math.round(val * 10) / 10;
      }
    }
  } else if (action === 'fadeOut') {
    const layer = state.layers.find(l => l.id === id);
    if (layer) {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val >= 0) {
        pushUndo();
        layer.fadeOut = Math.round(val * 10) / 10;
      }
    }
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
    solo: false,
    trimStart: cutPoint,
    trimEnd: layer.trimEnd,
    offset: layer.offset + (cutPoint - layer.trimStart),
    fadeIn: 0,
    fadeOut: 0,
    eqEnabled: layer.eqEnabled,
    eqType: layer.eqType,
    eqFreq: layer.eqFreq,
    eqQ: layer.eqQ,
    eqGain: layer.eqGain,
    pan: layer.pan,
    rawSpectrum: null,  // recomputed for trimmed region
    binFreqs: null
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
  computeSpectrum(layer.buffer, layer.trimStart, layer.trimEnd).then(result => {
    layer.rawSpectrum = result.spectrum;
    layer.binFreqs = result.binFreqs;
    onSpecDone();
  }).catch(err => { console.warn('Spectrum failed for split left', err); onSpecDone(); });
  computeSpectrum(rightLayer.buffer, rightLayer.trimStart, rightLayer.trimEnd).then(result => {
    rightLayer.rawSpectrum = result.spectrum;
    rightLayer.binFreqs = result.binFreqs;
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
    solo: false,
    trimStart: layer.trimStart,
    trimEnd: layer.trimEnd,
    offset: layer.offset,
    fadeIn: layer.fadeIn,
    fadeOut: layer.fadeOut,
    eqEnabled: layer.eqEnabled,
    eqType: layer.eqType,
    eqFreq: layer.eqFreq,
    eqQ: layer.eqQ,
    eqGain: layer.eqGain,
    pan: layer.pan,
    rawSpectrum: layer.rawSpectrum,  // same buffer, same trim = same spectrum
    binFreqs: layer.binFreqs
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
  if (masterSpectrum) masterSpectrum.style.display = 'none';
  if (state.masterAnalyser) {
    try { state.masterAnalyser.disconnect(); } catch(e) {}
    state.masterAnalyser = null;
  }
  if (state.masterGain) {
    try { state.masterGain.disconnect(); } catch(e) {}
    state.masterGain = null;
  }
}

async function startPreview() {
  if (state.layers.length === 0) return;
  if (state.playing) { stopPreview(); return; }

  const ctx = getAudioCtx();
  stopPreview();

  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.7;
  state.masterGain = masterGain;

  // Master analyser for real-time spectrum
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.7;
  analyser.connect(ctx.destination);
  masterGain.connect(analyser);
  state.masterAnalyser = analyser;
  if (masterSpectrum) masterSpectrum.style.display = 'block';

  const now = ctx.currentTime;
  const hasAnySolo = state.layers.some(l => l.solo);

  for (const layer of state.layers) {
    if (layer.muted) continue;
    if (hasAnySolo && !layer.solo) continue;

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
    gainNode.gain.value = layer.volumeActive !== false ? layer.gain : 0;

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

    previewNodes.push({ source, gain: gainNode, eq: eqFilter, panner, layerId: layer.id });

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

  // Draw master output spectrum
  if (masterSpectrum && state.masterAnalyser && masterSpectrum.style.display !== 'none') {
    drawMasterSpectrum(masterSpectrum, state.masterAnalyser);
  }

  state.animFrame = requestAnimationFrame(animatePlayhead);
}

// ── Master output spectrum (real-time AnalyserNode) ─────
function drawMasterSpectrum(canvas, analyser) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const labelH = 14;  // bottom margin for labels
  const barH = h - labelH;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  analyser.getByteFrequencyData(dataArray);

  ctx.clearRect(0, 0, w, h);

  // Surface background
  ctx.fillStyle = '#b8b8bd';
  ctx.fillRect(0, 0, w, h);

  const barWidth = Math.max(1, w / bufferLength);
  for (let i = 0; i < bufferLength; i++) {
    const value = dataArray[i] / 255; // 0-1
    const barHeight = Math.max(1, value * barH);

    // Gradient from accent red to muted gray
    const t = i / bufferLength;
    const r = Math.round(192 + (130 - 192) * t);
    const g = Math.round(57 + (130 - 57) * t);
    const b = Math.round(43 + (130 - 43) * t);
    ctx.fillStyle = `rgb(${r},${g},${b})`;

    ctx.fillRect(Math.floor(i * barWidth), barH - barHeight, Math.ceil(barWidth), barHeight);
  }

  // Frequency labels
  const sampleRate = analyser.context.sampleRate;
  const nyquist = sampleRate / 2;
  const refs = [20, 100, 1000, 5000, 20000];

  ctx.fillStyle = 'rgba(90,90,90,0.6)';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';

  for (const ref of refs) {
    const px = (ref / nyquist) * w;
    if (px < 4 || px > w - 4) continue;  // skip if too close to edge
    const label = ref >= 1000 ? (ref / 1000) + 'k' : String(ref);
    ctx.fillText(label, px, h - 3);
  }
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
  state.masterGain = masterGain;

  // Master analyser for real-time spectrum
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.7;
  analyser.connect(ctx.destination);
  masterGain.connect(analyser);
  state.masterAnalyser = analyser;
  if (masterSpectrum) masterSpectrum.style.display = 'block';

  const now = ctx.currentTime;
  const hasAnySolo = state.layers.some(l => l.solo);

  for (const layer of state.layers) {
    if (layer.muted) continue;
    if (hasAnySolo && !layer.solo) continue;

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
    gainNode.gain.value = layer.volumeActive !== false ? layer.gain : 0;

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

    previewNodes.push({ source, gain: gainNode, eq: eqFilter, panner, layerId: layer.id });
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

// ── MP3 Export ────────────────────────────────────────
async function exportMP3() {
  if (state.layers.length === 0) return;
  if (typeof lamejs === 'undefined') {
    setStatus('MP3 export requires lame.min.js');
    return;
  }

  setStatus('Rendering MP3...');
  exportMp3Btn.disabled = true;

  try {
    const sr = state.layers[0].buffer.sampleRate;
    const totalDur = getTotalDuration();
    const totalSamples = Math.ceil(totalDur * sr);
    const hasAnySolo = state.layers.some(l => l.solo);

    const mixBufferL = new Float32Array(totalSamples);
    const mixBufferR = new Float32Array(totalSamples);

    for (const layer of state.layers) {
      if (layer.muted) continue;
      if (hasAnySolo && !layer.solo) continue;
      setStatus(`Processing: ${layer.name}...`);

      const trimStartSample = Math.floor(layer.trimStart * sr);
      const trimEndSample = Math.floor(Math.min(layer.trimEnd, layer.buffer.duration) * sr);
      const trimmedLen = trimEndSample - trimStartSample;
      if (trimmedLen < 1) continue;

      const trimCtx = new OfflineAudioContext(1, trimmedLen, sr);
      const trimBuf = trimCtx.createBuffer(1, trimmedLen, sr);
      trimBuf.copyToChannel(layer.buffer.getChannelData(0).subarray(trimStartSample, trimEndSample), 0, 0);

      const shifted = await pitchShiftBuffer(trimBuf, layer.pitchSemitones);
      let eqBuffer = shifted;
      if (layer.eqEnabled) {
        const eqCtx = new OfflineAudioContext(shifted.numberOfChannels, shifted.length, sr);
        const eqSource = eqCtx.createBufferSource();
        eqSource.buffer = shifted;
        const eqFilter = eqCtx.createBiquadFilter();
        eqFilter.type = layer.eqType;
        eqFilter.frequency.value = layer.eqFreq;
        eqFilter.Q.value = layer.eqQ;
        if (['peaking','lowshelf','highshelf'].includes(layer.eqType)) eqFilter.gain.value = layer.eqGain;
        eqSource.connect(eqFilter);
        eqFilter.connect(eqCtx.destination);
        eqSource.start(0);
        eqBuffer = await eqCtx.startRendering();
      }

      const shiftedData = eqBuffer.getChannelData(0);
      const pan = layer.pan || 0;
      const panAngle = (pan + 1) * Math.PI / 4;
      const gain = layer.gain;
      const leftGain = Math.cos(panAngle) * gain;
      const rightGain = Math.sin(panAngle) * gain;

      const offsetSample = Math.floor(layer.offset * sr);
      const endSample = Math.min(offsetSample + shiftedData.length, totalSamples);
      const fadeInSamples = Math.floor(layer.fadeIn * sr);
      const fadeOutSamples = Math.floor(layer.fadeOut * sr);
      for (let i = offsetSample; i < endSample; i++) {
        let sample = shiftedData[i - offsetSample];
        const localI = i - offsetSample;
        if (localI < fadeInSamples && fadeInSamples > 0) sample *= localI / fadeInSamples;
        const fromEnd = (endSample - i - 1);
        if (fromEnd < fadeOutSamples && fadeOutSamples > 0) sample *= fromEnd / fadeOutSamples;
        mixBufferL[i] += sample * leftGain;
        mixBufferR[i] += sample * rightGain;
      }
    }

    setStatus('Encoding MP3...');
    const mp3encoder = new lamejs.Mp3Encoder(2, sr, 192);
    const blockSize = 1152;
    const mp3Data = [];

    const peak = Math.max(
      mixBufferL.reduce((m, v) => Math.max(m, Math.abs(v)), 0),
      mixBufferR.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    );
    const norm = peak > 1.0 ? 0.95 / peak : 1.0;

    for (let i = 0; i < totalSamples; i += blockSize) {
      const left = new Int16Array(blockSize);
      const right = new Int16Array(blockSize);
      for (let j = 0; j < blockSize && (i + j) < totalSamples; j++) {
        left[j] = Math.max(-32768, Math.min(32767, mixBufferL[i + j] * norm * 32767));
        right[j] = Math.max(-32768, Math.min(32767, mixBufferR[i + j] * norm * 32767));
      }
      const frame = mp3encoder.encodeBuffer(left, right);
      if (frame.length > 0) mp3Data.push(frame);
    }
    const final = mp3encoder.flush();
    if (final.length > 0) mp3Data.push(final);

    const blob = new Blob(mp3Data, { type: 'audio/mp3' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ambiloop.mp3';
    a.click();
    URL.revokeObjectURL(url);
    setStatus('MP3 exported (192kbps stereo)');
  } catch (err) {
    console.error(err);
    setStatus('MP3 export failed: ' + err.message);
  } finally {
    exportMp3Btn.disabled = false;
  }
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
    const hasAnySolo = state.layers.some(l => l.solo);

    for (const layer of state.layers) {
      if (layer.muted) continue;
      if (hasAnySolo && !layer.solo) continue;

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
      const fadeInSamples = Math.floor(layer.fadeIn * sr);
      const fadeOutSamples = Math.floor(layer.fadeOut * sr);
      for (let i = offsetSample; i < endSample; i++) {
        let sample = shiftedData[i - offsetSample];
        // Fade-in envelope
        const localI = i - offsetSample;
        if (localI < fadeInSamples && fadeInSamples > 0) {
          sample *= localI / fadeInSamples;
        }
        // Fade-out envelope
        const fromEnd = (endSample - i - 1);
        if (fromEnd < fadeOutSamples && fadeOutSamples > 0) {
          sample *= fromEnd / fadeOutSamples;
        }
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
  // Don't capture shortcuts when user is typing in an input
  const tag = e.target.tagName;
  const isInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target.isContentEditable;
  if (isInput) return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (state.layers.length > 0) { state.playing ? stopPreview() : startPreview(); }
  }

  if (e.code === 'Delete' || e.code === 'Backspace') {
    if (state.selectedId !== null) {
      e.preventDefault();
      const layer = state.layers.find(l => l.id === state.selectedId);
      if (layer) {
        pushUndo();
        state.layers = state.layers.filter(l => l.id !== state.selectedId);
        state.selectedId = null;
        if (state.playing) stopPreview();
        renderAll();
      }
    }
  }

  if (e.code === 'KeyM' && state.selectedId !== null) {
    e.preventDefault();
    const layer = state.layers.find(l => l.id === state.selectedId);
    if (layer) {
      pushUndo();
      layer.muted = !layer.muted;
      if (layer.muted) layer.solo = false;
      if (state.playing) stopPreview();
      renderAll();
    }
  }

  if (e.code === 'KeyS' && state.selectedId !== null) {
    e.preventDefault();
    const layer = state.layers.find(l => l.id === state.selectedId);
    if (layer) {
      pushUndo();
      const hasAnySolo = state.layers.some(l => l.solo);
      if (hasAnySolo && !layer.solo) {
        state.layers.forEach(l => l.solo = (l.id === state.selectedId));
      } else {
        layer.solo = !layer.solo;
      }
      if (state.playing) stopPreview();
      renderAll();
    }
  }

  if (e.code === 'Escape') {
    state.selectedId = null;
    renderAll();
  }

  if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  }
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

// ── Info modal ────────────────────────────────────────
if (infoBtn && infoModal && infoClose) {
  infoBtn.addEventListener('click', () => infoModal.style.display = 'flex');
  infoClose.addEventListener('click', () => infoModal.style.display = 'none');
  infoModal.addEventListener('click', (e) => {
    if (e.target === infoModal) infoModal.style.display = 'none';
  });
}

// ── MP3 export ────────────────────────────────────────
if (exportMp3Btn) {
  exportMp3Btn.addEventListener('click', exportMP3);
}

// ── Init ────────────────────────────────────────────────
updateButtons();
setStatus('Ready. Drop audio files to begin.');
