// Frame analysis on the original (playable) file, independent of the H.264 copy:
// refine edges onto real cuts, and measure the time offset of the converted copy.

const W = 64;
const H = 36;

type Reader = {
  frame: (f: number) => Promise<Uint8ClampedArray>;
  at: (t: number) => Promise<Uint8ClampedArray>; // frame shown at time t (uncached)
  close: () => void;
};

export async function openReader(src: string, fps: number): Promise<Reader> {
  const v = document.createElement("video");
  v.crossOrigin = "anonymous"; // remote renders (fal) allow it; needed to read frames
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
  const grab = async (t: number) => {
    await new Promise<void>((r) => {
      v.onseeked = () => r();
      v.currentTime = Math.max(0, t);
    });
    ctx.drawImage(v, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    const y = new Uint8ClampedArray(W * H);
    for (let i = 0; i < W * H; i++) y[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
    return y;
  };
  return {
    at: grab,
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

// For each span (original times), find where its first and last frame really sit in
// a converted copy whose timing jitters: search ±range frames around the expected
// position (original time + offset) and pick the best match. Returns copy times.
export async function alignSpans(
  original: string,
  copy: string,
  fps: number,
  offset: number,
  spans: { start: number; end: number }[],
  range = 3,
): Promise<{ start: number; end: number }[]> {
  const a = await openReader(original, fps);
  const b = await openReader(copy, fps);
  const f = 1 / fps;
  try {
    const best = async (origT: number) => {
      const ref = await a.at(origT);
      let bestS = 0;
      let bestD = Infinity;
      for (let s = -range; s <= range; s++) {
        const d = diff(ref, await b.at(origT + offset + s * f));
        if (d < bestD - 0.01 || (Math.abs(d - bestD) < 0.01 && Math.abs(s) < Math.abs(bestS))) {
          bestD = d;
          bestS = s;
        }
      }
      return bestS;
    };
    const out: { start: number; end: number }[] = [];
    for (const sp of spans) {
      const s1 = await best(sp.start + 0.5 * f);
      const s2 = await best(sp.end - 0.5 * f);
      out.push({ start: Math.max(0, sp.start + offset + s1 * f), end: sp.end + offset + s2 * f });
    }
    return out;
  } finally {
    a.close();
    b.close();
  }
}

// Line a finished render up with the plan, frame by frame. At every hard cut inside
// the render, each frame near the cut is compared with the original's outgoing and
// incoming shot. The incoming piece starts where its frames really begin; frames that
// match neither side (the model's blended / junk transition frames) are reported as
// `tail` of the outgoing piece and `head` of the incoming one, so they can be held over.
export async function lineUpRender(
  original: string,
  render: string,
  fps: number,
  pieces: { start: number; end: number; offset: number }[],
): Promise<{ offsets: number[]; edges: { head: number; tail: number }[] }> {
  const a = await openReader(original, fps);
  const b = await openReader(render, fps);
  const sf = (t: number) => Math.round(t * fps + 1e-3); // time -> frame index
  try {
    const offsets: number[] = [];
    const edges = pieces.map(() => ({ head: 0, tail: 0 }));
    for (let i = 0; i < pieces.length; i++) {
      const pc = pieces[i];
      if (i === 0) {
        offsets.push(pc.offset);
        continue;
      }
      const prev = pieces[i - 1];
      const prevLen = sf(prev.end) - sf(prev.start);
      const follow = sf(offsets[i - 1]) + prevLen; // planned first render frame of this piece
      if (Math.abs(prev.end - pc.start) < 1e-3) {
        offsets.push(follow / fps);
        continue;
      }
      const lastA = await a.frame(sf(prev.end) - 1);
      const inB = [0, 1, 2, 3].map((s) => sf(pc.start) + s);
      const refB: Uint8ClampedArray[] = [];
      for (const f of inB) refB.push(await a.frame(f)); // one seek at a time
      const lo = Math.max(1, follow - 3);
      const hi = follow + 4;
      const rows: { k: number; dA: number; dB: number; s: number }[] = [];
      for (let k = lo; k <= hi; k++) {
        const r = await b.frame(k);
        let dB = Infinity;
        let s = 0;
        refB.forEach((x, j) => {
          const d = diff(r, x);
          if (d < dB) {
            dB = d;
            s = j;
          }
        });
        rows.push({ k, dA: diff(r, lastA), dB, s });
      }
      const isB = (x: (typeof rows)[number]) => x.dB < 0.7 * x.dA;
      const isA = (x: (typeof rows)[number]) => x.dA < 0.7 * x.dB;
      const ci = rows.findIndex((x, j) => isB(x) && (j === rows.length - 1 || isB(rows[j + 1])));
      if (ci < 0) {
        offsets.push(follow / fps);
        continue;
      }
      const c = rows[ci];
      offsets.push((c.k - c.s) / fps);
      edges[i].head = c.s;
      // Outgoing piece: its planned frames after the last real frame of its own shot.
      let lastAk = -1;
      for (let j = ci - 1; j >= 0; j--)
        if (isA(rows[j])) {
          lastAk = rows[j].k;
          break;
        }
      const end = follow - 1;
      edges[i - 1].tail = lastAk < 0 ? 0 : Math.min(3, Math.max(0, end - lastAk));
    }
    return { offsets, edges };
  } finally {
    a.close();
    b.close();
  }
}
