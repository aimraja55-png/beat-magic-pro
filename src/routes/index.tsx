import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";

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
type Beats = { times: number[]; bpm: number; duration: number };
type Stage = "idle" | "analyzing" | "ready" | "rendering" | "done";

/* ---------------- Beat detection (Web Audio, energy-based onset) ---------------- */
async function analyzeBeats(file: File): Promise<Beats> {
  const arr = await file.arrayBuffer();
  const Ctx = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  // decode using a temp AudioContext first (broader format support)
  const ac = new (window.AudioContext || (window as any).webkitAudioContext)();
  const audio = await ac.decodeAudioData(arr.slice(0));
  ac.close();
  const data = audio.getChannelData(0);
  const sr = audio.sampleRate;
  const hop = Math.floor(sr * 0.02); // 20ms hop
  const win = hop * 2;
  const env: number[] = [];
  for (let i = 0; i + win < data.length; i += hop) {
    let s = 0;
    for (let j = 0; j < win; j++) s += data[i + j] * data[i + j];
    env.push(Math.sqrt(s / win));
  }
  // adaptive threshold peak picking
  const beats: number[] = [];
  const W = 20; // ~0.4s window
  for (let i = W; i < env.length - W; i++) {
    let mean = 0;
    for (let k = i - W; k <= i + W; k++) mean += env[k];
    mean /= W * 2 + 1;
    const v = env[i];
    if (v > mean * 1.45 && v > env[i - 1] && v >= env[i + 1] && v > 0.04) {
      const t = (i * hop) / sr;
      if (!beats.length || t - beats[beats.length - 1] > 0.22) beats.push(t);
    }
  }
  const duration = audio.duration;
  // estimate BPM from median inter-beat
  const diffs = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)] || 0.5;
  const bpm = Math.round(60 / median);
  return { times: beats, bpm, duration };
}

/* ---------------- ffmpeg.wasm loader (singleton) ---------------- */
let ffmpegPromise: Promise<any> | null = null;
async function getFFmpeg(onLog?: (m: string) => void) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const { toBlobURL } = await import("@ffmpeg/util");
      const ff = new FFmpeg();
      const base = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
      await ff.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ff;
    })();
  }
  const ff = await ffmpegPromise;
  if (onLog) ff.on("log", ({ message }: any) => onLog(message));
  return ff;
}

/* ---------------- Effects per beat ---------------- */
const EFFECTS = ["shake", "zoom", "glitch", "spin", "flash", "slide"] as const;
type Effect = (typeof EFFECTS)[number];

function drawFrame(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  W: number,
  H: number,
  effect: Effect,
  progress: number, // 0..1 within this beat segment
  punch: number, // 0..1 punch intensity right after beat
) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  ctx.save();

  // cover-fit base scale
  const baseScale = Math.max(W / img.width, H / img.height);
  let scale = baseScale * (1 + 0.06 * progress); // slow zoom drift
  let dx = 0, dy = 0, rot = 0;

  switch (effect) {
    case "shake": {
      const amp = 30 * punch;
      dx = (Math.random() - 0.5) * amp;
      dy = (Math.random() - 0.5) * amp;
      break;
    }
    case "zoom":
      scale *= 1 + 0.25 * punch;
      break;
    case "spin":
      rot = 0.18 * punch * (progress < 0.5 ? 1 : -1);
      scale *= 1 + 0.12 * punch;
      break;
    case "slide":
      dx = (1 - progress) * W * 0.4;
      break;
    case "flash":
    case "glitch":
      break;
  }

  ctx.translate(W / 2 + dx, H / 2 + dy);
  if (rot) ctx.rotate(rot);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();

  if (effect === "glitch" && punch > 0.2) {
    // RGB split
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.5 * punch;
    ctx.drawImage(img, -dw / 2 + 12, -dh / 2, dw, dh);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
  if (effect === "flash" && punch > 0.5) {
    ctx.fillStyle = `rgba(255,255,255,${(punch - 0.5) * 1.6})`;
    ctx.fillRect(0, 0, W, H);
  }

  // subtle vignette for cinematic look
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.75);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/* ---------------- Editor UI ---------------- */
function Editor() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [beats, setBeats] = useState<Beats | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<"record" | "encode" | "">("");
  const [log, setLog] = useState("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [aspect, setAspect] = useState<"9:16" | "16:9" | "1:1">("9:16");

  const photosNeeded = beats ? Math.max(4, Math.ceil(beats.times.length / 2)) : 0;

  async function onAudio(f: File) {
    setAudioFile(f);
    setStage("analyzing");
    setLog("ऑडियो स्कैन हो रहा है…");
    try {
      const b = await analyzeBeats(f);
      setBeats(b);
      setStage("ready");
      setLog(`✓ ${b.duration.toFixed(1)}s • ~${b.bpm} BPM • ${b.times.length} beats detected`);
    } catch (e: any) {
      setStage("idle");
      setLog("ऑडियो डिकोड नहीं हो सका: " + e.message);
    }
  }

  function onPhotos(list: FileList | null) {
    if (!list) return;
    const arr = Array.from(list).filter((f) => f.type.startsWith("image/"));
    setPhotos(arr);
  }

  async function generate() {
    if (!audioFile || !beats || photos.length === 0) return;
    setStage("rendering");
    setProgress(0);
    setPhase("record");
    setVideoUrl(null);
    setLog("रेंडर शुरू…");

    const dims = aspect === "9:16" ? [1080, 1920] : aspect === "16:9" ? [1920, 1080] : [1080, 1080];
    const [W, H] = dims;
    const FPS = 30;

    // load images
    const imgs = await Promise.all(
      photos.map(
        (f) =>
          new Promise<HTMLImageElement>((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = rej;
            i.src = URL.createObjectURL(f);
          }),
      ),
    );

    // Smart Loop & Reverse — extend to cover all beats
    const segments = beats.times.length;
    const seq: { img: HTMLImageElement; effect: Effect }[] = [];
    for (let i = 0; i < segments; i++) {
      const cycle = Math.floor(i / imgs.length);
      const idx = cycle % 2 === 0 ? i % imgs.length : imgs.length - 1 - (i % imgs.length);
      seq.push({ img: imgs[idx], effect: EFFECTS[i % EFFECTS.length] });
    }

    // canvas + audio → MediaRecorder
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d")!;

    const audioEl = new Audio(URL.createObjectURL(audioFile));
    audioEl.crossOrigin = "anonymous";
    await new Promise((r) => (audioEl.oncanplaythrough = r));

    const ac = new AudioContext();
    const src = ac.createMediaElementSource(audioEl);
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    src.connect(ac.destination);

    const stream = canvas.captureStream(FPS);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : "video/webm;codecs=vp8,opus";
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const recDone = new Promise<Blob>((r) => (rec.onstop = () => r(new Blob(chunks, { type: "video/webm" }))));

    rec.start(250);
    await ac.resume();
    audioEl.currentTime = 0;
    await audioEl.play();

    let stop = false;
    audioEl.onended = () => (stop = true);

    const startWall = performance.now();
    const render = () => {
      if (stop) return;
      const t = audioEl.currentTime;
      // find current beat segment
      let i = 0;
      while (i < beats.times.length - 1 && beats.times[i + 1] <= t) i++;
      const segStart = beats.times[i] ?? 0;
      const segEnd = beats.times[i + 1] ?? beats.duration;
      const segLen = Math.max(0.05, segEnd - segStart);
      const local = Math.min(1, Math.max(0, (t - segStart) / segLen));
      const punch = Math.max(0, 1 - local * 4); // strong at beat, decays
      const item = seq[Math.min(i, seq.length - 1)] || { img: imgs[0], effect: "zoom" as Effect };
      drawFrame(ctx, item.img, W, H, item.effect, local, punch);

      setProgress(Math.min(0.7, (t / beats.duration) * 0.7));
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);

    await new Promise<void>((r) => (audioEl.onended = () => r()));
    await new Promise((r) => setTimeout(r, 200));
    rec.stop();
    const webm = await recDone;
    ac.close();
    setProgress(0.7);
    setPhase("encode");

    setLog("MP4 1080p में कन्वर्ट हो रहा है…");
    const ff = await getFFmpeg();
    ff.on("progress", ({ progress: p }: { progress: number }) => {
      const pp = Math.max(0, Math.min(1, p));
      setProgress(0.7 + pp * 0.3);
    });
    const { fetchFile } = await import("@ffmpeg/util");
    await ff.writeFile("in.webm", await fetchFile(webm));
    await ff.exec([
      "-i", "in.webm",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-vf", `scale=${W}:${H}`,
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      "out.mp4",
    ]);
    const data = (await ff.readFile("out.mp4")) as Uint8Array;
    // copy into a fresh ArrayBuffer to satisfy Blob typings
    const buf = new Uint8Array(data.byteLength);
    buf.set(data);
    const mp4 = new Blob([buf], { type: "video/mp4" });
    setVideoUrl(URL.createObjectURL(mp4));
    setProgress(1);
    setPhase("");
    setStage("done");
    setLog("✓ तैयार है!");
  }

  const canGenerate = !!beats && photos.length >= 1 && stage !== "rendering" && stage !== "analyzing";
  const enoughPhotos = photos.length >= photosNeeded;

  return (
    <div className="min-h-screen text-white" style={{ background: "radial-gradient(1200px 800px at 20% -10%, #2a1457 0%, transparent 60%), radial-gradient(900px 700px at 110% 20%, #ff2e88 0%, transparent 55%), #0b0617" }}>
      <div className="mx-auto max-w-3xl px-5 py-10">
        <header className="mb-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs tracking-widest uppercase">
            <span className="h-1.5 w-1.5 rounded-full bg-[#ff2e88]" /> 2026 Edition
          </div>
          <h1 className="mt-4 text-4xl font-black leading-tight md:text-6xl">
            Raja AI <span className="bg-gradient-to-r from-[#ff2e88] via-[#ffb347] to-[#7c5cff] bg-clip-text text-transparent">Pro-Editor</span>
          </h1>
          <p className="mt-3 text-white/70">ऑडियो अपलोड करें → बीट्स खुद डिटेक्ट → फोटोज़ डालें → 1080p Shorts-रेडी वीडियो।</p>
        </header>

        {/* Step 1: audio */}
        <Card title="1 · ऑडियो अपलोड">
          <UploadBox
            accept="audio/*"
            label={audioFile ? audioFile.name : "MP3 / WAV / M4A चुनें"}
            onFiles={(fl) => fl[0] && onAudio(fl[0])}
          />
          {beats && (
            <div className="mt-4 grid grid-cols-3 gap-3 text-center">
              <Stat label="Duration" value={`${beats.duration.toFixed(1)}s`} />
              <Stat label="BPM" value={`${beats.bpm}`} />
              <Stat label="Beats" value={`${beats.times.length}`} />
            </div>
          )}
        </Card>

        {/* Step 2: photos */}
        <Card title="2 · फोटो अपलोड" disabled={!beats}>
          {beats && (
            <div className="mb-3 rounded-lg border border-[#ff2e88]/40 bg-[#ff2e88]/10 px-3 py-2 text-sm">
              📸 आपको कम-से-कम <b>{photosNeeded}</b> फोटो चाहिए (बीट के अनुसार).{" "}
              {photos.length > 0 && (
                <span className={enoughPhotos ? "text-emerald-300" : "text-amber-300"}>
                  अभी: {photos.length} {enoughPhotos ? "✓" : `(Smart Loop ऑन — कमी पूरी करेगा)`}
                </span>
              )}
            </div>
          )}
          <UploadBox
            accept="image/*"
            multiple
            label={photos.length ? `${photos.length} फोटो सिलेक्टेड` : "फोटोज़ चुनें (multiple)"}
            onFiles={(fl) => onPhotos(fl)}
          />
          {photos.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {photos.slice(0, 12).map((p, i) => (
                <img key={i} src={URL.createObjectURL(p)} className="h-16 w-16 rounded-md object-cover" alt="" />
              ))}
              {photos.length > 12 && <div className="flex h-16 w-16 items-center justify-center rounded-md bg-white/10 text-xs">+{photos.length - 12}</div>}
            </div>
          )}
        </Card>

        {/* Step 3: format + generate */}
        <Card title="3 · फॉर्मेट चुनें" disabled={!beats}>
          <div className="flex gap-2">
            {(["9:16", "1:1", "16:9"] as const).map((a) => (
              <button
                key={a}
                onClick={() => setAspect(a)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm transition ${aspect === a ? "border-[#ff2e88] bg-[#ff2e88]/20" : "border-white/15 bg-white/5 hover:bg-white/10"}`}
              >
                {a === "9:16" ? "Shorts / Reels" : a === "1:1" ? "Square" : "YouTube"}
                <div className="text-[10px] text-white/50">{a}</div>
              </button>
            ))}
          </div>
        </Card>

        <button
          disabled={!canGenerate}
          onClick={generate}
          className="mt-6 w-full rounded-2xl bg-gradient-to-r from-[#ff2e88] via-[#ff6a3d] to-[#ffb347] py-5 text-lg font-black tracking-wide text-black shadow-[0_10px_40px_-10px_rgba(255,46,136,0.6)] transition active:scale-[0.98] disabled:opacity-40"
        >
          {stage === "rendering" ? `रेंडरिंग… ${Math.round(progress * 100)}%` : "⚡ GENERATE RAJA STYLE VIDEO"}
        </button>

        {stage === "rendering" && (
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-gradient-to-r from-[#ff2e88] to-[#ffb347] transition-all" style={{ width: `${progress * 100}%` }} />
          </div>
        )}
        {log && <p className="mt-3 text-center text-xs text-white/60">{log}</p>}

        {videoUrl && (
          <Card title="✓ आपका वीडियो">
            <video src={videoUrl} controls className="w-full rounded-lg" />
            <a
              href={videoUrl}
              download="raja-ai-video.mp4"
              className="mt-3 inline-flex w-full items-center justify-center rounded-lg bg-white py-3 font-bold text-black"
            >
              ⬇ डाउनलोड MP4 (1080p)
            </a>
          </Card>
        )}

        <footer className="mt-10 text-center text-xs text-white/40">
          100% browser • कोई API key नहीं चाहिए • आपकी फाइलें कहीं अपलोड नहीं होतीं
        </footer>
      </div>
    </div>
  );
}

function Card({ title, children, disabled }: { title: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <section className={`mt-5 rounded-2xl border border-white/10 bg-white/[0.04] p-5 backdrop-blur ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/80">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 px-2 py-2">
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-white/50">{label}</div>
    </div>
  );
}

function UploadBox({
  accept,
  multiple,
  label,
  onFiles,
}: {
  accept: string;
  multiple?: boolean;
  label: string;
  onFiles: (fl: FileList) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <button
      onClick={() => ref.current?.click()}
      className="flex w-full items-center justify-center rounded-xl border-2 border-dashed border-white/20 bg-black/20 px-4 py-6 text-sm font-medium text-white/80 transition hover:border-[#ff2e88] hover:bg-[#ff2e88]/10"
    >
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => e.target.files && onFiles(e.target.files)}
      />
      ⬆ {label}
    </button>
  );
}
