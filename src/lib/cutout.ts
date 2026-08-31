/**
 * FAST SUBJECT CUTOUT (foreground segmentation approximation)
 *
 * Real semantic segmentation (MediaPipe SelfieSegmentation / WebGL shaders) costs
 * a model download plus per-frame inference, which stalls low-end phones mid-render.
 * Instead the subject mask is computed ONCE per photo at load time (a few ms) with a
 * saliency heuristic — border-colour distance + local contrast + centre bias — then
 * feathered and reused for every frame, so drop-layering costs ~0ms per frame.
 *
 * Output: a canvas the same size as the drawn photo containing ONLY the subject
 * (transparent elsewhere), ready to be composited on top of a stylised backdrop.
 */
export type Cutout = { canvas: HTMLCanvasElement; width: number; height: number };

export function buildSubjectCutout(
  img: CanvasImageSource & { width: number; height: number },
  maxSide = 720,
): Cutout | null {
  try {
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const W = Math.max(2, Math.round(img.width * scale));
    const H = Math.max(2, Math.round(img.height * scale));

    // ---- analysis pass (small) ----
    const aw = 128;
    const ah = Math.max(2, Math.round((H / W) * aw));
    const an = document.createElement("canvas");
    an.width = aw; an.height = ah;
    const actx = an.getContext("2d", { willReadFrequently: true });
    if (!actx) return null;
    actx.drawImage(img, 0, 0, aw, ah);
    const data = actx.getImageData(0, 0, aw, ah).data;

    // average border colour = presumed background
    let br = 0, bg = 0, bb = 0, bn = 0;
    const sampleBorder = (x: number, y: number) => {
      const i = (y * aw + x) * 4;
      br += data[i]; bg += data[i + 1]; bb += data[i + 2]; bn++;
    };
    for (let x = 0; x < aw; x++) { sampleBorder(x, 0); sampleBorder(x, ah - 1); }
    for (let y = 0; y < ah; y++) { sampleBorder(0, y); sampleBorder(aw - 1, y); }
    br /= bn; bg /= bn; bb /= bn;

    const mask = new Float32Array(aw * ah);
    for (let y = 0; y < ah; y++) {
      for (let x = 0; x < aw; x++) {
        const i = (y * aw + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const dist = Math.sqrt((r - br) ** 2 + (g - bg) ** 2 + (b - bb) ** 2) / 441;
        // local contrast (cheap 4-neighbour gradient)
        const xr = Math.min(aw - 1, x + 1), yd = Math.min(ah - 1, y + 1);
        const i2 = (y * aw + xr) * 4, i3 = (yd * aw + x) * 4;
        const grad =
          (Math.abs(r - data[i2]) + Math.abs(g - data[i2 + 1]) + Math.abs(b - data[i2 + 2]) +
            Math.abs(r - data[i3]) + Math.abs(g - data[i3 + 1]) + Math.abs(b - data[i3 + 2])) / (6 * 255);
        // centre bias — subjects live near the middle, lower-third weighted
        const nx = (x / (aw - 1)) * 2 - 1;
        const ny = ((y / (ah - 1)) * 2 - 1) * 0.85 - 0.1;
        const centre = Math.max(0, 1 - Math.hypot(nx * 1.15, ny) / 1.05);
        mask[y * aw + x] = Math.min(1, dist * 1.35 + grad * 0.8) * (0.35 + centre * 0.9);
      }
    }

    // soften + threshold into alpha
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = aw; maskCanvas.height = ah;
    const mctx = maskCanvas.getContext("2d");
    if (!mctx) return null;
    const out = mctx.createImageData(aw, ah);
    let strong = 0;
    for (let i = 0; i < mask.length; i++) {
      const v = mask[i];
      const a = v < 0.22 ? 0 : Math.min(1, (v - 0.22) / 0.3);
      if (a > 0.5) strong++;
      out.data[i * 4] = 255; out.data[i * 4 + 1] = 255; out.data[i * 4 + 2] = 255;
      out.data[i * 4 + 3] = Math.round(a * 255);
    }
    // mask must actually isolate something — otherwise skip layering for this photo
    const coverage = strong / mask.length;
    if (coverage < 0.04 || coverage > 0.82) return null;
    mctx.putImageData(out, 0, 0);

    // ---- composite pass (full size, feathered) ----
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.filter = `blur(${Math.max(1, Math.round(W * 0.008))}px)`;
    ctx.drawImage(maskCanvas, 0, 0, W, H);
    ctx.filter = "none";
    ctx.globalCompositeOperation = "source-in";
    ctx.drawImage(img, 0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    return { canvas, width: W, height: H };
  } catch {
    return null;
  }
}
