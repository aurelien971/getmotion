export const SAM2_VIDEO = "fal-ai/sam2/video";

export type GenInput = {
  videoUrl: string;
  maskUrl: string | null;
  refImageUrl: string;
  prompt: string;
  duration: number;
  side: "left" | "center" | "right";
};

export type Model = {
  id: string;
  name: string;
  note: string;
  usesMask: boolean;
  usdPerSec: number; // rough, check fal pricing
  build: (i: GenInput) => Record<string, unknown>;
};

export const MODELS: Model[] = [
  {
    id: "fal-ai/wan-vace-14b",
    name: "Wan VACE — masked",
    note: "Uses your mask exactly. Cheap. Output at 16fps, max ~15s.",
    usesMask: true,
    usdPerSec: 0.08,
    build: (i) => ({
      task: "inpainting",
      video_url: i.videoUrl,
      mask_video_url: i.maskUrl,
      ref_image_urls: [i.refImageUrl],
      prompt: i.prompt || "the person from the reference image",
      frames_per_second: 16,
      num_frames: Math.min(241, Math.max(81, Math.ceil(i.duration * 16))),
      resolution: "480p",
    }),
  },
  {
    id: "fal-ai/wan/v2.2-14b/animate/replace",
    name: "Wan 2.2 Animate Replace",
    note: "Cheapest. Finds the person itself (no mask). Best with one person.",
    usesMask: false,
    usdPerSec: 0.04,
    build: (i) => ({
      video_url: i.videoUrl,
      image_url: i.refImageUrl,
      resolution: "480p",
      use_turbo: true,
    }),
  },
  {
    id: "fal-ai/minimax-h3-max-recast",
    name: "MiniMax H3 Max Recast",
    note: "Best quality, keeps audio. No mask: targets by position + prompt.",
    usesMask: false,
    usdPerSec: 0.35,
    build: (i) => ({
      video_url: i.videoUrl,
      reference_image_urls: [i.refImageUrl],
      prompt:
        `Replace the person on the ${i.side} of the frame with the person in the reference photo. Keep everyone else unchanged. ${i.prompt}`.trim(),
      resolution: "768P",
    }),
  },
];

export const ALLOWED_ENDPOINTS = [SAM2_VIDEO, ...MODELS.map((m) => m.id)].flatMap(
  (id) => [id, `${id}/**`],
);
