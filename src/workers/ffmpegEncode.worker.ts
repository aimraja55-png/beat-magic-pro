import { FFmpeg } from "@ffmpeg/ffmpeg";

const coreURL = "/ffmpeg/ffmpeg-core.js";
const wasmURL = "/__l5e/assets-v1/01814cad-abc1-4bc3-aee0-a93e73fcb79d/ffmpeg-core.wasm";

type EncodeRequest = {
  type: "encode";
  webmBuffer: ArrayBuffer;
  width: number;
  height: number;
  fps: number;
  duration: number;
};

type WorkerResponse =
  | { type: "progress"; progress: number; message?: string }
  | { type: "log"; message: string }
  | { type: "done"; buffer: ArrayBuffer }
  | { type: "error"; message: string; category: "memory" | "format" | "timeout" | "unknown"; logs: string[] };

type ErrorCategory = Extract<WorkerResponse, { type: "error" }>["category"];
type EncodeWorkerScope = typeof globalThis & {
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<EncodeRequest>) => void) | null;
};

const workerScope = self as unknown as EncodeWorkerScope;
let ffmpeg: FFmpeg | null = null;
let loaded = false;
const recentLogs: string[] = [];

function post(message: WorkerResponse, transfer?: Transferable[]) {
  workerScope.postMessage(message, transfer ?? []);
}

function rememberLog(message: string) {
  recentLogs.push(message);
  if (recentLogs.length > 40) recentLogs.shift();
  post({ type: "log", message });
}

function classifyError(error: unknown): ErrorCategory {
  const text = `${error instanceof Error ? error.message : String(error)}\n${recentLogs.join("\n")}`.toLowerCase();
  if (text.includes("memory") || text.includes("allocation") || text.includes("out of bounds")) return "memory";
  if (text.includes("invalid data") || text.includes("format") || text.includes("codec") || text.includes("mux")) return "format";
  if (text.includes("timeout") || text.includes("aborted") || text.includes("stalled") || text.includes("missing")) return "timeout";
  return "unknown";
}

async function verifyAsset(url: string, label: string) {
  const response = await fetch(url, { method: "HEAD", cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${label} missing at ${url} (HTTP ${response.status})`);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  let timeoutId = 0;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(label)), ms) as unknown as number;
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadFFmpeg() {
  if (ffmpeg && loaded) return ffmpeg;

  recentLogs.length = 0;
  ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => rememberLog(message));
  ffmpeg.on("progress", ({ progress }) => {
    const rawProgress = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
    const safeProgress = Math.max(0.3, Math.min(0.95, 0.3 + rawProgress * 0.65));
    post({ type: "progress", progress: safeProgress, message: "MP4 finalization" });
  });

  post({ type: "progress", progress: 0.08, message: "Loading FFmpeg core" });
  await verifyAsset(coreURL, "FFmpeg core file");
  post({ type: "progress", progress: 0.12, message: "Loading FFmpeg WebAssembly" });
  await verifyAsset(wasmURL, "FFmpeg WASM file");
  await withTimeout(
    ffmpeg.load({
      coreURL,
      wasmURL,
    }),
    90_000,
    "FFmpeg engine load timeout: core/wasm assets did not initialize",
  );
  post({ type: "progress", progress: 0.2, message: "FFmpeg engine ready" });
  loaded = true;
  return ffmpeg;
}

async function encode({ webmBuffer, width, height, fps, duration }: EncodeRequest) {
  const ff = await loadFFmpeg();
  const stamp = `${Date.now()}-${Math.round(Math.random() * 100000)}`;
  const inputName = `input-${stamp}.webm`;
  const outputName = `output-${stamp}.mp4`;

  post({ type: "progress", progress: 0.24, message: "Writing render buffer" });
  await ff.writeFile(inputName, new Uint8Array(webmBuffer));
  post({ type: "progress", progress: 0.3, message: "Starting encoder" });

  const exitCode = await ff.exec(
    [
      "-hide_banner",
      "-fflags",
      "+genpts",
      "-analyzeduration",
      "100M",
      "-probesize",
      "100M",
      "-i",
      inputName,
      "-r",
      String(fps),
      "-s",
      `${width}x${height}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-maxrate",
      "6500k",
      "-bufsize",
      "13000k",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "baseline",
      "-level",
      "4.2",
      "-g",
      String(fps * 2),
      "-max_muxing_queue_size",
      "9999",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-shortest",
      "-avoid_negative_ts",
      "make_zero",
      "-flush_packets",
      "1",
      outputName,
    ],
  );

  if (exitCode !== 0) throw new Error(`FFmpeg finalization failed with exit code ${exitCode}`);

  post({ type: "progress", progress: 0.97, message: "Flushing MP4 buffer" });
  const data = await ff.readFile(outputName);
  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    throw new Error("Format mismatch: encoder returned an empty MP4 buffer");
  }

  const outputBytes = new Uint8Array(data);
  const outputBuffer = outputBytes.buffer as ArrayBuffer;
  await Promise.allSettled([ff.deleteFile(inputName), ff.deleteFile(outputName)]);
  ff.terminate();
  ffmpeg = null;
  loaded = false;
  post({ type: "progress", progress: 1, message: "MP4 ready" });
  post({ type: "done", buffer: outputBuffer }, [outputBuffer]);
}

workerScope.onmessage = async ({ data }: MessageEvent<EncodeRequest>) => {
  if (data.type !== "encode") return;
  try {
    await encode(data);
  } catch (error) {
    console.error("[Raja AI Worker] Finalization failed", error, recentLogs);
    try {
      ffmpeg?.terminate();
    } catch {
      // ignored — worker is already failing and will be replaced by the main thread
    }
    ffmpeg = null;
    loaded = false;
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "error", message, category: classifyError(error), logs: recentLogs.slice(-12) });
  }
};