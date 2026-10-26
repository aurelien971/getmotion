export const SAM2_VIDEO = "fal-ai/sam2/video";

export type Cast = { url: string; who: string };

export type GenInput = {
  videoUrl: string;
  maskUrl: string | null;
  cast: Cast[];
  prompt: string;
  directed?: string; // full prompt written by the Director; used verbatim when present
  duration: number;
  side: "left" | "center" | "right";
};

export type Model = {
  id: string;
  provider: "fal" | "sume";
  name: string;
  note: string;
  usesMask: boolean;
  keepsAudio: boolean; // false = output is silent, we mux the source audio back
  maxCast: number; // 0 = prompt only, no face photos
  usdPerSec: number; // rough, check provider pricing
  build: (i: GenInput) => Record<string, unknown>;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

// "Reference image 1 replaces the man in the striped shirt on the left. ..."
function castPrompt(i: GenInput) {
  if (i.directed?.trim()) return i.directed.trim();
  const lines = i.cast.map((c, n) =>
    `Reference image ${n + 1} replaces ${c.who.trim() || `the person on the ${i.side}`}.`,
  );
  return [...lines, "Keep everyone else unchanged.", i.prompt].join(" ").trim();
}

// Kling names the clip @Video1 and character photos @Element1..N instead of "reference image N".
function klingPrompt(i: GenInput) {
  const base = castPrompt(i).replace(/reference images? (\d+)(?: to (\d+))?/gi, (_m, a, b) => (b ? `@Element${a} to @Element${b}` : `@Element${a}`));
  return `Edit @Video1. ${base}`;
}

export const MODELS: Model[] = [
  {
    id: "fal-ai/wan-vace-14b",
    provider: "fal",
    name: "Wan VACE — masked",
    note: "Uses your mask exactly. Cheap. Output at 16fps, max ~15s.",
    usesMask: true,
    keepsAudio: false,
    maxCast: 1,
    usdPerSec: 0.08,
    build: (i) => ({
      task: "inpainting",
      video_url: i.videoUrl,
      mask_video_url: i.maskUrl,
      ref_image_urls: [i.cast[0].url],
      prompt: i.directed?.trim() || i.prompt || "the person from the reference image",
      frames_per_second: 16,
      num_frames: clamp(i.duration * 16, 81, 241),
      resolution: "480p",
    }),
  },
  {
    id: "fal-ai/wan/v2.2-14b/animate/replace",
    provider: "fal",
    name: "Wan 2.2 Animate Replace",
    note: "Cheapest swap. Finds the person itself (no mask). Best with one person.",
    usesMask: false,
    keepsAudio: false,
    maxCast: 1,
    usdPerSec: 0.04,
    build: (i) => ({
      video_url: i.videoUrl,
      image_url: i.cast[0].url,
      resolution: "720p", // 480p looks soft next to H3 renders
      use_turbo: true,
    }),
  },
  {
    id: "fal-ai/minimax-h3-max-recast",
    provider: "fal",
    name: "H3 Max Recast (fal)",
    note: "Best quality, keeps audio. Targets people by your descriptions.",
    usesMask: false,
    keepsAudio: true,
    maxCast: 4,
    usdPerSec: 0.1, // measured: $1.44 for a 15 s clip at 768P
    build: (i) => ({
      video_url: i.videoUrl,
      reference_image_urls: i.cast.map((c) => c.url),
      prompt: castPrompt(i),
      resolution: "768P",
    }),
  },
  {
    id: "h3-max-recast",
    provider: "sume",
    name: "H3 Max Recast (Sume)",
    note: "Same model via Sume. $0.30/s at 768p.",
    usesMask: false,
    keepsAudio: true,
    maxCast: 4,
    usdPerSec: 0.3,
    build: (i) => ({
      video_url: i.videoUrl,
      reference_image_urls: i.cast.map((c) => c.url),
      prompt: castPrompt(i),
      duration: clamp(i.duration, 5, 30),
      resolution: "768p",
    }),
  },
  {
    id: "hailuo-h3-regen",
    provider: "sume",
    name: "Hailuo H3 Regen (Sume)",
    note: "Restyles the whole clip from your prompt. No face photo. $0.05/s.",
    usesMask: false,
    keepsAudio: true,
    maxCast: 0,
    usdPerSec: 0.05,
    build: (i) => ({
      video_url: i.videoUrl,
      prompt: i.prompt,
      duration: clamp(i.duration, 5, 16),
    }),
  },
  {
    id: "fal-ai/kling-video/o3/pro/video-to-video/edit",
    provider: "fal",
    name: "Kling O3 Pro Edit",
    note: "Kling's video editor: replaces a character with your photo, keeps motion, camera and light. 3-15 s clips.",
    usesMask: false,
    keepsAudio: false,
    maxCast: 4,
    usdPerSec: 0.168,
    build: (i) => ({
      video_url: i.videoUrl,
      prompt: klingPrompt(i),
      elements: i.cast.slice(0, 4).map((c) => ({ frontal_image_url: c.url, reference_image_urls: [c.url] })),
      keep_audio: false,
    }),
  },
];

export const SUME_MODELS = MODELS.filter((m) => m.provider === "sume").map((m) => m.id);

// Image editors for fixing single frames in Inspect. `ratio` is the output aspect.
export type FrameModel = {
  id: string;
  name: string;
  usdPerFrame: number; // rough
  build: (i: { prompt: string; imageUrls: string[]; ratio: string }) => Record<string, unknown>;
};
export const FRAME_MODELS: FrameModel[] = [
  {
    id: "fal-ai/nano-banana-2/edit",
    name: "Nano Banana 2",
    usdPerFrame: 0.08,
    build: (i) => ({ prompt: i.prompt, image_urls: i.imageUrls, num_images: 1, resolution: "1K", aspect_ratio: i.ratio, output_format: "jpeg", seed: 4242 }),
  },
  {
    id: "openai/gpt-image-2/edit",
    name: "GPT Image 2 (OpenAI)",
    usdPerFrame: 0.2, // token-billed; roughly this at high quality
    build: (i) => ({ prompt: i.prompt, image_urls: i.imageUrls, num_images: 1, image_size: "auto", quality: "high", output_format: "jpeg" }),
  },
];
export const FRAME_SWAP = FRAME_MODELS[0];

export const ALLOWED_ENDPOINTS = [
  SAM2_VIDEO,
  ...FRAME_MODELS.map((m) => m.id),
  ...MODELS.filter((m) => m.provider === "fal").map((m) => m.id),
].flatMap((id) => [id, `${id}/**`]);
