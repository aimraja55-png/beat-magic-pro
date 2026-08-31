/**
 * 32-BAND FULL-TRACK DEEP SPECTRUM SCAN
 *
 * A tiny radix-2 FFT + log-spaced 32-band pooling. Runs on the decoded mono
 * signal at a coarse hop (0.25s) so even a 10-minute track scans in well under
 * a second on a phone. Produces:
 *   - bands[frame][32]  normalised band energy
 *   - flux[frame]       positive spectral flux across all 32 bands (drop detector)
 *   - subBass/air       pooled low + high band energy per frame
 */
export type SpectrumScan = {
  frameSec: number;
  frames: number;
  bands: Float32Array[];
  flux: Float32Array;
  subBass: Float32Array;
  air: Float32Array;
  centroid: Float32Array;
};

const FFT_SIZE = 1024;

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** log-spaced 32-band edges over 20Hz .. nyquist */
function bandEdges(sr: number): number[] {
  const lo = 20, hi = Math.min(sr / 2, 18000);
  const edges: number[] = [];
  for (let i = 0; i <= 32; i++) edges.push(lo * Math.pow(hi / lo, i / 32));
  return edges;
}

export function scanSpectrum(buffer: AudioBuffer, frameSec = 0.25): SpectrumScan {
  const sr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const hop = Math.max(1, Math.round(frameSec * sr));
  const frames = Math.max(1, Math.floor((ch0.length - FFT_SIZE) / hop) + 1);

  const edges = bandEdges(sr);
  const binHz = sr / FFT_SIZE;
  const bands: Float32Array[] = [];
  const flux = new Float32Array(frames);
  const subBass = new Float32Array(frames);
  const air = new Float32Array(frames);
  const centroid = new Float32Array(frames);

  const win = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));

  let prev: Float32Array | null = null;
  let maxBand = 1e-6;

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = ch1 ? (ch0[off + i] + ch1[off + i]) * 0.5 : ch0[off + i];
      re[i] = (s || 0) * win[i];
    }
    fft(re, im);

    const b = new Float32Array(32);
    let cNum = 0, cDen = 0;
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const hz = k * binHz;
      cNum += hz * mag; cDen += mag;
      // locate band by binary-ish walk (32 edges, cheap linear scan)
      for (let s = 0; s < 32; s++) {
        if (hz >= edges[s] && hz < edges[s + 1]) { b[s] += mag; break; }
      }
    }
    let fl = 0;
    for (let s = 0; s < 32; s++) {
      if (b[s] > maxBand) maxBand = b[s];
      if (prev) fl += Math.max(0, b[s] - prev[s]);
    }
    bands.push(b);
    flux[f] = fl;
    centroid[f] = cDen > 0 ? cNum / cDen : 0;
    let low = 0, high = 0;
    for (let s = 0; s < 6; s++) low += b[s];
    for (let s = 24; s < 32; s++) high += b[s];
    subBass[f] = low; air[f] = high;
    prev = b;
  }

  // normalise everything to 0..1
  const norm = (arr: Float32Array) => {
    let m = 1e-6;
    for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    for (let i = 0; i < arr.length; i++) arr[i] = arr[i] / m;
  };
  norm(flux); norm(subBass); norm(air);
  for (const b of bands) for (let s = 0; s < 32; s++) b[s] = b[s] / maxBand;

  return { frameSec: hop / sr, frames, bands, flux, subBass, air, centroid };
}
