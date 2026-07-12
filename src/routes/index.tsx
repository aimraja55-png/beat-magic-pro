import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import fixWebmDuration from "fix-webm-duration";
import { Progress } from "@/components/ui/progress";

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

function Index() { return <Editor />; }

/* ---------------- types ---------------- */
type Beats = {
  times: number[];
  kicks: number[];
  claps: number[];
  hats: number[];
  kickEnv: Float32Array;
  clapEnv: Float32Array;
  hatEnv: Float32Array;
  hop: number;
  bpm: number;
  duration: number;
};
type Stage = "idle" | "analyzing" | "ready" | "ad" | "rendering" | "done";
type QualityKey = "480p" | "720p" | "1080p" | "4k";
type QualityCfg = { label: QualityKey; wShort: number; hShort: number; wLong: number; hLong: number; bitrate: number; fps: number };
const QUALITIES: Record<QualityKey, QualityCfg> = {
  "480p": { label: "480p", wShort: 480,  hShort: 854,  wLong: 854,  hLong: 480,  bitrate: 2_500_000, fps: 30 },
  "720p": { label: "720p", wShort: 720,  hShort: 1280, wLong: 1280, hLong: 720,  bitrate: 5_000_000, fps: 30 },
  "1080p":{ label: "1080p",wShort: 1080, hShort: 1920, wLong: 1920, hLong: 1080, bitrate: 9_000_000, fps: 60 },
  "4k":   { label: "4k",   wShort: 2160, hShort: 3840, wLong: 3840, hLong: 2160, bitrate: 20_000_000, fps: 60 },
};
type SavePickerHandle = {
  queryPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
  createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void>; abort?: () => Promise<void>; }>;
};
type SavePickerWindow = Window & typeof globalThis & {
  showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[]; }) => Promise<SavePickerHandle>;
};

/* ---------------- Business logic ---------------- */
const UPI_ID = "9263334055-4@ybl";
const PRO_PRICE = 99;
const UPI_LINK = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent("Raja AI Pro")}&am=${PRO_PRICE}&cu=INR&tn=${encodeURIComponent("Raja AI Pro Subscription")}`;
const FREE_DAILY = 10;
const LONG_MAX_SEC = 60;
const AD_SECONDS = 30;

function todayKey() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; }
function isPro(): boolean {
  try {
    const raw = localStorage.getItem("raja_pro_until");
    if (!raw) return false;
    return Date.now() < parseInt(raw, 10);
  } catch { return false; }
}
function activatePro(days = 30) {
  try { localStorage.setItem("raja_pro_until", String(Date.now() + days * 86400000)); } catch { /* ignore */ }
}
function getUsageToday(): number {
  try {
    const raw = localStorage.getItem("raja_usage");
    if (!raw) return 0;
    const obj = JSON.parse(raw);
    return obj.date === todayKey() ? (obj.count || 0) : 0;
  } catch { return 0; }
}
function bumpUsage() {
  try { localStorage.setItem("raja_usage", JSON.stringify({ date: todayKey(), count: getUsageToday() + 1 })); } catch { /* ignore */ }
}
function dailyLimit() { return isPro() ? Infinity : FREE_DAILY; }
function popupShownToday(): boolean {
  try { return localStorage.getItem("raja_popup_date") === todayKey(); } catch { return false; }
}
function markPopupShown() {
  try { localStorage.setItem("raja_popup_date", todayKey()); } catch { /* ignore */ }
}
function sessionKey(f: File) { return `raja_session_${f.name}_${f.size}`; }
function getSessionOffset(f: File): number {
  try { return parseFloat(localStorage.getItem(sessionKey(f)) || "0") || 0; } catch { return 0; }
}
function saveSessionOffset(f: File, seconds: number) {
  try { localStorage.setItem(sessionKey(f), String(seconds)); } catch { /* ignore */ }
}
function clearSessionOffset(f: File) {
  try { localStorage.removeItem(sessionKey(f)); } catch { /* ignore */ }
}
function audioMemoryKey(f: File) { return `raja_stylemem_${f.name}_${f.size}`; }
function getUsedStyles(f: File): string[] {
  try { return JSON.parse(localStorage.getItem(audioMemoryKey(f)) || "[]"); } catch { return []; }
}
function pushUsedStyles(f: File, tokens: string[]) {
  try {
    const prev = getUsedStyles(f);
    const merged = Array.from(new Set([...prev, ...tokens]));
    // cap memory so we never run out of variety
    const capped = merged.slice(-40);
    localStorage.setItem(audioMemoryKey(f), JSON.stringify(capped));
  } catch { /* ignore */ }
}
function classifyIntensity(kickEnv: Float32Array): "chill" | "normal" | "aggressive" {
  if (kickEnv.length === 0) return "normal";
  let sum = 0, hits = 0;
  for (let i = 0; i < kickEnv.length; i++) { sum += kickEnv[i]; if (kickEnv[i] > 0.55) hits++; }
  const mean = sum / kickEnv.length;
  const density = hits / kickEnv.length;
  if (mean < 0.18 && density < 0.03) return "chill";
  if (mean > 0.32 || density > 0.08) return "aggressive";
  return "normal";
}

/* ---------------- Beat detection ---------------- */
async function renderBand(audio: AudioBuffer, type: BiquadFilterType, frequency: number, Q: number): Promise<Float32Array> {
  const OfflineCtx = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const offline = new OfflineCtx(1, audio.length, audio.sampleRate);
  const src = offline.createBufferSource(); src.buffer = audio;
  const filter = offline.createBiquadFilter(); filter.type = type; filter.frequency.value = frequency; filter.Q.value = Q;
  src.connect(filter).connect(offline.destination); src.start(0);
  const rendered = await offline.startRendering();
  const ch0 = rendered.getChannelData(0);
  if (rendered.numberOfChannels === 1) return ch0.slice();
  const ch1 = rendered.getChannelData(1);
  const out = new Float32Array(ch0.length);
  for (let i = 0; i < ch0.length; i++) out[i] = (ch0[i] + ch1[i]) * 0.5;
  return out;
}
function envelopeOf(samples: Float32Array, sr: number, hopSec: number): Float32Array {
  const hop = Math.max(1, Math.floor(sr * hopSec)); const win = hop * 2;
  const frames = Math.max(0, Math.floor((samples.length - win) / hop));
  const env = new Float32Array(frames); let max = 1e-6;
  for (let f = 0; f < frames; f++) {
    const start = f * hop; let s = 0;
    for (let j = 0; j < win; j++) { const v = samples[start + j]; s += v * v; }
    const r = Math.sqrt(s / win); env[f] = r; if (r > max) max = r;
  }
  for (let f = 0; f < frames; f++) env[f] = env[f] / max;
  return env;
}
function pickPeaks(env: Float32Array, hopSec: number, { windowFrames, ratio, minGapSec, floor }: { windowFrames: number; ratio: number; minGapSec: number; floor: number; }): number[] {
  const peaks: number[] = [];
  const minGapFrames = Math.max(1, Math.floor(minGapSec / hopSec));
  let lastPeak = -Infinity;
  for (let i = windowFrames; i < env.length - windowFrames; i++) {
    let mean = 0;
    for (let k = i - windowFrames; k <= i + windowFrames; k++) mean += env[k];
    mean /= windowFrames * 2 + 1;
    const v = env[i];
    if (v > floor && v > mean * ratio && v > env[i - 1] && v >= env[i + 1] && i - lastPeak >= minGapFrames) {
      peaks.push(i * hopSec); lastPeak = i;
    }
  }
  return peaks;
}
async function analyzeBeats(file: File): Promise<Beats> {
  const arr = await file.arrayBuffer();
  const ac = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const audio = await ac.decodeAudioData(arr.slice(0));
  ac.close();
  const sr = audio.sampleRate; const hopSec = 0.01;
  const [lowBuf, midBuf, hatBuf, fullBuf] = await Promise.all([
    renderBand(audio, "lowpass", 120, 0.9),
    renderBand(audio, "bandpass", 2200, 0.9),
    renderBand(audio, "highpass", 8000, 0.9),
    renderBand(audio, "allpass", 1000, 0.7),
  ]);
  const kickEnv = envelopeOf(lowBuf, sr, hopSec);
  const clapEnv = envelopeOf(midBuf, sr, hopSec);
  const hatEnv  = envelopeOf(hatBuf, sr, hopSec);
  const fullEnv = envelopeOf(fullBuf, sr, hopSec);
  const kicks = pickPeaks(kickEnv, hopSec, { windowFrames: 30, ratio: 1.35, minGapSec: 0.14, floor: 0.18 });
  const claps = pickPeaks(clapEnv, hopSec, { windowFrames: 22, ratio: 1.4,  minGapSec: 0.10, floor: 0.15 });
  const hats  = pickPeaks(hatEnv,  hopSec, { windowFrames: 14, ratio: 1.45, minGapSec: 0.06, floor: 0.12 });
  let times   = pickPeaks(fullEnv, hopSec, { windowFrames: 25, ratio: 1.35, minGapSec: 0.16, floor: 0.15 });
  if (kicks.length >= 8) times = kicks.slice();
  const diffs = times.slice(1).map((b, i) => b - times[i]).sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)] || 0.5;
  const bpm = Math.round(60 / median);
  return { times, kicks: kicks.length >= 4 ? kicks : times, claps, hats, kickEnv, clapEnv, hatEnv, hop: hopSec, bpm, duration: audio.duration };
}

/* ---------------- Save helpers ---------------- */
async function requestOutputFileHandle(filename: string, mime: string, ext: string): Promise<SavePickerHandle | null> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (!picker) return null;
  try {
    const handle = await picker({
      suggestedName: filename,
      types: [{ description: ext.toUpperCase() + " Video", accept: { [mime]: [`.${ext}`] } }],
    });
    let permission: PermissionState = "granted";
    if (handle.queryPermission) permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted" && handle.requestPermission) permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") return null;
    return handle;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) console.warn("[Raja AI] File System failed", error);
    return null;
  }
}
async function saveWithFileHandle(handle: SavePickerHandle, blob: Blob) {
  const writable = await handle.createWritable();
  try { await writable.write(blob); await writable.close(); }
  catch (error) { await writable.abort?.(); throw error; }
}
function autoDownload(url: string, filename: string) {
  const a = document.createElement("a"); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}
function waitForNextPaint() { return new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); }
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
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "";
}

/* ---------------- Cinematic Effects ---------------- */
type StylePack = {
  base: "kenburns" | "punchIn" | "punchOut" | "orbit" | "tiltShake" | "whipPan" | "dolly" | "handheld" | "parallax3D" | "spiralZoom" | "dutchAngle" | "smoothPan" | "layerPeel3D" | "liquidWarp" | "photoMerge";
  entry: "slideL" | "slideR" | "slideU" | "slideD" | "irisIn" | "zoomIn" | "blurIn" | "spinIn" | "glitchIn" | "chromaIn" | "fadeIn" | "liquidIn" | "shatterIn";
  exit:  "slideL" | "slideR" | "slideU" | "slideD" | "irisOut" | "zoomOut" | "blurOut" | "fadeOut" | "liquidOut" | "none";
  filter: "none" | "warm" | "cool" | "noir" | "sepia" | "tealOrange" | "bleach" | "neon" | "vhs";
  panX: number; panY: number; rotDir: number; seed: number;
};
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pickStylePack(seed: number, recent: StylePack[] = [], banned: Set<string> = new Set(), intensity: "chill" | "normal" | "aggressive" = "normal"): StylePack {
  const rand = mulberry32(seed);
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
  const allBases = ["punchIn","punchOut","orbit","tiltShake","whipPan","dolly","handheld","spiralZoom","dutchAngle"] as const;
  const allEntries = ["slideL","slideR","slideU","slideD","zoomIn","spinIn","glitchIn","shatterIn"] as const;
  const allExits = ["slideL","slideR","slideU","slideD","zoomOut","none"] as const;
  const bases = allBases;
  const entries = allEntries;
  const exits = allExits;
  const filters = ["none","none","cool","warm"] as const;
  const recentBases = new Set(recent.slice(-4).map(s => s.base));
  const recentEntries = new Set(recent.slice(-4).map(s => s.entry));
  const recentExits = new Set(recent.slice(-4).map(s => s.exit));
  const pickUnique = <T,>(arr: readonly T[], used: Set<T>): T => {
    const avail = arr.filter(a => !used.has(a) && !banned.has(String(a)));
    const pool = avail.length ? avail : arr;
    return pool[Math.floor(rand() * pool.length)];
  };
  const base = pickUnique(bases, recentBases);
  const entry = pickUnique(entries, recentEntries);
  const exit = pickUnique(exits, recentExits);
  return { base, entry, exit, filter: pick(filters), panX: rand() * 2 - 1, panY: rand() * 2 - 1, rotDir: rand() > 0.5 ? 1 : -1, seed };
}
const EASE = (x: number) => 1 - Math.pow(1 - x, 3);

function drawFrame(
  ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, W: number, H: number,
  style: StylePack, progress: number, punch: number, flash: number, shimmer: number,
) {
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
  let filter = "";
  if (style.filter === "warm") filter = "saturate(1.15) hue-rotate(-10deg) contrast(1.08)";
  else if (style.filter === "cool") filter = "saturate(1.1) hue-rotate(12deg) contrast(1.05)";
  else if (style.filter === "noir") filter = "grayscale(0.85) contrast(1.25) brightness(0.95)";
  else if (style.filter === "sepia") filter = "sepia(0.55) contrast(1.1)";
  else if (style.filter === "tealOrange") filter = "saturate(1.25) hue-rotate(-6deg) contrast(1.15)";
  else if (style.filter === "bleach") filter = "saturate(0.55) contrast(1.25) brightness(1.05)";
  else if (style.filter === "neon") filter = "saturate(1.5) contrast(1.2) hue-rotate(6deg)";
  else if (style.filter === "vhs") filter = "saturate(1.2) contrast(1.1) hue-rotate(-4deg) brightness(1.02)";

  const baseScale = Math.max(W / img.width, H / img.height);
  let scale = baseScale; let dx = 0, dy = 0, rot = 0;
  const eased = EASE(progress);

  switch (style.base) {
    case "kenburns":
      scale *= 1.05 + 0.12 * eased + 0.18 * punch;
      dx = style.panX * 60 * eased; dy = style.panY * 40 * eased; break;
    case "punchIn": scale *= 1 + 0.25 * eased + 0.28 * punch; break;
    case "punchOut": scale *= 1.3 - 0.25 * eased + 0.2 * punch; break;
    case "orbit":
      scale *= 1.08 + 0.1 * punch;
      rot = style.rotDir * 0.08 * (eased - 0.5);
      dx = Math.sin(progress * Math.PI) * 40 * style.panX; break;
    case "tiltShake": {
      scale *= 1.03 + 0.18 * punch;
      rot = style.rotDir * (0.02 + 0.05 * punch);
      const amp = punch > 0.35 ? 45 * (punch - 0.3) : 0;
      dx = (Math.random() - 0.5) * amp; dy = (Math.random() - 0.5) * amp; break;
    }
    case "whipPan": scale *= 1.05; dx = (progress - 0.5) * W * 0.6 * style.rotDir; break;
    case "dolly": scale *= 1 + 0.35 * eased + 0.25 * punch; dy = -eased * 30; break;
    case "handheld": {
      scale *= 1.04 + 0.14 * punch;
      const t = progress * Math.PI * 4;
      const jitter = punch > 0.35 ? 24 * (punch - 0.3) : 0;
      dx = Math.sin(t + style.seed) * 8 + (Math.random() - 0.5) * jitter;
      dy = Math.cos(t * 0.9) * 6 + (Math.random() - 0.5) * jitter;
      rot = Math.sin(t * 0.4) * 0.015; break;
    }
    case "parallax3D": {
      scale *= 1.1 + 0.08 * eased + 0.15 * punch;
      const t = progress * Math.PI * 2;
      dx = Math.sin(t) * 55 * style.panX;
      dy = Math.cos(t * 0.7) * 30 * style.panY;
      rot = style.rotDir * 0.03 * Math.sin(t); break;
    }
    case "spiralZoom": {
      scale *= 1 + 0.28 * eased + 0.2 * punch;
      const t = progress * Math.PI * 2;
      rot = style.rotDir * eased * 0.25;
      dx = Math.sin(t) * 20; dy = Math.cos(t) * 20; break;
    }
    case "dutchAngle": {
      scale *= 1.08 + 0.12 * eased + 0.18 * punch;
      rot = style.rotDir * (0.05 + 0.03 * eased);
      dx = style.panX * 40 * eased; break;
    }
    case "smoothPan": {
      // Calm ease-in-out pan for soft passages — no shake, no bass amplification
      scale *= 1.04 + 0.08 * eased;
      dx = style.panX * 80 * eased; dy = style.panY * 50 * eased; break;
    }
    case "layerPeel3D": {
      // Fake 3D: perspective-like x-skew via horizontal squeeze + rotate
      scale *= 1.08 + 0.1 * eased + 0.15 * punch;
      rot = style.rotDir * (0.02 + 0.06 * eased);
      dx = style.panX * 90 * (0.5 - Math.abs(0.5 - eased)); break;
    }
    case "liquidWarp": {
      // Gentle sinusoidal drift — feels like liquid
      scale *= 1.06 + 0.06 * eased + 0.12 * punch;
      const t = progress * Math.PI * 2;
      dx = Math.sin(t + style.seed * 0.01) * 35;
      dy = Math.cos(t * 0.6 + style.seed * 0.01) * 22;
      rot = Math.sin(t * 0.5) * 0.02 * style.rotDir; break;
    }
    case "photoMerge": {
      // Base draw is smooth; overlay effect done later as picture-in-picture
      scale *= 1.05 + 0.1 * eased + 0.12 * punch;
      dx = style.panX * 30 * eased; dy = style.panY * 20 * eased; break;
    }
  }
  if (punch > 0.55 && style.base !== "smoothPan") {
    const amp = 20 * (punch - 0.5);
    dx += (Math.random() - 0.5) * amp; dy += (Math.random() - 0.5) * amp;
  }
  let entryAlpha = 1;
  if (progress < 0.25) {
    const p = progress / 0.25; const inv = 1 - EASE(p); entryAlpha = EASE(p);
    switch (style.entry) {
      case "slideL": dx -= W * 0.6 * inv; break;
      case "slideR": dx += W * 0.6 * inv; break;
      case "slideU": dy -= H * 0.6 * inv; break;
      case "slideD": dy += H * 0.6 * inv; break;
      case "zoomIn": scale *= 0.6 + 0.4 * EASE(p); break;
      case "spinIn": rot += inv * 0.8 * style.rotDir; scale *= 0.6 + 0.4 * EASE(p); break;
      case "irisIn": break;
      case "glitchIn": dx += (Math.random() - 0.5) * 40 * inv; dy += (Math.random() - 0.5) * 20 * inv; break;
      case "shatterIn": {
        const jitter = inv * 60;
        dx += (Math.sin(style.seed) * 0.5 + 0.5 - 0.5) * jitter;
        dy += (Math.cos(style.seed * 1.3) * 0.5 + 0.5 - 0.5) * jitter;
        rot += inv * 0.12 * style.rotDir; break;
      }
    }
  }
  if (progress > 0.8 && style.exit !== "none") {
    const p = (progress - 0.8) / 0.2; const e = EASE(p);
    switch (style.exit) {
      case "slideL": dx -= W * 0.5 * e; break;
      case "slideR": dx += W * 0.5 * e; break;
      case "slideU": dy -= H * 0.5 * e; break;
      case "slideD": dy += H * 0.5 * e; break;
      case "zoomOut": scale *= 1 + 0.35 * e; entryAlpha *= 1 - e * 0.6; break;
      case "none": break;
    }
  }
  const dw = img.width * scale; const dh = img.height * scale;
  ctx.save();
  ctx.filter = filter || "none";
  ctx.globalAlpha = entryAlpha;
  ctx.translate(W / 2 + dx, H / 2 + dy);
  if (rot) ctx.rotate(rot);
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
  ctx.filter = "none";
  ctx.globalAlpha = 1;
}

function drawWatermark(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const pad = Math.round(W * 0.02);
  const fontSize = Math.round(H * 0.028);
  ctx.save();
  ctx.font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = "bottom";
  const text = "Raja AI Pro-Editor";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(W - w - pad * 2.2, H - fontSize - pad * 1.6, w + pad * 1.4, fontSize + pad * 0.8);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText(text, W - w - pad * 1.5, H - pad * 0.7);
  ctx.restore();
}

/* ---------------- Editor ---------------- */
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
  const [videoMime, setVideoMime] = useState<string>("video/mp4");
  const [exporting, setExporting] = useState(false);
  const [mode, setMode] = useState<"shorts" | "long">("shorts");
  const [celebrate, setCelebrate] = useState(false);
  const [pro, setPro] = useState<boolean>(false);
  const [usage, setUsage] = useState<number>(0);
  const [showSubscribe, setShowSubscribe] = useState(false);
  const [showLimitReached, setShowLimitReached] = useState(false);
  const [sessionOffset, setSessionOffsetState] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryTargetSlot, setGalleryTargetSlot] = useState<number | null>(null);
  const [photoPool, setPhotoPool] = useState<File[]>([]);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [quality, setQuality] = useState<QualityKey>("1080p");

  const renderIdRef = useRef(0);

  const photosNeeded = beats ? Math.max(4, Math.ceil(beats.times.length / 2)) : 0;
  const filledCount = slots.filter(Boolean).length;
  const aspect: "9:16" | "16:9" = mode === "shorts" ? "9:16" : "16:9";
  const remainingToday = Math.max(0, dailyLimit() - usage);
  const exactDurationSec = beats
    ? (mode === "long" ? Math.min(LONG_MAX_SEC, beats.duration - sessionOffset) : beats.duration)
    : 0;

  useEffect(() => {
    setPro(isPro());
    setUsage(getUsageToday());
    if (!isPro() && !popupShownToday()) {
      const t = setTimeout(() => { setShowSubscribe(true); markPopupShown(); }, 60_000);
      return () => clearTimeout(t);
    }
  }, []);

  useEffect(() => {
    if (audioFile) setSessionOffsetState(getSessionOffset(audioFile));
  }, [audioFile]);

  async function onAudio(f: File) {
    setAudioFile(f);
    setStage("analyzing");
    setLog("ऑडियो स्कैन हो रहा है…");
    try {
      const b = await analyzeBeats(f);
      setBeats(b);
      const need = Math.max(4, Math.ceil(b.times.length / 2));
      setSlots(new Array(need).fill(null));
      setStage("ready");
      setLog(`✓ ${b.duration.toFixed(1)}s • ~${b.bpm} BPM • ${b.times.length} beats`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStage("idle");
      setLog("ऑडियो डिकोड नहीं हो सका: " + msg);
    }
  }

  function firstEmptyIndex(): number { return slots.findIndex((s) => s === null); }

  function fillSlot(idx: number, file: File) {
    setSlots((s) => { const n = [...s]; n[idx] = file; return n; });
  }

  function fillManySlots(files: File[]) {
    setSlots((s) => {
      const n = [...s];
      let fi = 0;
      for (let i = 0; i < n.length && fi < files.length; i++) {
        if (n[i] === null) { n[i] = files[fi++]; }
      }
      return n;
    });
  }

  function clearSlot(idx: number) {
    setSlots((s) => { const n = [...s]; n[idx] = null; return n; });
  }

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  async function exportPreviewVideo() {
    if (!videoBlob || !videoUrl) return;
    setExporting(true);
    const ext = videoMime.includes("webm") ? "webm" : "mp4";
    const filename = `raja-ai-video.${ext}`;
    try {
      const handle = await requestOutputFileHandle(filename, videoMime, ext);
      if (handle) {
        await saveWithFileHandle(handle, videoBlob);
        setLog("✓ Export complete — file saved.");
      } else {
        autoDownload(videoUrl, filename);
        setLog("✓ Export started. देखें अपने Downloads में।");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog(`Export error: ${msg}`);
    } finally { setExporting(false); }
  }

  async function tryGenerate() {
    if (!audioFile || !beats || filledCount === 0) return;
    // Daily limit gate
    const u = getUsageToday();
    setUsage(u);
    if (u >= dailyLimit()) {
      setLog(`⛔ आज की सीमा (${dailyLimit()} videos) पूरी हो गई.`);
      if (!pro) setShowLimitReached(true);
      return;
    }
    // Show quality picker with exact duration; render begins after confirm
    setQualityOpen(true);
  }

  function confirmQuality(q: QualityKey) {
    setQuality(q);
    setQualityOpen(false);
    void doRender();
  }

  async function doRender() {
    if (!audioFile || !beats) return;
    const photos = slots.filter(Boolean) as File[];
    if (photos.length === 0) return;

    const myId = ++renderIdRef.current;
    setStage("rendering");
    setProgress(0.01);
    setPhase("record");
    setVideoUrl(null); setVideoBlob(null); setCelebrate(false);
    setLog("1% — तेज़ रेंडरिंग स्टार्ट हो रही है…");
    await waitForNextPaint();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Adaptive: user-chosen quality, downgraded on low-end devices to avoid Aw-Snap
    const nav = navigator as Navigator & { deviceMemory?: number };
    const cores = nav.hardwareConcurrency ?? 4;
    const mem = nav.deviceMemory ?? 4;
    const lowEnd = cores < 4 || mem < 4;
    let cfg = QUALITIES[quality];
    if (lowEnd && (quality === "1080p" || quality === "4k")) cfg = QUALITIES["720p"];
    if (lowEnd && quality === "4k") cfg = QUALITIES["720p"];
    const W = aspect === "9:16" ? cfg.wShort : cfg.wLong;
    const H = aspect === "9:16" ? cfg.hShort : cfg.hLong;
    const FPS = cfg.fps;
    const bitrate = cfg.bitrate;
    const drawWM = !pro; // watermark for free users

    // Long-video: cap segment to 60s, resume from session offset
    const startOffset = mode === "long" ? Math.min(sessionOffset, Math.max(0, beats.duration - 1)) : 0;
    const targetDuration = mode === "long"
      ? Math.min(LONG_MAX_SEC, beats.duration - startOffset)
      : beats.duration;

    const imageUrls: string[] = [];
    const bitmaps: ImageBitmap[] = [];
    try {
      // Pre-decode & downscale off the main thread (createImageBitmap) — saves RAM,
      // avoids main-thread decode hitches, and prevents Aw-Snap on cheap devices.
      setLog("Photos को प्रोसेस किया जा रहा है…");
      setProgress(0.08);
      await waitForNextPaint();

      const targetMax = Math.max(W, H) * 1.1;
      const resizeQuality = W >= 2160 ? "medium" : "high";
      const imgs: Array<CanvasImageSource & { width: number; height: number }> = [];
      setProgress(0.08);
      for (let idx = 0; idx < photos.length; idx++) {
        const f = photos[idx];
        setLog(`Photos को प्रीप्रोसेस किया जा रहा है… (${idx + 1}/${photos.length})`);
        setProgress(0.08 + ((idx + 1) / photos.length) * 0.08);
        await waitForNextPaint();
        try {
          const bmp = await createImageBitmap(f, {
            resizeWidth: targetMax,
            resizeHeight: targetMax,
            resizeQuality: resizeQuality as ImageBitmapResizeQuality,
          } as ImageBitmapOptions);
          bitmaps.push(bmp);
          imgs.push(bmp as unknown as CanvasImageSource & { width: number; height: number });
        } catch {
          const img = await new Promise<HTMLImageElement>((res, rej) => {
            const i = new Image();
            const u = URL.createObjectURL(f);
            imageUrls.push(u);
            i.onload = () => res(i);
            i.onerror = rej;
            i.src = u;
          });
          imgs.push(img as unknown as CanvasImageSource & { width: number; height: number });
        }
      }

      // ── DEEP-EMOTIONAL BEAT MAPPING ──
      // Classify the whole song first — dictates cut density + effect ferocity
      const intensity = classifyIntensity(beats.kickEnv);
      // Only cut on STRONG bass peaks. Weak thumps become smooth pans, not cuts.
      const bassPeakThreshold = intensity === "aggressive" ? 0.42 : intensity === "chill" ? 0.62 : 0.5;
      const strongKicks = (beats.kicks.length >= 4 ? beats.kicks : beats.times).filter((t) => {
        const idx = Math.min(beats.kickEnv.length - 1, Math.max(0, Math.floor(t / beats.hop)));
        return (beats.kickEnv[idx] ?? 0) >= bassPeakThreshold;
      });
      // Micro-cuts only when the song is genuinely energetic
      const microCuts = intensity === "chill" ? [] :
        beats.hats.filter((_, i) => i % (intensity === "aggressive" ? 3 : 5) === 0);
      const kickList = strongKicks.length >= 3 ? strongKicks : (beats.kicks.length >= 4 ? beats.kicks : beats.times);
      const mergedAll = [...kickList, ...microCuts]
        .filter((t) => t >= startOffset && t < startOffset + targetDuration)
        .map((t) => t - startOffset)
        .sort((a, b) => a - b);
      const cutTimes: number[] = [0];
      // Minimum photo hold time — chill songs get longer, aggressive shorter
      const minHold = intensity === "chill" ? 1.4 : intensity === "aggressive" ? 0.28 : 0.55;
      for (const t of mergedAll) {
        if (t - cutTimes[cutTimes.length - 1] > minHold) cutTimes.push(t);
      }
      // Ensure a final cut extends to the very end (fixes end-freeze)
      if (cutTimes[cutTimes.length - 1] < targetDuration - 0.1) cutTimes.push(targetDuration);

      const segments = cutTimes.length - 1;
      // Detect calm segments (low kick + low clap sustained → smooth pan, no jitter)
      const isCalmAt = (tAbs: number) => {
        const startIdx = Math.max(0, Math.floor((tAbs - 0.5) / beats.hop));
        const endIdx = Math.min(beats.kickEnv.length - 1, Math.floor((tAbs + 0.5) / beats.hop));
        let kSum = 0, cSum = 0, n = 0;
        for (let k = startIdx; k <= endIdx; k++) {
          kSum += beats.kickEnv[k] ?? 0;
          cSum += beats.clapEnv[k] ?? 0;
          n++;
        }
        if (n === 0) return false;
        return (kSum / n) < 0.18 && (cSum / n) < 0.18;
      };

      type DrawImg = CanvasImageSource & { width: number; height: number };
      const seq: { img: DrawImg; style: StylePack }[] = [];
      const recentStyles: StylePack[] = [];
      // Zero-repetition memory across renders for this same audio file
      const bannedStyles = new Set<string>(getUsedStyles(audioFile));
      const usedThisRun: string[] = [];
      for (let i = 0; i < segments; i++) {
        const cycle = Math.floor(i / imgs.length);
        const idx = cycle % 2 === 0 ? i % imgs.length : imgs.length - 1 - (i % imgs.length);
        // seed varies with time so re-renders never draw the same combos
        const seed = i * 9301 + 49297 + Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1e6);
        let style = pickStylePack(seed, recentStyles, bannedStyles, intensity);
        // Force smoothPan + fadeIn/fadeOut in calm passages
        const segMid = (cutTimes[i] + cutTimes[i + 1]) / 2 + startOffset;
        if (isCalmAt(segMid)) {
          const calmBases = ["smoothPan","kenburns","liquidWarp","parallax3D"] as const;
          const calmEntries = ["fadeIn","liquidIn","blurIn"] as const;
          const calmExits = ["fadeOut","liquidOut","blurOut"] as const;
          const r = mulberry32(seed);
          style = {
            ...style,
            base: calmBases[Math.floor(r() * calmBases.length)],
            entry: calmEntries[Math.floor(r() * calmEntries.length)],
            exit: calmExits[Math.floor(r() * calmExits.length)],
          };
        }
        seq.push({ img: imgs[idx], style });
        recentStyles.push(style);
        usedThisRun.push(style.base, style.entry, style.exit);
        if (recentStyles.length > 4) recentStyles.shift();
      }
      // Persist so the NEXT render of this song picks fresh effects
      pushUsedStyles(audioFile, usedThisRun);

      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d")!;

      setLog("Audio स्ट्रीम तैयार हो रही है…");
      setProgress(0.18);
      await waitForNextPaint();

      const audioUrl = URL.createObjectURL(audioFile);
      const audioEl = new Audio(audioUrl);
      audioEl.preload = "auto";
      audioEl.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const done = () => {
          if (settled) return; settled = true; cleanup(); resolve();
        };
        const fail = () => {
          if (settled) return; settled = true; cleanup(); reject(new Error("Audio load failed"));
        };
        const cleanup = () => {
          audioEl.onloadeddata = null;
          audioEl.oncanplay = null;
          audioEl.onerror = null;
        };
        audioEl.onloadeddata = done;
        audioEl.oncanplay = done;
        audioEl.onerror = fail;
      });
      setLog("Audio तैयार हो गया — render जल्दी शुरू हो रहा है…");
      setProgress(0.18);
      await waitForNextPaint();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const ac = new AudioContext();
      const src = ac.createMediaElementSource(audioEl);
      const dest = ac.createMediaStreamDestination();
      src.connect(dest);

      const stream = canvas.captureStream(FPS);
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

      const mime = getBestRecorderMime();
      const isMp4 = mime.startsWith("video/mp4");
      const rec = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        videoBitsPerSecond: bitrate,
        audioBitsPerSecond: 192_000,
      });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const outMime = isMp4 ? "video/mp4" : "video/webm";
      const recDone = new Promise<Blob>((r) => (rec.onstop = () => r(new Blob(chunks, { type: outMime }))));

      setLog("Recording और Beat-sync शुरू हो रहा है…");
      setProgress(0.26);
      await waitForNextPaint();

      const recordStart = performance.now();
      rec.start(250);
      await ac.resume();
      audioEl.currentTime = startOffset;
      await audioEl.play();

      let stop = false;
      let raf = 0;
      const render = () => {
        if (stop || renderIdRef.current !== myId) return;
        const abs = audioEl.currentTime;
        const t = abs - startOffset;
        if (t >= targetDuration) { stop = true; return; }
        let i = 0;
        while (i < cutTimes.length - 2 && cutTimes[i + 1] <= t) i++;
        const segStart = cutTimes[i]; const segEnd = cutTimes[i + 1];
        const segLen = Math.max(0.05, segEnd - segStart);
        const local = Math.min(1, Math.max(0, (t - segStart) / segLen));
        const envIdx = Math.min(beats.kickEnv.length - 1, Math.max(0, Math.floor(abs / beats.hop)));
        const punch = beats.kickEnv[envIdx] ?? 0;
        const flash = beats.clapEnv[envIdx] ?? 0;
        const shimmer = beats.hatEnv[envIdx] ?? 0;
        const item = seq[Math.min(i, seq.length - 1)];
        if (item) drawFrame(ctx, item.img, W, H, item.style, local, punch, flash, shimmer);
        if (drawWM) drawWatermark(ctx, W, H);
        setProgress(Math.min(0.95, (t / targetDuration) * 0.95));
        raf = requestAnimationFrame(render);
      };
      raf = requestAnimationFrame(render);

      // Stop exactly at target duration OR when audio ends
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (stop || audioEl.currentTime - startOffset >= targetDuration || audioEl.ended) {
            clearInterval(check); stop = true; resolve();
          }
        }, 50);
      });
      cancelAnimationFrame(raf);
      audioEl.pause();
      if (renderIdRef.current !== myId) return;

      const actualDuration = (performance.now() - recordStart) / 1000;
      await new Promise((r) => setTimeout(r, 200));
      rec.requestData();
      await new Promise((r) => setTimeout(r, 120));
      rec.stop();
      let out = await recDone;
      stream.getTracks().forEach((track) => track.stop());
      await ac.close();
      URL.revokeObjectURL(audioUrl);
      imageUrls.forEach((u) => URL.revokeObjectURL(u));
      bitmaps.forEach((b) => { try { b.close(); } catch { /* ignore */ } });
      if (renderIdRef.current !== myId) return;

      setPhase("encode");
      setProgress(0.97);
      setLog("मेटाडेटा फिक्स हो रहा है…");
      await waitForNextPaint();

      // Fix duration metadata (only for webm; MP4 usually has it)
      if (outMime === "video/webm") {
        try {
          out = await fixWebmDuration(out, actualDuration * 1000, { logger: false });
        } catch (err) { console.warn("[Raja AI] duration fix failed", err); }
      }

      if (out.size === 0) throw new Error("Empty output buffer");

      const url = URL.createObjectURL(out);
      setVideoBlob(out); setVideoUrl(url); setVideoMime(outMime);
      setProgress(1); setPhase("");
      setStage("done"); setCelebrate(true);
      setLog("✓ Preview तैयार है — Export बटन दबाएँ।");

      // Update usage + persistent session
      bumpUsage(); setUsage(getUsageToday());
      if (mode === "long") {
        const nextOffset = startOffset + targetDuration;
        if (nextOffset >= beats.duration - 0.5) clearSessionOffset(audioFile);
        else saveSessionOffset(audioFile, nextOffset);
        setSessionOffsetState(nextOffset >= beats.duration - 0.5 ? 0 : nextOffset);
      }
      setTimeout(() => setCelebrate(false), 3500);
    } catch (error) {
      if (renderIdRef.current !== myId) return;
      const msg = error instanceof Error ? error.message : String(error);
      setStage("ready"); setPhase(""); setProgress(0);
      setLog(`Error: ${msg}`);
    }
  }

  const audioReady = !!beats && stage !== "analyzing";
  const canGenerate = audioReady && filledCount >= 1 && stage !== "rendering";

  return (
    <div className="min-h-screen text-white" style={{
      background: "radial-gradient(1200px 800px at 20% -10%, #2a1457 0%, transparent 60%), radial-gradient(900px 700px at 110% 20%, #ff2e88 0%, transparent 55%), #0b0617",
    }}>
      <div className="relative z-10 mx-auto max-w-2xl px-5 py-10">
        <header className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[10px] tracking-[0.3em] uppercase backdrop-blur-xl">
            <span className="h-1.5 w-1.5 rounded-full bg-[#ff2e88]" />
            2026 • {pro ? "PRO" : "FREE"} • {remainingToday}/{dailyLimit()} left
          </div>
          <h1 className="mt-4 text-4xl font-black leading-tight md:text-5xl">
            Raja AI{" "}
            <span className="bg-gradient-to-r from-[#ff2e88] via-[#ffb347] to-[#7c5cff] bg-clip-text text-transparent">
              Pro-Editor
            </span>
          </h1>
        </header>

        {/* STEP 1: AUDIO */}
        {!audioFile && (
          <BigAudioButton onPick={onAudio} loading={stage === "analyzing"} />
        )}

        {audioFile && beats && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-xl">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">🎵 {audioFile.name}</div>
                <div className="mt-0.5 text-[11px] text-white/60">
                  {beats.duration.toFixed(1)}s • {beats.bpm} BPM • {beats.times.length} beats
                  {mode === "long" && sessionOffset > 0.5 && ` • Resume @ ${sessionOffset.toFixed(1)}s`}
                </div>
              </div>
              <label className="shrink-0 cursor-pointer rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10">
                बदलें
                <input type="file" accept="audio/*" className="hidden"
                  onChange={(e) => e.target.files?.[0] && onAudio(e.target.files[0])} />
              </label>
            </div>
          </div>
        )}

        {/* STEP 2: Click-to-Fill Photo System */}
        {beats && stage !== "rendering" && stage !== "done" && stage !== "ad" && (
          <div className="mt-6">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-wider text-white/80">
                📸 Step 2 — फोटो भरें ({filledCount}/{photosNeeded})
              </h2>
              <label className="cursor-pointer rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10">
                + Bulk fill
                <input type="file" accept="image/*" multiple className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []).filter(f => f.type.startsWith("image/"));
                    if (files.length) fillManySlots(files);
                    e.currentTarget.value = "";
                  }} />
              </label>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/30 p-3">
              <div className="mb-2 text-[10px] uppercase tracking-widest text-white/50">
                खाली स्लॉट पर टच करें — Gallery अपने आप खुलेगी
              </div>
              <div className="grid grid-cols-4 gap-2">
                {slots.map((f, i) => (
                  <SlotBox key={i} file={f} index={i} isNext={firstEmptyIndex() === i}
                    onOpenGallery={() => { setGalleryTargetSlot(i); setGalleryOpen(true); }}
                    onClear={() => clearSlot(i)} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* STEP 3: MODE */}
        {beats && filledCount >= 1 && stage !== "rendering" && stage !== "done" && stage !== "ad" && (
          <div className="mt-6">
            <h2 className="mb-3 text-sm font-semibold tracking-wider text-white/80">
              🎬 Step 3 — मोड चुनें
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <ModeCard active={mode === "shorts"} title="Shorts" sub="15–60s • 9:16"
                onClick={() => setMode("shorts")} />
              <ModeCard active={mode === "long"} title="Long Video"
                sub={`Max ${LONG_MAX_SEC}s • 16:9${beats.duration > LONG_MAX_SEC ? " • chunks" : ""}`}
                onClick={() => setMode("long")} />
            </div>
            {mode === "long" && beats.duration > LONG_MAX_SEC && (
              <p className="mt-2 text-center text-[11px] text-white/50">
                लंबा गाना — 60s chunks में render होगा, अगली बार आगे से शुरू होगा
              </p>
            )}
          </div>
        )}

        {/* STEP 4: GO */}
        {beats && stage !== "rendering" && stage !== "done" && stage !== "ad" && (
          <div className="mt-6">
            <button type="button" disabled={!canGenerate}
              onClick={() => void tryGenerate()}
              className="group relative block w-full overflow-hidden rounded-3xl bg-gradient-to-r from-[#ff2e88] via-[#ff6a3d] to-[#ffb347] py-7 text-2xl font-black tracking-[0.25em] text-black shadow-[0_20px_60px_-15px_rgba(255,46,136,0.7)] transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40">
              <span className="relative z-10">{canGenerate ? "GO ▶" : "GO (पहले फोटो भरें)"}</span>
              <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/40 to-transparent transition-transform duration-1000 group-hover:translate-x-full" />
            </button>
            {remainingToday === 0 && (
              <p className="mt-2 text-center text-[11px] text-red-300">
                आज की limit पूरी — कल फिर मिलेंगे या Pro बनें
              </p>
            )}
          </div>
        )}

        {/* Immediate render start; ad delay removed for faster UX */}

        {stage === "rendering" && (
          <RenderingOverlay progress={progress} phase={phase} log={log} />
        )}

        {stage === "done" && videoUrl && (
          <div className="mt-2 rounded-2xl border border-white/10 bg-white/[0.04] p-5 backdrop-blur-xl">
            <div className="mb-4 text-center">
              <div className="text-xs font-semibold uppercase tracking-[0.3em] text-white/50">Preview Ready</div>
              <h2 className="mt-2 text-2xl font-black">Video Preview</h2>
              <p className="mt-1 text-xs text-white/55">पहले देखें, फिर Export दबाएँ.</p>
            </div>
            <video src={videoUrl} controls autoPlay muted={false} playsInline preload="auto"
              controlsList="nodownload nofullscreen noremoteplayback"
              disablePictureInPicture
              onContextMenu={(e) => e.preventDefault()}
              className="w-full rounded-xl bg-black shadow-[0_24px_80px_-35px_rgba(255,46,136,0.75)]" />
            <button type="button" disabled={exporting || !videoBlob}
              onClick={() => void exportPreviewVideo()}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-white py-4 text-base font-black tracking-[0.12em] text-black shadow-[0_18px_55px_-18px_rgba(255,255,255,0.8)] transition active:scale-[0.98] disabled:cursor-wait disabled:opacity-60">
              {exporting ? "Exporting…" : "Export"}
            </button>
            <button onClick={() => { setStage("ready"); setVideoUrl(null); setVideoBlob(null); setProgress(0); }}
              className="mt-2 w-full rounded-xl border border-white/15 bg-white/5 py-3 text-sm hover:bg-white/10">
              फिर से बनाएँ
            </button>
          </div>
        )}

        {celebrate && <Celebration />}
        {showSubscribe && !pro && (
          <SubscribeModal onClose={() => setShowSubscribe(false)}
            onSubscribed={() => { activatePro(30); setPro(true); setShowSubscribe(false); }} />
        )}
        {showLimitReached && !pro && (
          <LimitReachedModal onClose={() => setShowLimitReached(false)}
            onSubscribed={() => { activatePro(30); setPro(true); setShowLimitReached(false); }} />
        )}

        {galleryOpen && (
          <GallerySheet
            pool={photoPool}
            slotsFilled={filledCount}
            slotsTotal={slots.length}
            onAddPhotos={(files) => setPhotoPool((p) => [...p, ...files])}
            onPickPhoto={(f) => {
              setSlots((prev) => {
                const next = [...prev];
                let target = galleryTargetSlot ?? next.findIndex((s) => s === null);
                if (target < 0) return prev;
                next[target] = f;
                const nextEmpty = next.findIndex((s) => s === null);
                setGalleryTargetSlot(nextEmpty >= 0 ? nextEmpty : null);
                return next;
              });
            }}
            onClose={() => { setGalleryOpen(false); setGalleryTargetSlot(null); }}
          />
        )}

        {qualityOpen && beats && (
          <QualityModal
            durationSec={exactDurationSec}
            current={quality}
            onCancel={() => setQualityOpen(false)}
            onConfirm={confirmQuality}
          />
        )}

        <InstallButton />

        <footer className="mt-12 text-center text-[11px] text-white/40">
          100% browser • कोई API key नहीं • {pro ? "PRO active" : `Free: ${remainingToday}/${dailyLimit()} today`}
        </footer>
      </div>
    </div>
  );
}

/* ---------------- Components ---------------- */

function BigAudioButton({ onPick, loading }: { onPick: (f: File) => void; loading: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col items-center">
      <button type="button" onClick={() => ref.current?.click()} disabled={loading}
        className="group relative flex h-64 w-64 items-center justify-center rounded-full bg-gradient-to-br from-[#ff2e88] via-[#ff6a3d] to-[#ffb347] text-black shadow-[0_0_80px_-10px_rgba(255,46,136,0.8)] transition active:scale-95">
        <span className="pointer-events-none absolute inset-0 rounded-full bg-gradient-to-br from-[#ff2e88] to-[#ffb347] opacity-60 blur-2xl" />
        <span className="pointer-events-none absolute inset-0 animate-ping rounded-full bg-[#ff2e88]/30" />
        <div className="relative z-10 flex flex-col items-center">
          {loading ? <Spinner size={56} /> : (<>
            <div className="text-6xl">🎵</div>
            <div className="mt-2 text-lg font-black tracking-widest">UPLOAD AUDIO</div>
            <div className="mt-1 text-[11px] font-semibold opacity-70">MP3 / WAV / M4A</div>
          </>)}
        </div>
        <input ref={ref} type="file" accept="audio/*" className="hidden"
          onChange={(e) => e.currentTarget.files?.[0] && onPick(e.currentTarget.files[0])} />
      </button>
      <p className="mt-6 text-center text-sm text-white/60">
        {loading ? "बीट्स स्कैन हो रहे हैं…" : "सबसे पहले अपना गाना चुनें"}
      </p>
    </div>
  );
}

function SlotBox({ file, index, isNext, onOpenGallery, onClear }: { file: File | null; index: number; isNext: boolean; onOpenGallery: () => void; onClear: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setUrl(null); return; }
    const u = URL.createObjectURL(file); setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (file && url) {
    return (
      <div className="group relative aspect-square overflow-hidden rounded-lg border-2 border-emerald-400/60 animate-scale-in">
        <img src={url} alt="" className="h-full w-full object-cover" />
        <button type="button" onClick={onClear}
          className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px]">✕</button>
        <div className="absolute bottom-0 left-0 right-0 bg-black/60 py-0.5 text-center text-[9px] font-bold">#{index + 1}</div>
      </div>
    );
  }
  return (
    <button type="button" onClick={onOpenGallery}
      className={`relative flex aspect-square items-center justify-center rounded-lg border-2 border-dashed text-white/60 transition active:scale-90 ${
        isNext ? "border-[#ff2e88] bg-[#ff2e88]/10 animate-pulse" : "border-white/20 bg-white/5 hover:border-white/40"
      }`}>
      <div className="text-[10px] font-bold tracking-widest">
        {isNext ? "◉ TAP" : `#${index + 1}`}
      </div>
    </button>
  );
}

function GallerySheet({ pool, slotsFilled, slotsTotal, onAddPhotos, onPickPhoto, onClose }: {
  pool: File[]; slotsFilled: number; slotsTotal: number;
  onAddPhotos: (files: File[]) => void; onPickPhoto: (f: File) => void; onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    const created: Record<string, string> = {};
    pool.forEach((f) => {
      const key = `${f.name}-${f.size}-${f.lastModified}`;
      if (!thumbs[key]) created[key] = URL.createObjectURL(f);
    });
    if (Object.keys(created).length) setThumbs((t) => ({ ...t, ...created }));
    return () => {
      // do not revoke here — the sheet may re-render often; revoke on unmount below
    };
     
  }, [pool]);
  useEffect(() => () => { Object.values(thumbs).forEach((u) => URL.revokeObjectURL(u)); }, []);
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/45 backdrop-blur-sm"
         onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="max-h-[62vh] rounded-t-3xl border-t border-white/10 bg-gradient-to-b from-slate-900 to-slate-950 shadow-[0_-30px_80px_-20px_rgba(255,46,136,0.4)]"
        style={{ animation: "slide-up 0.28s cubic-bezier(0.22,1,0.36,1)" }}>
        <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-white/25" />
        <div className="flex items-center justify-between px-5 pt-3">
          <div>
            <div className="text-sm font-black">📁 Photo Gallery</div>
            <div className="text-[10px] text-white/60">{slotsFilled}/{slotsTotal} slots filled • ऊपर स्लॉट देखते रहें</div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => inputRef.current?.click()}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-[11px] font-bold hover:bg-white/20">+ Add</button>
            <button onClick={onClose}
              className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/70 hover:bg-white/20">✕</button>
          </div>
          <input ref={inputRef} type="file" accept="image/*" multiple className="hidden"
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []).filter((f) => f.type.startsWith("image/"));
              if (files.length) onAddPhotos(files);
              e.currentTarget.value = "";
            }} />
        </div>
        {pool.length === 0 ? (
          <div className="p-6 pb-8 text-center">
            <div className="text-4xl">🖼️</div>
            <p className="mt-2 text-sm text-white/80">डिवाइस से फोटो चुनें</p>
            <button onClick={() => inputRef.current?.click()}
              className="mt-3 rounded-xl bg-gradient-to-r from-[#ff2e88] to-[#ffb347] px-5 py-2.5 text-sm font-black text-black">
              Gallery से लोड करें
            </button>
          </div>
        ) : (
          <div className="overflow-y-auto px-4 pb-6 pt-3" style={{ maxHeight: "50vh" }}>
            <div className="grid grid-cols-4 gap-2">
              {pool.map((f, i) => {
                const key = `${f.name}-${f.size}-${f.lastModified}`;
                const src = thumbs[key];
                return (
                  <button key={key + i} type="button" onClick={() => onPickPhoto(f)}
                    className="group relative aspect-square overflow-hidden rounded-lg border border-white/15 bg-black/40 transition active:scale-90 hover:border-[#ff2e88]">
                    {src && <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />}
                    <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <style>{`@keyframes slide-up { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>
      </div>
    </div>
  );
}

function QualityModal({ durationSec, current, onCancel, onConfirm }: {
  durationSec: number; current: QualityKey; onCancel: () => void; onConfirm: (q: QualityKey) => void;
}) {
  const [pick, setPick] = useState<QualityKey>(current);
  const secs = Math.max(1, Math.round(durationSec));
  const mm = Math.floor(secs / 60), ss = secs % 60;
  const dispDur = mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
  const opts: QualityKey[] = ["480p", "720p", "1080p", "4k"];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-2xl p-5" onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-3xl border border-[#ff2e88]/40 bg-gradient-to-br from-slate-900 to-slate-950 p-6 text-center shadow-[0_30px_100px_-20px_rgba(255,46,136,0.5)]">
        <div className="text-[10px] uppercase tracking-[0.3em] text-white/50">Export Gateway</div>
        <h2 className="mt-2 text-2xl font-black">Quality चुनें</h2>
        <div className="mt-3 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm">
          <span className="text-white/60">Video Duration: </span>
          <span className="font-black text-white">{dispDur}</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {opts.map((k) => (
            <button key={k} onClick={() => setPick(k)}
              className={`rounded-xl border p-3 text-left transition ${
                pick === k
                  ? "border-[#ff2e88] bg-[#ff2e88]/15"
                  : "border-white/10 bg-white/[0.04] hover:bg-white/[0.08]"
              }`}>
              <div className="text-sm font-black uppercase">{k}</div>
              <div className="text-[10px] text-white/50">
                {k === "480p" && "Fast • Low RAM"}
                {k === "720p" && "Balanced"}
                {k === "1080p" && "HD • Trending"}
                {k === "4k" && "Ultra • Long render"}
              </div>
            </button>
          ))}
        </div>
        <button onClick={() => onConfirm(pick)}
          className="mt-5 w-full rounded-xl bg-gradient-to-r from-[#ff2e88] to-[#ffb347] py-3 text-base font-black text-black active:scale-[0.98]">
          Render शुरू करें ({pick.toUpperCase()})
        </button>
        <button onClick={onCancel}
          className="mt-2 w-full text-[11px] text-white/50 hover:text-white/80">Cancel</button>
      </div>
    </div>
  );
}

function ModeCard({ active, title, sub, onClick }: { active: boolean; title: string; sub: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-2xl border p-5 text-left backdrop-blur-xl transition ${
        active ? "border-[#ff2e88] bg-[#ff2e88]/15 shadow-[0_10px_40px_-15px_rgba(255,46,136,0.6)]"
               : "border-white/10 bg-white/[0.04] hover:bg-white/[0.08]"
      }`}>
      <div className="text-lg font-black">{title}{active && <span className="ml-2 text-[#ff2e88]">●</span>}</div>
      <div className="mt-1 text-xs text-white/60">{sub}</div>
    </button>
  );
}

function AdCountdown({ seconds, onComplete, onSkip }: { seconds: number; onComplete: () => void; onSkip?: () => void }) {
  const [n, setN] = useState(seconds);
  useEffect(() => {
    if (n <= 0) { onComplete(); return; }
    const t = setTimeout(() => setN((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [n, onComplete]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-2xl">
      <div className="mx-5 max-w-sm rounded-2xl border border-white/10 bg-gradient-to-br from-slate-900 to-slate-800 p-6 text-center">
        <div className="text-[10px] uppercase tracking-widest text-white/50">Sponsored Break</div>
        <div className="my-4 flex h-40 items-center justify-center rounded-xl bg-gradient-to-br from-[#ff2e88]/30 to-[#7c5cff]/30 text-4xl">
          📺 विज्ञापन
        </div>
        <div className="text-3xl font-black">{n}s</div>
        <div className="mt-2 text-xs text-white/60">रेंडरिंग शुरू होगी — कृपया प्रतीक्षा करें</div>
        {onSkip && (
          <button onClick={onSkip} className="mt-4 rounded-lg bg-white/10 px-4 py-2 text-xs hover:bg-white/20">
            Skip (Pro)
          </button>
        )}
        <div className="mt-3 text-[10px] text-white/40">Pro बनें — कोई ad नहीं</div>
      </div>
    </div>
  );
}

function SubscribeModal({ onClose, onSubscribed }: { onClose: () => void; onSubscribed: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-2xl p-5">
      <div className="w-full max-w-sm rounded-3xl border border-[#ff2e88]/40 bg-gradient-to-br from-slate-900 via-purple-950 to-slate-900 p-6 text-center shadow-[0_30px_100px_-20px_rgba(255,46,136,0.6)]">
        <button onClick={onClose}
          className="absolute right-3 top-3 rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/70 hover:bg-white/20">✕</button>
        <div className="text-4xl">✨</div>
        <h2 className="mt-3 text-2xl font-black">अपने वीडियो को प्रोफेशनल बनाएं!</h2>
        <p className="mt-2 text-xs text-white/70">बिना वॉटरमार्क के शानदार वीडियो बनाएं और वायरल करें। अनलिमिटेड एक्सेस पाएं।</p>
        <div className="mt-2 text-4xl font-black">
          <span className="bg-gradient-to-r from-[#ff2e88] to-[#ffb347] bg-clip-text text-transparent">₹{PRO_PRICE}</span>
          <span className="text-base text-white/60"> /महीना</span>
        </div>
        <ul className="mt-4 space-y-1 text-left text-sm text-white/90">
          <li>✅ कोई वाटरमार्क नहीं</li>
          <li>✅ विज्ञापन-मुक्त अनुभव</li>
          <li>✅ अनलिमिटेड वीडियो रेंडरिंग</li>
        </ul>
        <div className="mt-4 rounded-xl border border-white/10 bg-black/40 p-3 text-xs">
          <div className="text-white/60">UPI ID</div>
          <div className="mt-1 font-mono text-base font-bold text-white">{UPI_ID}</div>
        </div>
        <a href={UPI_LINK}
          className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#ff2e88] to-[#ffb347] py-3 text-base font-black text-black">
          अभी Pro बनें (₹{PRO_PRICE}/महीना)
        </a>
        <button onClick={onSubscribed}
          className="mt-2 w-full rounded-xl border border-emerald-400/40 bg-emerald-400/10 py-2 text-xs font-bold text-emerald-200 hover:bg-emerald-400/20">
          भुगतान पूरा — Pro activate करें
        </button>
        <button onClick={onClose}
          className="mt-2 w-full text-[11px] text-white/40 hover:text-white/70">
          बाद में
        </button>
      </div>
    </div>
  );
}

function LimitReachedModal({ onClose, onSubscribed }: { onClose: () => void; onSubscribed: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-2xl p-5">
      <div className="relative w-full max-w-sm rounded-3xl border border-red-400/30 bg-gradient-to-br from-slate-900 via-red-950/40 to-slate-900 p-6 text-center shadow-[0_30px_100px_-20px_rgba(255,46,136,0.6)]">
        <button onClick={onClose}
          className="absolute right-3 top-3 rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/70 hover:bg-white/20">✕</button>
        <div className="text-4xl">⛔</div>
        <h2 className="mt-3 text-2xl font-black">आज की लिमिट खत्म!</h2>
        <div className="mt-4 flex items-center justify-center gap-4 text-3xl">
          <span title="Ads">📺</span>
          <span className="text-white/40">+</span>
          <span title="Watermark">💧</span>
        </div>
        <p className="mt-4 text-sm text-white/85">अनलिमिटेड वीडियो बनाने के लिए Pro बनें (₹{PRO_PRICE}/m)</p>
        <p className="mt-2 text-[11px] text-white/50">अगर अभी नहीं, तो कल फिर से 10 फ्री वीडियो क्रेडिट पाएं!</p>
        <div className="mt-4 rounded-xl border border-white/10 bg-black/40 p-3 text-xs">
          <div className="text-white/60">UPI ID</div>
          <div className="mt-1 font-mono text-base font-bold text-white">{UPI_ID}</div>
        </div>
        <a href={UPI_LINK}
          className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#ff2e88] to-[#ffb347] py-3 text-base font-black text-black">
          अभी Pro बनें (₹{PRO_PRICE}/महीना)
        </a>
        <button onClick={onSubscribed}
          className="mt-2 w-full rounded-xl border border-emerald-400/40 bg-emerald-400/10 py-2 text-xs font-bold text-emerald-200 hover:bg-emerald-400/20">
          भुगतान पूरा — Pro activate करें
        </button>
      </div>
    </div>
  );
}

function RenderingOverlay({ progress, phase, log }: { progress: number; phase: "record" | "encode" | ""; log: string }) {
  const pct = Math.max(1, Math.min(100, Math.round(progress * 100)));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4">
      <div className="w-full max-w-md rounded-[28px] border border-white/15 bg-white/5 p-6 text-center shadow-[0_24px_120px_-48px_rgba(59,130,246,0.4)] backdrop-blur-xl">
        <div className="text-xs font-black uppercase tracking-[0.4em] text-sky-100/70">PREMIUM RENDER</div>
        <div className="mt-4 text-3xl font-black tracking-tight text-white">{phase === "encode" ? "Exporting" : "Rendering"}</div>
        <div className="mt-2 text-sm uppercase tracking-[0.3em] text-slate-300">{phase === "encode" ? "Finalizing file" : "Sharp beat-sync action"}</div>
        <div className="mt-6">
          <RenderingProgress value={pct} />
        </div>
        <div className="mt-3 text-base font-black text-white">{pct}%</div>
        {log && <div className="mt-3 max-w-[22rem] mx-auto text-center text-[11px] text-slate-300">{log}</div>}
      </div>
    </div>
  );
}

function RenderingProgress({ value }: { value: number }) {
  return (
    <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/15">
      <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-white via-sky-300 to-blue-500 transition-all duration-300" style={{ width: `${value}%` }} />
      <div className="absolute inset-0 rounded-full border border-white/20" />
    </div>
  );
}

function Spinner({ size = 32 }: { size?: number }) {
  return <div className="animate-spin rounded-full border-4 border-black/20 border-t-black" style={{ width: size, height: size }} />;
}

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }>; };
function InstallButton() {
  const [evt, setEvt] = useState<BIPEvent | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const isStandalone = window.matchMedia?.("(display-mode: standalone)").matches ||
      (window.navigator as { standalone?: boolean }).standalone === true;
    if (isStandalone) { setHidden(true); return; }
    const onPrompt = (e: Event) => { e.preventDefault(); setEvt(e as BIPEvent); };
    const onInstalled = () => { setEvt(null); setHidden(true); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  if (hidden || !evt) return null;
  return (
    <button type="button" onClick={async () => {
      try { await evt.prompt(); const c = await evt.userChoice;
        if (c.outcome === "accepted") setHidden(true); setEvt(null);
      } catch (err) { console.warn(err); }
    }}
      className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-white/10 px-4 py-3 text-xs font-black uppercase tracking-widest text-white shadow-[0_10px_40px_-10px_rgba(255,46,136,0.7)] backdrop-blur-xl transition hover:bg-white/20">
      <span className="text-base">⬇</span> Install App
    </button>
  );
}

function Celebration() {
  const pieces = Array.from({ length: 60 });
  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {pieces.map((_, i) => {
        const left = Math.random() * 100; const delay = Math.random() * 0.5;
        const dur = 2 + Math.random() * 1.5;
        const colors = ["#ff2e88", "#ffb347", "#7c5cff", "#4ade80", "#38bdf8"];
        return <span key={i} className="absolute top-[-20px] block h-3 w-2 rounded-sm"
          style={{ left: `${left}%`, background: colors[i % colors.length],
            animation: `confetti-fall ${dur}s ${delay}s linear forwards` }} />;
      })}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="animate-[scale-in_0.4s_ease-out] rounded-full bg-white/10 px-8 py-4 text-2xl font-black backdrop-blur-2xl">🎉 तैयार है!</div>
      </div>
      <style>{`@keyframes confetti-fall { to { transform: translateY(110vh) rotate(720deg); opacity: 0.8; } }`}</style>
    </div>
  );
}
