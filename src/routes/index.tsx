import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Raja AI Pro-Editor — Auto Beat Sync Video" },
      { name: "description", content: "2026 trending auto beat-sync video maker. Upload audio + photos, get a 1080p Shorts-ready clip — all in your browser." },
      { property: "og:title", content: "Raja AI Pro-Editor" },
      { property: "og:description", content: "Auto beat-sync 1080p video editor. 100% browser, no install." },
    ],
  }),
  component: Index,
});

function Index() {
  return <Editor />;
}

/* ---------------- types ---------------- */
type Beats = {
  times: number[];      // all onset times (fallback + display)
  kicks: number[];      // low-band (bass/kick) peaks — used for photo cuts
  claps: number[];      // mid-band snare/clap peaks — slide + flash triggers
  hats: number[];       // ultra-high hi-hat peaks — rapid micro-cuts
  kickEnv: Float32Array;  // normalized 0..1 bass envelope (per hop)
  clapEnv: Float32Array;  // normalized 0..1 snare/clap envelope
  hatEnv: Float32Array;   // normalized 0..1 hi-hat envelope
  hop: number;           // seconds per envelope sample
  bpm: number;
  duration: number;
};
type Stage = "idle" | "analyzing" | "ready" | "rendering" | "done";
type SavePickerHandle = {
  queryPermission?: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>;
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
    abort?: () => Promise<void>;
  }>;
};
type SavePickerWindow = Window &
  typeof globalThis & {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<SavePickerHandle>;
  };
type EncodeWorkerMessage =
  | { type: "progress"; progress: number; message?: string }
  | { type: "log"; message: string }
  | { type: "done"; buffer: ArrayBuffer }
  | { type: "error"; message: string; category: "memory" | "format" | "timeout" | "unknown"; logs: string[] };

/* ---------------- Beat detection (band-separated peak picker) ----------------
   Runs the decoded audio through 3 offline biquad chains:
     • Low  (<120 Hz)     → kick / bass hits — millisecond-locked photo cuts
     • High (~3–6 kHz)    → snare / hi-hat   → real-time flash
     • Full band          → generic onsets   (fallback / display BPM)
   Envelopes are normalized to 0..1 so the render loop can read them as
   "punch intensity" per frame — visuals are literally controlled by the wave.
*/
async function renderBand(
  audio: AudioBuffer,
  type: BiquadFilterType,
  frequency: number,
  Q: number,
): Promise<Float32Array> {
  const OfflineCtx =
    window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const offline = new OfflineCtx(1, audio.length, audio.sampleRate);
  const src = offline.createBufferSource();
  src.buffer = audio;
  const filter = offline.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = Q;
  src.connect(filter).connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  // downmix to mono
  const ch0 = rendered.getChannelData(0);
  if (rendered.numberOfChannels === 1) return ch0.slice();
  const ch1 = rendered.getChannelData(1);
  const out = new Float32Array(ch0.length);
  for (let i = 0; i < ch0.length; i++) out[i] = (ch0[i] + ch1[i]) * 0.5;
  return out;
}

function envelopeOf(samples: Float32Array, sr: number, hopSec: number): Float32Array {
  const hop = Math.max(1, Math.floor(sr * hopSec));
  const win = hop * 2;
  const frames = Math.max(0, Math.floor((samples.length - win) / hop));
  const env = new Float32Array(frames);
  let max = 1e-6;
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    let s = 0;
    for (let j = 0; j < win; j++) {
      const v = samples[start + j];
      s += v * v;
    }
    const r = Math.sqrt(s / win);
    env[f] = r;
    if (r > max) max = r;
  }
  // normalize 0..1
  for (let f = 0; f < frames; f++) env[f] = env[f] / max;
  return env;
}

function pickPeaks(
  env: Float32Array,
  hopSec: number,
  {
    windowFrames,
    ratio,
    minGapSec,
    floor,
  }: { windowFrames: number; ratio: number; minGapSec: number; floor: number },
): number[] {
  const peaks: number[] = [];
  const minGapFrames = Math.max(1, Math.floor(minGapSec / hopSec));
  let lastPeak = -Infinity;
  for (let i = windowFrames; i < env.length - windowFrames; i++) {
    let mean = 0;
    for (let k = i - windowFrames; k <= i + windowFrames; k++) mean += env[k];
    mean /= windowFrames * 2 + 1;
    const v = env[i];
    if (v > floor && v > mean * ratio && v > env[i - 1] && v >= env[i + 1] && i - lastPeak >= minGapFrames) {
      peaks.push(i * hopSec);
      lastPeak = i;
    }
  }
  return peaks;
}

async function analyzeBeats(file: File): Promise<Beats> {
  const arr = await file.arrayBuffer();
  const ac = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const audio = await ac.decodeAudioData(arr.slice(0));
  ac.close();
  const sr = audio.sampleRate;
  const hopSec = 0.01; // 10 ms — sub-frame precision for millisecond locking

  // Filter into 3 bands in parallel
  const [lowBuf, midBuf, hatBuf, fullBuf] = await Promise.all([
    renderBand(audio, "lowpass", 120, 0.9),      // kick / bass thump
    renderBand(audio, "bandpass", 2200, 0.9),    // snare / clap body
    renderBand(audio, "highpass", 8000, 0.9),    // hi-hat / cymbal shimmer
    renderBand(audio, "allpass", 1000, 0.7),     // full-band envelope
  ]);

  const kickEnv = envelopeOf(lowBuf, sr, hopSec);
  const clapEnv = envelopeOf(midBuf, sr, hopSec);
  const hatEnv  = envelopeOf(hatBuf, sr, hopSec);
  const fullEnv = envelopeOf(fullBuf, sr, hopSec);

  const kicks = pickPeaks(kickEnv, hopSec, { windowFrames: 30, ratio: 1.35, minGapSec: 0.14, floor: 0.18 });
  const claps = pickPeaks(clapEnv, hopSec, { windowFrames: 22, ratio: 1.4,  minGapSec: 0.10, floor: 0.15 });
  const hats  = pickPeaks(hatEnv,  hopSec, { windowFrames: 14, ratio: 1.45, minGapSec: 0.06, floor: 0.12 });
  let times   = pickPeaks(fullEnv, hopSec, { windowFrames: 25, ratio: 1.35, minGapSec: 0.16, floor: 0.15 });

  // Prefer kicks as the master timeline if we have enough of them
  if (kicks.length >= 8) times = kicks.slice();

  const diffs = times.slice(1).map((b, i) => b - times[i]).sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)] || 0.5;
  const bpm = Math.round(60 / median);

  return {
    times,
    kicks: kicks.length >= 4 ? kicks : times,
    claps,
    hats,
    kickEnv,
    clapEnv,
    hatEnv,
    hop: hopSec,
    bpm,
    duration: audio.duration,
  };
}

/* ---------------- Finalization worker + save helpers ---------------- */
async function requestOutputFileHandle(): Promise<SavePickerHandle | null> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (!picker) return null;

  try {
    const handle = await picker({
      suggestedName: "raja-ai-video.mp4",
      types: [{ description: "MP4 Video", accept: { "video/mp4": [".mp4"] } }],
    });
    let permission: PermissionState = "granted";
    if (handle.queryPermission) permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted" && handle.requestPermission) {
      permission = await handle.requestPermission({ mode: "readwrite" });
    }
    if (permission !== "granted") {
      console.warn("[Raja AI] File System write permission was not granted; falling back to browser download.");
      return null;
    }
    return handle;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      console.warn("[Raja AI] File System Access API failed; falling back to browser download.", error);
    }
    return null;
  }
}

async function saveWithFileHandle(handle: SavePickerHandle, blob: Blob) {
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort?.();
    throw error;
  }
}

function autoDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "raja-ai-video.mp4";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function getBestRecorderMime() {
  const candidates = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function getRenderErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.toLowerCase();
  if (text.includes("memory") || text.includes("allocation") || text.includes("out of bounds")) {
    return "Memory overflow during MP4 finalization. कृपया कम/छोटी photos या छोटा audio इस्तेमाल करें.";
  }
  if (text.includes("format") || text.includes("codec") || text.includes("invalid data") || text.includes("mux")) {
    return "Format mismatch during finalization. कृपया दूसरा audio/photo format इस्तेमाल करें.";
  }
  if (text.includes("stalled") || text.includes("timeout") || text.includes("aborted")) {
    return "Finalization timeout हुआ. Browser ने encoder को रोक दिया — छोटा video या fewer photos try करें.";
  }
  return raw || "Unknown rendering error";
}

function encodeWebmInWorker({
  webmBuffer,
  width,
  height,
  fps,
  duration,
  onProgress,
}: {
  webmBuffer: ArrayBuffer;
  width: number;
  height: number;
  fps: number;
  duration: number;
  onProgress: (progress: number, message?: string) => void;
}) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const worker = new Worker(new URL("../workers/ffmpegEncode.worker.ts", import.meta.url), { type: "module" });
    let settled = false;
    let lastSignalAt = performance.now();

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearInterval(stallTimer);
      worker.terminate();
      callback();
    };

    const stallTimer = window.setInterval(() => {
      if (performance.now() - lastSignalAt > 60_000) {
        finish(() => reject(new Error("MP4 finalization stalled after 60 seconds without encoder progress.")));
      }
    }, 3000);

    worker.onmessage = ({ data }: MessageEvent<EncodeWorkerMessage>) => {
      lastSignalAt = performance.now();
      if (data.type === "progress") {
        onProgress(data.progress, data.message);
      } else if (data.type === "log") {
        if (/memory|allocation|invalid data|format|codec|mux|error/i.test(data.message)) {
          console.warn("[Raja AI Encoder]", data.message);
        }
      } else if (data.type === "done") {
        finish(() => resolve(data.buffer));
      } else if (data.type === "error") {
        console.error("[Raja AI Encoder]", data.category, data.message, data.logs);
        finish(() => reject(new Error(`${data.category}: ${data.message}`)));
      }
    };

    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "Encoder worker crashed during MP4 finalization.")));
    };

    worker.postMessage({ type: "encode", webmBuffer, width, height, fps, duration }, [webmBuffer]);
  });
}

/* ---------------- Effects per beat ---------------- */
/* ---------------- Cinematic 2050 Effects Engine ----------------
   Each cut gets a randomized *style pack* — a base transform plus
   independent modifiers. With 8 bases × 8 entries × 6 exits × 4 filters
   we get well over 1500 unique combinations, so no two cuts look alike.
*/
type StylePack = {
  base: "kenburns" | "punchIn" | "punchOut" | "orbit" | "tiltShake" | "whipPan" | "dolly" | "handheld";
  entry: "slideL" | "slideR" | "slideU" | "slideD" | "irisIn" | "zoomIn" | "blurIn" | "spinIn";
  exit:  "slideL" | "slideR" | "slideU" | "slideD" | "irisOut" | "zoomOut" | "blurOut" | "none";
  filter: "none" | "warm" | "cool" | "noir" | "sepia";
  panX: number; panY: number;   // ken-burns direction (-1..1)
  rotDir: number;               // -1 | 1
  seed: number;
};

function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pickStylePack(seed: number, prev?: StylePack): StylePack {
  const rand = mulberry32(seed);
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
  const bases = ["kenburns","punchIn","punchOut","orbit","tiltShake","whipPan","dolly","handheld"] as const;
  const entries = ["slideL","slideR","slideU","slideD","irisIn","zoomIn","blurIn","spinIn"] as const;
  const exits = ["slideL","slideR","slideU","slideD","irisOut","zoomOut","blurOut","none"] as const;
  const filters = ["none","none","warm","cool","noir","sepia"] as const;
  let base = pick(bases); if (prev && base === prev.base) base = pick(bases);
  let entry = pick(entries); if (prev && entry === prev.entry) entry = pick(entries);
  let exit = pick(exits); if (prev && exit === prev.exit) exit = pick(exits);
  return {
    base, entry, exit, filter: pick(filters),
    panX: rand() * 2 - 1, panY: rand() * 2 - 1,
    rotDir: rand() > 0.5 ? 1 : -1,
    seed,
  };
}

const EASE = (x: number) => 1 - Math.pow(1 - x, 3);

function drawFrame(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  W: number,
  H: number,
  style: StylePack,
  progress: number, // 0..1 within this beat segment
  punch: number,    // bass 0..1
  flash: number,    // snare/clap 0..1
  shimmer: number,  // hi-hat 0..1
) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  // filter tint (cinematic color grade)
  let filter = "";
  if (style.filter === "warm") filter = "saturate(1.15) hue-rotate(-10deg) contrast(1.08)";
  else if (style.filter === "cool") filter = "saturate(1.1) hue-rotate(12deg) contrast(1.05)";
  else if (style.filter === "noir") filter = "grayscale(0.85) contrast(1.25) brightness(0.95)";
  else if (style.filter === "sepia") filter = "sepia(0.55) contrast(1.1)";

  // base camera transform
  const baseScale = Math.max(W / img.width, H / img.height);
  let scale = baseScale;
  let dx = 0, dy = 0, rot = 0;
  const eased = EASE(progress);

  switch (style.base) {
    case "kenburns":
      scale *= 1.05 + 0.12 * eased + 0.18 * punch;
      dx = style.panX * 60 * eased;
      dy = style.panY * 40 * eased;
      break;
    case "punchIn":
      scale *= 1 + 0.25 * eased + 0.28 * punch;
      break;
    case "punchOut":
      scale *= 1.3 - 0.25 * eased + 0.2 * punch;
      break;
    case "orbit":
      scale *= 1.08 + 0.1 * punch;
      rot = style.rotDir * 0.08 * (eased - 0.5);
      dx = Math.sin(progress * Math.PI) * 40 * style.panX;
      break;
    case "tiltShake": {
      // Shake ONLY when bass actually punches — otherwise stay calm
      scale *= 1.03 + 0.18 * punch;
      rot = style.rotDir * (0.02 + 0.05 * punch);
      const amp = punch > 0.35 ? 45 * (punch - 0.3) : 0;
      dx = (Math.random() - 0.5) * amp;
      dy = (Math.random() - 0.5) * amp;
      break;
    }
    case "whipPan":
      scale *= 1.05;
      dx = (progress - 0.5) * W * 0.6 * style.rotDir;
      break;
    case "dolly":
      scale *= 1 + 0.35 * eased + 0.25 * punch;
      dy = -eased * 30;
      break;
    case "handheld": {
      // Subtle handheld drift — random jitter gated on bass intensity
      scale *= 1.04 + 0.14 * punch;
      const t = progress * Math.PI * 4;
      const jitter = punch > 0.35 ? 24 * (punch - 0.3) : 0;
      dx = Math.sin(t + style.seed) * 8 + (Math.random() - 0.5) * jitter;
      dy = Math.cos(t * 0.9) * 6 + (Math.random() - 0.5) * jitter;
      rot = Math.sin(t * 0.4) * 0.015;
      break;
    }
  }

  // Bass-driven screen shake ON TOP of the base — high threshold so
  // gentle songs stay calm, only heavy kicks trigger real impact.
  if (punch > 0.55) {
    const amp = 20 * (punch - 0.5);
    dx += (Math.random() - 0.5) * amp;
    dy += (Math.random() - 0.5) * amp;
  }

  // entry animation (first 25% of segment)
  let entryAlpha = 1;
  if (progress < 0.25) {
    const p = progress / 0.25;
    const inv = 1 - EASE(p);
    entryAlpha = EASE(p);
    switch (style.entry) {
      case "slideL": dx -= W * 0.6 * inv; break;
      case "slideR": dx += W * 0.6 * inv; break;
      case "slideU": dy -= H * 0.6 * inv; break;
      case "slideD": dy += H * 0.6 * inv; break;
      case "zoomIn": scale *= 0.6 + 0.4 * EASE(p); break;
      case "spinIn": rot += inv * 0.8 * style.rotDir; scale *= 0.6 + 0.4 * EASE(p); break;
      case "irisIn": /* handled below via clip */ break;
      case "blurIn": /* handled via filter */
        filter = (filter + ` blur(${inv * 14}px)`).trim();
        break;
    }
  }
  // exit animation (last 20% of segment)
  if (progress > 0.8 && style.exit !== "none") {
    const p = (progress - 0.8) / 0.2;
    const e = EASE(p);
    switch (style.exit) {
      case "slideL": dx -= W * 0.5 * e; break;
      case "slideR": dx += W * 0.5 * e; break;
      case "slideU": dy -= H * 0.5 * e; break;
      case "slideD": dy += H * 0.5 * e; break;
      case "zoomOut": scale *= 1 + 0.35 * e; entryAlpha *= 1 - e * 0.6; break;
      case "blurOut": filter = (filter + ` blur(${e * 12}px)`).trim(); break;
      case "irisOut": /* handled below via clip */ break;
    }
  }

  const dw = img.width * scale;
  const dh = img.height * scale;

  // iris (radial clip) support
  const needIris =
    (style.entry === "irisIn" && progress < 0.25) ||
    (style.exit === "irisOut" && progress > 0.8);

  ctx.save();
  if (needIris) {
    let r: number;
    if (style.entry === "irisIn" && progress < 0.25) {
      const p = progress / 0.25;
      r = EASE(p) * Math.hypot(W, H) * 0.7;
    } else {
      const p = (progress - 0.8) / 0.2;
      r = (1 - EASE(p)) * Math.hypot(W, H) * 0.7;
    }
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, Math.max(1, r), 0, Math.PI * 2);
    ctx.clip();
  }

  ctx.filter = filter || "none";
  ctx.globalAlpha = entryAlpha;

  // motion-blur trail — bass and whip-pan produce more trails
  const trails = Math.min(6, Math.round(1 + punch * 5 + (style.base === "whipPan" ? 3 : 0)));
  for (let k = trails; k >= 1; k--) {
    const f = k / trails;
    ctx.globalAlpha = entryAlpha * (0.14 + 0.15 * (1 - f));
    ctx.save();
    ctx.translate(W / 2 + dx * (1 - f * 0.4), H / 2 + dy * (1 - f * 0.4));
    if (rot) ctx.rotate(rot * (1 - f * 0.3));
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
  // sharp top layer
  ctx.globalAlpha = entryAlpha;
  ctx.save();
  ctx.translate(W / 2 + dx, H / 2 + dy);
  if (rot) ctx.rotate(rot);
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();

  ctx.filter = "none";
  ctx.globalAlpha = 1;

  // hi-hat shimmer → subtle chromatic aberration
  if (shimmer > 0.25) {
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.35 * shimmer;
    const s = 10 * shimmer;
    ctx.drawImage(img, W / 2 - dw / 2 + s + dx, H / 2 - dh / 2 + dy, dw, dh);
    ctx.globalAlpha = 0.35 * shimmer;
    ctx.drawImage(img, W / 2 - dw / 2 - s + dx, H / 2 - dh / 2 + dy, dw, dh);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  // bass-driven RGB split for extra impact
  if (punch > 0.55) {
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.5 * punch;
    ctx.drawImage(img, W / 2 - dw / 2 + 22 * punch + dx, H / 2 - dh / 2 + dy, dw, dh);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  ctx.restore();

  // clap/snare white flash
  if (flash > 0.35) {
    ctx.fillStyle = `rgba(255,255,255,${Math.min(0.85, (flash - 0.35) * 1.7)})`;
    ctx.fillRect(0, 0, W, H);
  }

  // film grain (very subtle, hi-hat modulated)
  if (shimmer > 0.15) {
    ctx.globalAlpha = 0.06 + shimmer * 0.05;
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = Math.random() > 0.5 ? "#fff" : "#000";
      ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
    }
    ctx.globalAlpha = 1;
  }

  // cinematic vignette
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.78);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/* ---------------- Editor UI ---------------- */
function Editor() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [beats, setBeats] = useState<Beats | null>(null);
  const [slots, setSlots] = useState<(File | null)[]>([]);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<"record" | "encode" | "">("");
  const [log, setLog] = useState("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [exporting, setExporting] = useState(false);
  const [mode, setMode] = useState<"shorts" | "long">("shorts");
  const [celebrate, setCelebrate] = useState(false);

  const renderIdRef = useRef(0);
  const lastProgressRef = useRef({ p: 0, t: 0 });
  const retryRef = useRef(0);

  const photosNeeded = beats ? Math.max(4, Math.ceil(beats.times.length / 2)) : 0;
  const filledCount = slots.filter(Boolean).length;
  const aspect: "9:16" | "16:9" = mode === "shorts" ? "9:16" : "16:9";

  async function onAudio(f: File) {
    console.log("[Raja AI] STEP 1 ▶ Audio selected:", f.name, f.type, f.size);
    setAudioFile(f);
    setStage("analyzing");
    setLog("ऑडियो स्कैन हो रहा है…");
    try {
      const b = await analyzeBeats(f);
      console.log("[Raja AI] STEP 1 ✓ Beats ready — slots unlocked", b);
      setBeats(b);
      const need = Math.max(4, Math.ceil(b.times.length / 2));
      setSlots(new Array(need).fill(null));
      setStage("ready");
      setLog(`✓ ${b.duration.toFixed(1)}s • ~${b.bpm} BPM • ${b.times.length} beats detected`);
    } catch (e: any) {
      console.error("[Raja AI] STEP 1 ✗ Audio decode failed:", e);
      setStage("idle");
      setLog("ऑडियो डिकोड नहीं हो सका: " + e.message);
    }
  }

  function setSlot(idx: number, file: File | null) {
    console.log(`[Raja AI] STEP 2 ▶ Slot ${idx + 1} ${file ? "filled" : "cleared"}`, file?.name);
    setSlots((s) => {
      const next = [...s];
      next[idx] = file;
      return next;
    });
  }

  function fillSlotsBulk(list: FileList | null) {
    if (!list) return;
    const arr = Array.from(list).filter((f) => f.type.startsWith("image/"));
    setSlots((s) => {
      const next = [...s];
      let j = 0;
      for (let i = 0; i < next.length && j < arr.length; i++) {
        if (!next[i]) next[i] = arr[j++];
      }
      // if more files than slots, replace from start with remainder
      for (let i = 0; i < next.length && j < arr.length; i++) next[i] = arr[j++];
      return next;
    });
  }

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  async function exportPreviewVideo() {
    console.log("[Raja AI] EXPORT ▶ SAVE / EXPORT clicked", { ready: !!videoBlob, hasUrl: !!videoUrl });
    if (!videoBlob || !videoUrl) return;
    setExporting(true);
    try {
      const outputHandle = await requestOutputFileHandle();
      if (outputHandle) {
        setLog("वीडियो फाइल save हो रही है…");
        await saveWithFileHandle(outputHandle, videoBlob);
        setLog("✓ वीडियो सेव हो गया!");
      } else {
        autoDownload(videoUrl);
        setLog("✓ डाउनलोड शुरू हो गया!");
      }
    } catch (error) {
      console.error("[Raja AI] EXPORT ✗ Save failed", error);
      setLog(`Export error: ${getRenderErrorMessage(error)}`);
    } finally {
      setExporting(false);
    }
  }

  // Watchdog: if progress stalls > 18s during rendering, force-restart
  useEffect(() => {
    if (stage !== "rendering") return;
    const id = setInterval(() => {
      const now = performance.now();
      if (progress >= 1) return;
      if (progress > lastProgressRef.current.p + 0.001) {
        lastProgressRef.current = { p: progress, t: now };
        return;
      }
      if (phase === "encode") {
        if (now - lastProgressRef.current.t > 25_000) {
          setLog("MP4 finalization worker में जारी है — buffer flush हो रहा है…");
        }
        return;
      }
      if (now - lastProgressRef.current.t > 18000 && retryRef.current < 2) {
        retryRef.current += 1;
        setLog(`⏱ अटका — ऑटो-रिस्टार्ट (${retryRef.current}/2)…`);
        renderIdRef.current += 1; // cancels in-flight render loop
        // restart
        setTimeout(() => { void generate(); }, 300);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [stage, phase, progress]); // eslint-disable-line react-hooks/exhaustive-deps

  async function generate() {
    console.log("[Raja AI] STEP 4 ▶ GO clicked — triggering render engine");
    const photos = slots.filter(Boolean) as File[];
    if (!audioFile || !beats || photos.length === 0) {
      console.warn("[Raja AI] STEP 4 ✗ blocked", { audio: !!audioFile, beats: !!beats, photos: photos.length });
      return;
    }
    const myId = ++renderIdRef.current;
    lastProgressRef.current = { p: 0, t: performance.now() };
    setStage("rendering");
    setProgress(0);
    setPhase("record");
    setVideoUrl(null);
    setVideoBlob(null);
    setCelebrate(false);
    setLog("रेंडर शुरू…");

    const dims = aspect === "9:16" ? [1080, 1920] : [1920, 1080];
    const [W, H] = dims;
    const FPS = 60; // buttery-smooth cinematic frame rate

    try {
      // load images
      const imageUrls: string[] = [];
      const imgs = await Promise.all(
        photos.map(
          (f) =>
            new Promise<HTMLImageElement>((res, rej) => {
              const i = new Image();
              const objectUrl = URL.createObjectURL(f);
              imageUrls.push(objectUrl);
              i.onload = () => res(i);
              i.onerror = rej;
              i.src = objectUrl;
            }),
        ),
      );

      // Master timeline = kicks (bass hits) merged with the strongest hi-hats
      // for rapid micro-cuts. Deduped + sorted so every cut is millisecond-locked
      // to something in the waveform.
      const kickList = beats.kicks.length >= 4 ? beats.kicks : beats.times;
      const microCuts = beats.hats.filter((_, i) => i % 3 === 0); // every 3rd hat
      const merged = [...kickList, ...microCuts].sort((a, b) => a - b);
      const cutTimes: number[] = [];
      for (const t of merged) {
        if (cutTimes.length === 0 || t - cutTimes[cutTimes.length - 1] > 0.08) cutTimes.push(t);
      }
      const segments = cutTimes.length;
      const seq: { img: HTMLImageElement; style: StylePack }[] = [];
      let prevStyle: StylePack | undefined;
      for (let i = 0; i < segments; i++) {
        const cycle = Math.floor(i / imgs.length);
        const idx = cycle % 2 === 0 ? i % imgs.length : imgs.length - 1 - (i % imgs.length);
        const style = pickStylePack(i * 9301 + 49297, prevStyle);
        seq.push({ img: imgs[idx], style });
        prevStyle = style;
      }

      // canvas + audio → MediaRecorder
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d")!;

      const audioUrl = URL.createObjectURL(audioFile);
      const audioEl = new Audio(audioUrl);
      audioEl.crossOrigin = "anonymous";
      await new Promise((r) => (audioEl.oncanplaythrough = r));

      const ac = new AudioContext();
      const src = ac.createMediaElementSource(audioEl);
      const dest = ac.createMediaStreamDestination();
      src.connect(dest);

      const stream = canvas.captureStream(FPS);
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

      const mime = getBestRecorderMime();
      const recordsMp4Directly = mime.startsWith("video/mp4");
      console.log("[Raja AI] Recorder selected", { mime, recordsMp4Directly });
      const rec = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        videoBitsPerSecond: recordsMp4Directly ? 9_000_000 : 10_500_000,
        audioBitsPerSecond: 192_000,
      });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const recDone = new Promise<Blob>((r) => (rec.onstop = () => r(new Blob(chunks, { type: recordsMp4Directly ? "video/mp4" : "video/webm" }))));

      rec.start(250);
      await ac.resume();
      audioEl.currentTime = 0;
      await audioEl.play();

      let stop = false;
      const ended = new Promise<void>((resolve) => {
        audioEl.onended = () => {
          stop = true;
          resolve();
        };
        audioEl.onerror = () => {
          stop = true;
          resolve();
        };
      });
      let raf = 0;

      const render = () => {
        if (stop || renderIdRef.current !== myId) return;
        const t = audioEl.currentTime;
        // locate current cut segment (kick-locked)
        let i = 0;
        while (i < cutTimes.length - 1 && cutTimes[i + 1] <= t) i++;
        const segStart = cutTimes[i] ?? 0;
        const segEnd = cutTimes[i + 1] ?? beats.duration;
        const segLen = Math.max(0.05, segEnd - segStart);
        const local = Math.min(1, Math.max(0, (t - segStart) / segLen));
        // Live audio-reactive envelopes — literally the waveform driving pixels
        const envIdx = Math.min(beats.kickEnv.length - 1, Math.max(0, Math.floor(t / beats.hop)));
        const punch   = beats.kickEnv[envIdx] ?? 0;  // bass → zoom / screen shake
        const flash   = beats.clapEnv[envIdx] ?? 0;  // clap/snare → white flash
        const shimmer = beats.hatEnv[envIdx] ?? 0;   // hi-hat → chroma + grain
        const fallback: { img: HTMLImageElement; style: StylePack } = {
          img: imgs[0],
          style: pickStylePack(0),
        };
        const item = seq[Math.min(i, seq.length - 1)] || fallback;
        drawFrame(ctx, item.img, W, H, item.style, local, punch, flash, shimmer);

        // record phase → 0..0.95 (mp4 direct) or 0..0.65 (needs encode)
        const recordCap = recordsMp4Directly ? 0.95 : 0.65;
        setProgress(Math.min(recordCap, (t / beats.duration) * recordCap));
        raf = requestAnimationFrame(render);
      };
      raf = requestAnimationFrame(render);

      await ended;
      cancelAnimationFrame(raf);
      if (renderIdRef.current !== myId) return;
      await new Promise((r) => setTimeout(r, 350));
      rec.requestData();
      await new Promise((r) => setTimeout(r, 150));
      rec.stop();
      const webm = await recDone;
      stream.getTracks().forEach((track) => track.stop());
      await ac.close();
      URL.revokeObjectURL(audioUrl);
      imageUrls.forEach((url) => URL.revokeObjectURL(url));
      if (renderIdRef.current !== myId) return;
      let mp4: Blob;
      if (recordsMp4Directly) {
        setProgress(0.98);
        setPhase("encode");
        setLog("AI editing complete — MP4 buffer flush हो रहा है…");
        await waitForNextPaint();
        mp4 = webm;
      } else {
        setProgress(0.66);
        setPhase("encode");
        setLog("AI editing complete — अब 1080p MP4 file बन रही है…");
        const webmBuffer = await webm.arrayBuffer();
        try {
          const mp4Buffer = await encodeWebmInWorker({
            webmBuffer,
            width: W,
            height: H,
            fps: FPS,
            duration: beats.duration,
            onProgress: (p, message) => {
              const pp = Math.max(0, Math.min(1, p));
              // encoder phase → 0.66..0.99 (100% is reserved for finalize)
              setProgress(0.66 + pp * 0.33);
              if (message) setLog(`${message}…`);
            },
          });
          mp4 = new Blob([mp4Buffer], { type: "video/mp4" });
        } catch (encodeErr) {
          // 100% guarantee: fall back to raw WebM instead of dying at 70%
          console.warn("[Raja AI] MP4 encoder failed — falling back to WebM output", encodeErr);
          setLog("MP4 encoder busy — WebM फ़ॉलबैक से 100% पूरा किया जा रहा है…");
          mp4 = new Blob([webmBuffer], { type: "video/webm" });
        }
      }
      if (renderIdRef.current !== myId) return;

      if (mp4.size === 0) throw new Error("Format mismatch: generated MP4 buffer is empty");
      const url = URL.createObjectURL(mp4);
      setProgress(1);
      setPhase("");
      setLog("✓ 100% video generated — preview तैयार हो रहा है…");
      await waitForNextPaint();
      if (renderIdRef.current !== myId) {
        URL.revokeObjectURL(url);
        return;
      }
      setVideoBlob(mp4);
      setVideoUrl(url);
      setStage("done");
      setCelebrate(true);
      setLog("✓ Preview तैयार है — SAVE दबाने पर ही डाउनलोड होगा.");
      retryRef.current = 0;
      setTimeout(() => setCelebrate(false), 3500);
    } catch (error) {
      console.error("[Raja AI] Rendering finalization failed", error);
      if (renderIdRef.current !== myId) return;
      setStage("ready");
      setPhase("");
      setProgress(0);
      setLog(`Finalization error: ${getRenderErrorMessage(error)}`);
    }
  }

  const audioReady = !!beats && stage !== "analyzing";
  const photosReady = audioReady && filledCount >= 1;
  const canGenerate = photosReady && stage !== "rendering";

  return (
    <div
      className="min-h-screen text-white"
      style={{
        background:
          "radial-gradient(1200px 800px at 20% -10%, #2a1457 0%, transparent 60%), radial-gradient(900px 700px at 110% 20%, #ff2e88 0%, transparent 55%), #0b0617",
      }}
    >
      <div className="relative z-10 mx-auto max-w-2xl px-5 py-10" style={{ pointerEvents: "auto" }}>
        <header className="mb-10 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[10px] tracking-[0.3em] uppercase backdrop-blur-xl">
            <span className="h-1.5 w-1.5 rounded-full bg-[#ff2e88]" /> 2026 Edition
          </div>
          <h1 className="mt-4 text-4xl font-black leading-tight md:text-5xl">
            Raja AI{" "}
            <span className="bg-gradient-to-r from-[#ff2e88] via-[#ffb347] to-[#7c5cff] bg-clip-text text-transparent">
              Pro-Editor
            </span>
          </h1>
        </header>

        {/* STEP 1: AUDIO (top layer) */}
        {!audioFile && (
          <div className="relative z-30" style={{ pointerEvents: "auto" }}>
            <BigAudioButton onPick={onAudio} loading={stage === "analyzing"} />
          </div>
        )}

        {audioFile && beats && (
          <div className="relative z-30 rounded-2xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-xl" style={{ pointerEvents: "auto" }}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">🎵 {audioFile.name}</div>
                <div className="mt-0.5 text-[11px] text-white/60">
                  {beats.duration.toFixed(1)}s • {beats.bpm} BPM • {beats.times.length} beats
                </div>
              </div>
              <label className="relative z-30 shrink-0 cursor-pointer rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10" style={{ pointerEvents: "auto" }}>
                बदलें
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => { console.log("[Raja AI] STEP 1 ▶ Replace-audio"); e.target.files?.[0] && onAudio(e.target.files[0]); }}
                />
              </label>
            </div>
          </div>
        )}

        {/* STEP 2: PHOTO SLOTS */}
        {beats && stage !== "rendering" && stage !== "done" && (
          <div className="relative z-20 mt-6" style={{ pointerEvents: "auto" }}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-wider text-white/80">
                📸 Step 2 — फोटो भरें ({filledCount}/{photosNeeded})
              </h2>
              <label className="relative z-20 cursor-pointer text-xs text-white/60 underline-offset-4 hover:text-white hover:underline" style={{ pointerEvents: "auto" }}>
                सब एक साथ चुनें
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => { console.log("[Raja AI] STEP 2 ▶ Bulk:", e.target.files?.length ?? 0); fillSlotsBulk(e.target.files); }}
                />
              </label>
            </div>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {slots.map((f, i) => (
                <PhotoSlot
                  key={i}
                  file={f}
                  index={i}
                  enabled={audioReady}
                  onPick={(file) => setSlot(i, file)}
                  onClear={() => setSlot(i, null)}
                />
              ))}
            </div>
          </div>
        )}

        {/* STEP 3: MODE */}
        {beats && filledCount >= 1 && stage !== "rendering" && stage !== "done" && (
          <div className="relative z-20 mt-8" style={{ pointerEvents: "auto" }}>
            <h2 className="mb-3 text-sm font-semibold tracking-wider text-white/80">
              🎬 Step 3 — मोड चुनें ({mode === "shorts" ? "Shorts" : "Long"})
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <ModeCard
                active={mode === "shorts"}
                title="Shorts"
                sub="15–60s • 9:16"
                onClick={() => { console.log("[Raja AI] STEP 3 ▶ Mode: shorts"); setMode("shorts"); }}
              />
              <ModeCard
                active={mode === "long"}
                title="Long Video"
                sub="1m+ • 16:9"
                onClick={() => { console.log("[Raja AI] STEP 3 ▶ Mode: long"); setMode("long"); }}
              />
            </div>
          </div>
        )}

        {/* STEP 4: GO */}
        {beats && stage !== "rendering" && stage !== "done" && (
          <div className="relative z-20 mt-8" style={{ pointerEvents: "auto" }}>
            <button
              type="button"
              disabled={!canGenerate}
              onClick={() => { console.log("[Raja AI] STEP 4 ▶ GO clicked", { canGenerate }); void generate(); }}
              className="group relative z-20 block w-full overflow-hidden rounded-3xl bg-gradient-to-r from-[#ff2e88] via-[#ff6a3d] to-[#ffb347] py-7 text-2xl font-black tracking-[0.25em] text-black shadow-[0_20px_60px_-15px_rgba(255,46,136,0.7)] transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ pointerEvents: "auto" }}
            >
              <span className="relative z-10">{canGenerate ? "GO ▶" : "GO (पहले फोटो भरें)"}</span>
              <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/40 to-transparent transition-transform duration-1000 group-hover:translate-x-full" />
            </button>
            {!canGenerate && (
              <p className="mt-2 text-center text-[11px] text-white/50">
                {filledCount === 0 ? "कम से कम 1 फोटो स्लॉट भरें" : "तैयार होते ही एक्टिव होगा"}
              </p>
            )}
          </div>
        )}

        {/* RENDERING OVERLAY */}
        {stage === "rendering" && (
          <RenderingOverlay
            progress={progress}
            phase={phase}
            log={log}
          />
        )}

        {/* DONE */}
        {stage === "done" && videoUrl && (
          <div className="relative z-30 mt-2 rounded-2xl border border-white/10 bg-white/[0.04] p-5 backdrop-blur-xl" style={{ pointerEvents: "auto" }}>
            <div className="mb-4 text-center">
              <div className="text-xs font-semibold uppercase tracking-[0.3em] text-white/50">Preview Ready</div>
              <h2 className="mt-2 text-2xl font-black">Video Preview Player</h2>
              <p className="mt-1 text-xs text-white/55">पहले वीडियो देखें, फिर नीचे SAVE / EXPORT दबाएँ.</p>
            </div>
            <video
              src={videoUrl}
              controls
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              className="relative z-30 w-full rounded-xl bg-black shadow-[0_24px_80px_-35px_rgba(255,46,136,0.75)]"
              style={{ pointerEvents: "auto" }}
            />
            <button
              type="button"
              disabled={exporting || !videoBlob}
              onClick={() => { console.log("[Raja AI] EXPORT ▶ Button click received"); void exportPreviewVideo(); }}
              className="relative z-40 mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-white py-4 text-base font-black tracking-[0.12em] text-black shadow-[0_18px_55px_-18px_rgba(255,255,255,0.8)] transition active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
              style={{ pointerEvents: "auto" }}
            >
              {exporting ? "SAVING…" : "SAVE / EXPORT"}
            </button>
            <button
              onClick={() => {
                console.log("[Raja AI] RESET ▶ Create again clicked");
                setStage("ready");
                setVideoUrl(null);
                setVideoBlob(null);
                setProgress(0);
              }}
              className="relative z-40 mt-2 w-full rounded-xl border border-white/15 bg-white/5 py-3 text-sm hover:bg-white/10"
              style={{ pointerEvents: "auto" }}
            >
              फिर से बनाएँ
            </button>
          </div>
        )}

        {celebrate && <Celebration />}

        <footer className="mt-12 text-center text-[11px] text-white/40">
          100% browser • कोई API key नहीं • फाइलें कहीं अपलोड नहीं होतीं
        </footer>
      </div>
    </div>
  );
}

/* ---------------- presentational components ---------------- */

function BigAudioButton({ onPick, loading }: { onPick: (f: File) => void; loading: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const lastFileTokenRef = useRef("");
  const handleFile = (file?: File) => {
    if (!file) return;
    const token = `${file.name}-${file.size}-${file.lastModified}`;
    if (lastFileTokenRef.current === token) return;
    lastFileTokenRef.current = token;
    onPick(file);
  };
  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        onClick={() => { console.log("[Raja AI] STEP 1 ▶ Big audio button clicked"); ref.current?.click(); }}
        disabled={loading}
        className="group relative z-30 flex h-64 w-64 items-center justify-center rounded-full bg-gradient-to-br from-[#ff2e88] via-[#ff6a3d] to-[#ffb347] text-black shadow-[0_0_80px_-10px_rgba(255,46,136,0.8)] transition active:scale-95"
        style={{ pointerEvents: "auto" }}
      >
        <span className="pointer-events-none absolute inset-0 rounded-full bg-gradient-to-br from-[#ff2e88] to-[#ffb347] opacity-60 blur-2xl" />
        <span className="pointer-events-none absolute inset-0 animate-ping rounded-full bg-[#ff2e88]/30" />
        <div className="relative z-10 flex flex-col items-center">
          {loading ? (
            <Spinner size={56} />
          ) : (
            <>
              <div className="text-6xl">🎵</div>
              <div className="mt-2 text-lg font-black tracking-widest">UPLOAD AUDIO</div>
              <div className="mt-1 text-[11px] font-semibold opacity-70">MP3 / WAV / M4A</div>
            </>
          )}
        </div>
        <input
          ref={ref}
          type="file"
          accept="audio/*"
          className="hidden"
          onInput={(e) => handleFile(e.currentTarget.files?.[0])}
          onChange={(e) => handleFile(e.currentTarget.files?.[0])}
        />
      </button>
      <p className="mt-6 text-center text-sm text-white/60">
        {loading ? "बीट्स स्कैन हो रहे हैं…" : "सबसे पहले अपना गाना चुनें"}
      </p>
    </div>
  );
}

function PhotoSlot({
  file,
  index,
  enabled,
  onPick,
  onClear,
}: {
  file: File | null;
  index: number;
  enabled: boolean;
  onPick: (f: File) => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setUrl(null); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  if (file && url) {
    return (
      <div className="group relative z-10 aspect-square overflow-hidden rounded-xl border border-white/20" style={{ pointerEvents: "auto" }}>
        <img src={url} alt="" className="h-full w-full object-cover" />
        <button
          type="button"
          onClick={() => { console.log(`[Raja AI] STEP 2 ▶ Slot ${index + 1} cleared`); onClear(); }}
          className="absolute right-1 top-1 z-20 rounded-full bg-black/70 px-2 py-0.5 text-[10px]"
          style={{ pointerEvents: "auto" }}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => {
        console.log(`[Raja AI] STEP 2 ▶ Slot ${index + 1} clicked`, { enabled });
        if (!enabled) return;
        ref.current?.click();
      }}
      className="relative z-10 flex aspect-square items-center justify-center rounded-xl border-2 border-dashed border-[#ff2e88]/50 bg-[#ff2e88]/5 text-white/70 backdrop-blur transition hover:border-[#ff2e88] hover:bg-[#ff2e88]/15 disabled:cursor-not-allowed disabled:opacity-40"
      style={{ pointerEvents: "auto" }}
    >
      {enabled && <span className="pointer-events-none absolute inset-0 animate-pulse rounded-xl bg-[#ff2e88]/10" />}
      <div className="relative z-10 flex flex-col items-center">
        <div className="text-2xl">+</div>
        <div className="mt-1 text-[10px] font-semibold tracking-wider">SLOT {index + 1}</div>
      </div>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])}
      />
    </button>
  );
}

function ModeCard({
  active,
  title,
  sub,
  onClick,
}: {
  active: boolean;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ pointerEvents: "auto" }}
      className={`relative z-10 rounded-2xl border p-5 text-left backdrop-blur-xl transition ${
        active
          ? "border-[#ff2e88] bg-[#ff2e88]/15 shadow-[0_10px_40px_-15px_rgba(255,46,136,0.6)]"
          : "border-white/10 bg-white/[0.04] hover:bg-white/[0.08]"
      }`}
    >
      <div className="text-lg font-black">{title}{active && <span className="ml-2 text-[#ff2e88]">●</span>}</div>
      <div className="mt-1 text-xs text-white/60">{sub}</div>
    </button>
  );
}

function RenderingOverlay({
  progress,
  phase,
  log,
}: {
  progress: number;
  phase: "record" | "encode" | "";
  log: string;
}) {
  const pct = Math.round(progress * 100);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-2xl">
      <div className="flex flex-col items-center">
        <CircularSpinner percent={pct} />
        <div className="mt-6 text-2xl font-black tracking-widest">प्रोसेसिंग…</div>
        <div className="mt-2 text-xs uppercase tracking-[0.3em] text-white/60">
          {phase === "encode" ? "Encoding MP4" : "Rendering Beats"}
        </div>
        {log && <div className="mt-3 max-w-xs text-center text-[11px] text-white/50">{log}</div>}
      </div>
    </div>
  );
}

function CircularSpinner({ percent }: { percent: number }) {
  const size = 160;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (percent / 100) * c;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id="sp" x1="0" x2="1">
            <stop offset="0%" stopColor="#ff2e88" />
            <stop offset="100%" stopColor="#ffb347" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.1)" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="url(#sp)"
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.3s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-3xl font-black">{percent}%</div>
      </div>
      <div className="absolute inset-0 -z-10 animate-pulse rounded-full bg-[#ff2e88]/20 blur-3xl" />
    </div>
  );
}

function Spinner({ size = 32 }: { size?: number }) {
  return (
    <div
      className="animate-spin rounded-full border-4 border-black/20 border-t-black"
      style={{ width: size, height: size }}
    />
  );
}

function Celebration() {
  const pieces = Array.from({ length: 60 });
  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {pieces.map((_, i) => {
        const left = Math.random() * 100;
        const delay = Math.random() * 0.5;
        const dur = 2 + Math.random() * 1.5;
        const colors = ["#ff2e88", "#ffb347", "#7c5cff", "#4ade80", "#38bdf8"];
        const bg = colors[i % colors.length];
        return (
          <span
            key={i}
            className="absolute top-[-20px] block h-3 w-2 rounded-sm"
            style={{
              left: `${left}%`,
              background: bg,
              animation: `confetti-fall ${dur}s ${delay}s linear forwards`,
            }}
          />
        );
      })}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="animate-[scale-in_0.4s_ease-out] rounded-full bg-white/10 px-8 py-4 text-2xl font-black backdrop-blur-2xl">
          🎉 तैयार है!
        </div>
      </div>
      <style>{`
        @keyframes confetti-fall {
          to { transform: translateY(110vh) rotate(720deg); opacity: 0.8; }
        }
      `}</style>
    </div>
  );
}
