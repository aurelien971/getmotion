// Frame analysis on the original (playable) file, independent of the H.264 copy:
// refine edges onto real cuts, and measure the time offset of the converted copy.

const W = 64;
const H = 36;

type Reader = {
  frame: (f: number) => Promise<Uint8ClampedArray>;
  close: () => void;
};

export async function openReader(src: string, fps: number): Promise<Reader> {
  const v = document.createElement("video");
  v.src = src;
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  await new Promise<void>((res, rej) => {
    v.onloadedmetadata = () => res();
    v.onerror = () => rej(new Error("Could not read the video"));
  });
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const cache = new Map<number, Uint8ClampedArray>();
  return {
    async frame(f: number) {
      const hit = cache.get(f);
      if (hit) return hit;
      await new Promise<void>((r) => {
        v.onseeked = () => r();
        v.currentTime = Math.max(0, (f + 0.5) / fps);
      });
      ctx.drawImage(v, 0, 0, W, H);
      const data = ctx.getImageData(0, 0, W, H).data;
      // Luma only.
      const y = new Uint8ClampedArray(W * H);
      for (let i = 0; i < W * H; i++) y[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
      cache.set(f, y);
      return y;
    },
    close() {
      v.src = "";
    },
  };
}

const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

// Snap an edge at time t to the hard cut within ±radius frames, if there is one.
// Returns the frame index of the first frame of the new shot, or null.
export async function refineEdge(r: Reader, fps: number, t: number, totalFrames: number, radius = 6): Promise<number | null> {
  const f0 = Math.round(t * fps);
  const lo = Math.max(1, f0 - radius);
  const hi = Math.min(totalFrames - 1, f0 + radius);
  const scores: { f: number; d: number }[] = [];
  let prev = await r.frame(lo - 1);
  for (let f = lo; f <= hi; f++) {
    const cur = await r.frame(f);
    scores.push({ f, d: diff(prev, cur) });
    prev = cur;
  }
  if (scores.length < 3) return null;
  const sorted = [...scores].map((s) => s.d).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const best = scores.reduce((a, b) => (b.d > a.d ? b : a));
  // A hard cut stands well clear of normal motion between frames.
  if (best.d < 10 || best.d < median * 3) return null;
  return best.f;
}

// How far the converted copy runs ahead of the original, in seconds
// (copy time = original time + offset). Matches frames at a few points.
export async function measureOffset(src: string, copy: string, fps: number, duration: number): Promise<number | null> {
  const a = await openReader(src, fps);
  const b = await openReader(copy, fps);
  try {
    const shifts: number[] = [];
    for (const k of [0.2, 0.4, 0.6, 0.8]) {
      const f = Math.round(duration * k * fps);
      const ref = await a.frame(f);
      let best = 0;
      let bestD = Infinity;
      for (let s = -10; s <= 10; s++) {
        if (f + s < 0) continue;
        const d = diff(ref, await b.frame(f + s));
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (bestD < 12) shifts.push(best);
    }
    if (!shifts.length) return null;
    shifts.sort((x, y) => x - y);
    return shifts[Math.floor(shifts.length / 2)] / fps;
  } finally {
    a.close();
    b.close();
  }
}
