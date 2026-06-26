import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

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
  if (text.includes("timeout") || text.includes("aborted") || text.includes("stalled")) return "timeout";
  return "unknown";
}

async function loadFFmpeg() {
  if (ffmpeg && loaded) return ffmpeg;

  recentLogs.length = 0;
  ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => rememberLog(message));
  ffmpeg.on("progress", ({ progress }) => {
    const safeProgress = Math.max(0, Math.min(0.95, Number.isFinite(progress) ? progress : 0));
    post({ type: "progress", progress: safeProgress, message: "MP4 finalization" });
  });

  const base = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
  });
  loaded = true;
  return ffmpeg;
}

async function encode({ webmBuffer, width, height, fps, duration }: EncodeRequest) {
  const ff = await loadFFmpeg();
  const stamp = `${Date.now()}-${Math.round(Math.random() * 100000)}`;
  const inputName = `input-${stamp}.webm`;
  const outputName = `output-${stamp}.mp4`;

  post({ type: "progress", progress: 0.02, message: "Writing render buffer" });
  await ff.writeFile(inputName, new Uint8Array(webmBuffer));
  post({ type: "progress", progress: 0.06, message: "Starting encoder" });

  const timeoutMs = Math.max(120_000, Math.ceil(duration * 12_000));
  const exitCode = await ff.exec(
    [
      "-hide_banner",
      "-fflags",
      "+genpts",
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
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      "-flush_packets",
      "1",
      outputName,
    ],
    timeoutMs,
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