import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const inputSchema = z.object({
  durationSec: z.number(),
  bpm: z.number(),
  beatCount: z.number(),
  kickCount: z.number(),
  clapCount: z.number(),
  hatCount: z.number(),
  intensity: z.enum(["chill", "normal", "aggressive"]),
  moodTimeline: z.array(z.string()).max(60),
});

export type DirectorPlan = {
  photoCount: number;
  vibe: string;
  grade: "warm" | "cool" | "noir" | "teal" | "neutral";
  cutStyle: "slow" | "balanced" | "rapid";
  effectStrength: number;
  notes: string;
  source: "ai" | "local";
};

function localPlan(d: z.infer<typeof inputSchema>): DirectorPlan {
  const cutStyle = d.intensity === "aggressive" ? "rapid" : d.intensity === "chill" ? "slow" : "balanced";
  const perPhoto = cutStyle === "rapid" ? 1.1 : cutStyle === "slow" ? 2.6 : 1.7;
  return {
    photoCount: Math.max(4, Math.min(40, Math.round(d.durationSec / perPhoto))),
    vibe: d.intensity === "aggressive" ? "High-energy drop edit" : d.intensity === "chill" ? "Soft cinematic flow" : "Groove-locked montage",
    grade: d.intensity === "aggressive" ? "teal" : d.intensity === "chill" ? "warm" : "neutral",
    cutStyle,
    effectStrength: d.intensity === "aggressive" ? 0.95 : d.intensity === "chill" ? 0.45 : 0.7,
    notes: "Offline beat engine plan (AI unavailable).",
    source: "local",
  };
}

export const planEdit = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }): Promise<DirectorPlan> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) return localPlan(data);

    try {
      const res = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.6-sol",
          instructions:
            "You are a music-video editing director working from a MASTER STYLE REFERENCE: " +
            "vertical 9:16 portrait edit, warm/teal-orange saturated grade, punchy bass zoom-hits, " +
            "whip/motion-blur transitions, photo held ~1-2 beats, photos cycled and re-used. " +
            "Adapt this style to the NEW track's tempo and mood — never copy fixed timings; " +
            "scale pacing and motion intensity to the given BPM, kick density and mood timeline. " +
            "Given audio analysis metrics, return ONLY compact JSON: " +
            '{"photoCount":number(4-40),"vibe":string,"grade":"warm"|"cool"|"noir"|"teal"|"neutral","cutStyle":"slow"|"balanced"|"rapid","effectStrength":number(0-1),"notes":string}. ' +
            "photoCount must fit the duration: rapid ~1.1s per photo, balanced ~1.7s, slow ~2.6s. notes must be one short Hindi sentence.",
          input: JSON.stringify(data),
        }),
      });

      if (!res.ok) {
        console.error("[director] gateway error", res.status, await res.text().catch(() => ""));
        return localPlan(data);
      }

      const json = (await res.json()) as {
        output_text?: string;
        output?: { content?: { text?: string }[] }[];
      };
      const text =
        json.output_text ??
        json.output?.flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("") ??
        "";
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return localPlan(data);
      const parsed = JSON.parse(match[0]) as Partial<DirectorPlan>;
      const fallback = localPlan(data);
      return {
        photoCount: Math.max(4, Math.min(40, Math.round(Number(parsed.photoCount) || fallback.photoCount))),
        vibe: typeof parsed.vibe === "string" ? parsed.vibe : fallback.vibe,
        grade: (["warm", "cool", "noir", "teal", "neutral"] as const).includes(parsed.grade as never)
          ? (parsed.grade as DirectorPlan["grade"])
          : fallback.grade,
        cutStyle: (["slow", "balanced", "rapid"] as const).includes(parsed.cutStyle as never)
          ? (parsed.cutStyle as DirectorPlan["cutStyle"])
          : fallback.cutStyle,
        effectStrength: Math.max(0.2, Math.min(1, Number(parsed.effectStrength) || fallback.effectStrength)),
        notes: typeof parsed.notes === "string" ? parsed.notes : fallback.notes,
        source: "ai",
      };
    } catch (error) {
      console.error("[director] plan failed", error);
      return localPlan(data);
    }
  });
