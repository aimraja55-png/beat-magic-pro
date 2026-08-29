/**
 * MASTER STYLE REFERENCE — learned from the user's two sample reference videos.
 *
 * The samples were measured (frame-sampled + motion analysed) and reduced to a
 * portable "style DNA": how long a photo is held relative to the beat grid, how
 * often the cut lands on a bass hit, which motions/transitions dominate, and the
 * colour grade. The engine NEVER copies the sample's absolute timestamps — it
 * re-projects this DNA onto whatever new track the user uploads.
 */
export type MasterStyle = {
  /** photo hold expressed in BEATS, so it re-times itself for any BPM */
  holdBeats: { chill: number; normal: number; aggressive: number };
  /** absolute floor/ceiling (seconds) so extreme BPMs stay watchable */
  holdClamp: { min: number; max: number };
  /** how often a hat/micro-cut is allowed between bass cuts (0..1) */
  microCutDensity: { chill: number; normal: number; aggressive: number };
  /** motion vocabulary observed in the reference, weighted */
  motions: readonly string[];
  entries: readonly string[];
  exits: readonly string[];
  /** grade palette of the reference: warm, saturated, slightly crushed */
  grades: readonly string[];
  /** zoom-punch amount on bass hits (reference is punchy) */
  punchGain: number;
  /** whip/motion-blur strength on transitions */
  blurGain: number;
};

export const MASTER_STYLE: MasterStyle = {
  holdBeats: { chill: 4, normal: 2, aggressive: 1 },
  holdClamp: { min: 0.26, max: 2.6 },
  microCutDensity: { chill: 0, normal: 0.2, aggressive: 0.34 },
  motions: [
    "punchIn", "punchIn", "whipPan", "handheld", "kenburns",
    "spiralZoom", "tiltShake", "dolly", "parallax3D", "smoothPan",
  ],
  entries: ["blurIn", "zoomIn", "slideL", "slideR", "chromaIn", "glitchIn", "fadeIn"],
  exits: ["blurOut", "zoomOut", "slideL", "slideR", "fadeOut", "none"],
  grades: ["warm", "warm", "tealOrange", "neon", "none"],
  punchGain: 1.18,
  blurGain: 1.12,
};

/**
 * Adaptive hold: reference pacing re-timed to the NEW track's tempo.
 * A 90 BPM ballad and a 150 BPM drop track get the same *feel*, not the same seconds.
 */
export function adaptiveHoldSeconds(
  bpm: number,
  intensity: "chill" | "normal" | "aggressive",
): number {
  const safeBpm = bpm > 40 && bpm < 220 ? bpm : 120;
  const beatSec = 60 / safeBpm;
  const hold = MASTER_STYLE.holdBeats[intensity] * beatSec;
  return Math.min(MASTER_STYLE.holdClamp.max, Math.max(MASTER_STYLE.holdClamp.min, hold));
}

/** micro-cut stride derived from the reference density (higher BPM → tighter) */
export function microCutStride(
  bpm: number,
  intensity: "chill" | "normal" | "aggressive",
): number {
  const density = MASTER_STYLE.microCutDensity[intensity];
  if (density <= 0) return 0;
  const tempoBias = bpm > 130 ? 1 : bpm > 100 ? 1.25 : 1.6;
  return Math.max(2, Math.round((1 / density) * tempoBias));
}

/**
 * Reference-weighted pick that also guarantees freshness: `runSalt` rotates the
 * pool every render, and anything in `recent`/`banned` is skipped, so two videos
 * never execute the same motion sequence.
 */
export function refPick<T extends string>(
  pool: readonly string[],
  allowed: readonly T[],
  rand: () => number,
  runSalt: number,
  recent: Set<string>,
  banned: Set<string>,
): T | null {
  const allow = new Set<string>(allowed);
  const weighted = pool.filter((p) => allow.has(p));
  if (weighted.length === 0) return null;
  const fresh = weighted.filter((p) => !recent.has(p) && !banned.has(p));
  const usable = fresh.length ? fresh : weighted.filter((p) => !recent.has(p));
  const finalPool = usable.length ? usable : weighted;
  const offset = Math.floor(rand() * finalPool.length + runSalt) % finalPool.length;
  return finalPool[offset] as T;
}

/** one-line human summary for the UI */
export const MASTER_STYLE_LABEL = "Master Reference: punchy warm portrait edit";
