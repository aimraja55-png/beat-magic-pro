/**
 * Neural Cutout — automatic subject isolation (background removal) in the browser.
 * Runs fully client-side; used by the render engine to "paste" a photo's subject
 * onto another photo's background on strong bass hits.
 */

export type CutoutMap = Map<number, ImageBitmap>;

type Progress = (done: number, total: number) => void;

function deviceCanHandleCutouts() {
  if (typeof navigator === "undefined") return false;
  const mem = (navigator as Navigator & { deviceMemory?: number; hardwareConcurrency?: number });
  const cores = mem.hardwareConcurrency ?? 4;
  const ram = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  return cores >= 4 && ram >= 3;
}

/**
 * Isolates subjects for the first `max` photos. Never throws — on any failure it
 * simply returns whatever succeeded so rendering continues normally.
 */
export async function prepareCutouts(
  files: File[],
  opts: { max?: number; budgetMs?: number; targetMax?: number; onProgress?: Progress } = {},
): Promise<CutoutMap> {
  const out: CutoutMap = new Map();
  const max = Math.min(opts.max ?? 4, files.length);
  if (max === 0 || !deviceCanHandleCutouts()) return out;

  const budgetMs = opts.budgetMs ?? 45_000;
  const targetMax = opts.targetMax ?? 1280;
  const started = Date.now();

  let removeBackground: (input: Blob) => Promise<Blob>;
  try {
    const mod = await import("@imgly/background-removal");
    removeBackground = (input: Blob) => mod.removeBackground(input, { output: { format: "image/png" } });
  } catch (error) {
    console.warn("[Raja AI] cutout engine unavailable", error);
    return out;
  }

  for (let i = 0; i < max; i++) {
    if (Date.now() - started > budgetMs) break;
    try {
      const blob = await removeBackground(files[i]);
      const bmp = await createImageBitmap(blob, {
        resizeWidth: targetMax,
        resizeHeight: targetMax,
        resizeQuality: "high",
        imageOrientation: "from-image",
      } as ImageBitmapOptions);
      out.set(i, bmp);
    } catch (error) {
      console.warn("[Raja AI] cutout failed for photo", i, error);
    }
    opts.onProgress?.(i + 1, max);
  }
  return out;
}

/**
 * Draws a "photo merge": subject cut from one photo, composited over another
 * photo's background with a beat-driven pop.
 */
export function drawCutoutComposite(
  ctx: CanvasRenderingContext2D,
  background: CanvasImageSource & { width: number; height: number },
  subject: CanvasImageSource & { width: number; height: number },
  W: number,
  H: number,
  opts: { pop?: number; energy?: number; drift?: number } = {},
) {
  const pop = opts.pop ?? 1;
  const energy = opts.energy ?? 0;
  const drift = opts.drift ?? 0;

  // Background: full-bleed, slightly pushed back
  ctx.save();
  const bgScale = Math.max(W / background.width, H / background.height) * (1.04 + energy * 0.05);
  const bgW = background.width * bgScale;
  const bgH = background.height * bgScale;
  ctx.filter = "blur(6px) saturate(115%)";
  ctx.drawImage(background, (W - bgW) / 2, (H - bgH) / 2, bgW, bgH);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = `rgba(6,4,12,${0.18 + energy * 0.12})`;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // Subject: fitted, popped forward, with a soft contact shadow
  const fit = Math.min(W / subject.width, H / subject.height) * (0.94 * pop);
  const sw = subject.width * fit;
  const sh = subject.height * fit;
  const sx = (W - sw) / 2 + drift * W * 0.02;
  const sy = (H - sh) / 2;

  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.filter = "blur(24px) brightness(0)";
  ctx.drawImage(subject, sx, sy + H * 0.012, sw, sh);
  ctx.restore();

  ctx.save();
  ctx.drawImage(subject, sx, sy, sw, sh);
  ctx.restore();
}
