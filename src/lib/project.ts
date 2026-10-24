// Chapters project: one long source video, the spans where the target is in frame,
// those spans split into shots and grouped by look, and one render per group part.

export type StoredFile = { blob: Blob; name: string; type: string };

export type Boundary = { t: number; present: boolean };

export type Shot = {
  id: string;
  start: number;
  end: number;
  groupId: string | null;
  thumb?: string; // data URL, ~480px wide
};

export type Group = {
  id: string;
  name: string;
  description: string;
  color: string;
  refs: StoredFile[];
  notes: string;
  prompt: string;
  modelId: string;
};

export type PartPiece = { shotId: string; start: number; end: number; offset: number };

export type PartStatus = "idle" | "building" | "uploading" | "rendering" | "done" | "failed";

export type Part = {
  id: string;
  groupId: string;
  pieces: PartPiece[]; // real footage, in clip order, with offset into the clip
  pad: { start: number; end: number }[]; // looped filler to reach the model's minimum length
  duration: number; // real footage length
  clipLength: number; // real + filler
  status: PartStatus;
  progress?: number;
  endpoint?: string;
  requestId?: string;
  resultUrl?: string;
  error?: string;
  renderedAt?: number;
  signature?: string; // pieces + prompt + refs; a change marks the result stale
};

export type Step = "source" | "spot" | "scenes" | "render" | "assemble";

export type Project = {
  name: string;
  source?: StoredFile; // as dropped (may be AV1/HEVC; the browser plays it)
  prepared?: StoredFile; // H.264 copy for cutting
  codec?: string | null;
  duration: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
  boundaries: Boundary[];
  watched: number; // furthest point reviewed while spotting
  cuts: number[] | null; // null = not detected yet
  shots: Shot[];
  groups: Group[];
  parts: Part[];
  step: Step;
  output?: StoredFile;
};

export const emptyProject = (): Project => ({
  name: "Untitled",
  duration: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  hasAudio: true,
  boundaries: [],
  watched: 0,
  cuts: null,
  shots: [],
  groups: [],
  parts: [],
  step: "source",
});

export const GROUP_COLORS = ["#7dd3fc", "#fca5a5", "#86efac", "#fcd34d", "#c4b5fd", "#f9a8d4", "#5eead4", "#fdba74"];

export const uid = () => Math.random().toString(36).slice(2, 10);

// ---- spotting -------------------------------------------------------------

// State at time t: true/false, or null when nothing has been marked before t.
export function stateAt(bs: Boundary[], t: number): boolean | null {
  let s: boolean | null = null;
  for (const b of bs) {
    if (b.t <= t + 1e-6) s = b.present;
    else break;
  }
  return s;
}

// Mark from t onwards (until the next boundary) as present / absent.
export function mark(bs: Boundary[], t: number, present: boolean, frame: number): Boundary[] {
  const next = bs.filter((b) => Math.abs(b.t - t) > frame / 2);
  next.push({ t, present });
  next.sort((a, b) => a.t - b.t);
  // Drop boundaries that don't change state.
  const out: Boundary[] = [];
  for (const b of next) if (!out.length || out[out.length - 1].present !== b.present) out.push(b);
  return out;
}

// Force [a, b) to a state, keeping whatever came after b.
export function markSpan(bs: Boundary[], a: number, b: number, present: boolean, frame: number): Boundary[] {
  const after = stateAt(bs, b);
  let next = bs.filter((x) => x.t < a - frame / 2 || x.t > b + frame / 2);
  next = mark(next, a, present, frame);
  if (after !== null) next = mark(next, b, after, frame);
  return next;
}

export type Interval = { start: number; end: number };

export function intervals(bs: Boundary[], duration: number, present: boolean): Interval[] {
  const out: Interval[] = [];
  bs.forEach((b, i) => {
    if (b.present !== present) return;
    const end = i + 1 < bs.length ? bs[i + 1].t : duration;
    if (end - b.t > 0.02) out.push({ start: b.t, end });
  });
  return out;
}

// Everything not marked present (absent + never marked).
export function notPresent(bs: Boundary[], duration: number): Interval[] {
  const pres = intervals(bs, duration, true);
  const out: Interval[] = [];
  let t = 0;
  for (const p of pres) {
    if (p.start - t > 0.02) out.push({ start: t, end: p.start });
    t = p.end;
  }
  if (duration - t > 0.02) out.push({ start: t, end: duration });
  return out;
}

export const total = (xs: Interval[]) => xs.reduce((s, x) => s + (x.end - x.start), 0);

export function nearest(cuts: number[] | null, t: number, within: number): number | null {
  if (!cuts?.length) return null;
  let best: number | null = null;
  for (const c of cuts) if (Math.abs(c - t) <= within && (best === null || Math.abs(c - t) < Math.abs(best - t))) best = c;
  return best;
}

// ---- shots ----------------------------------------------------------------

// Present spans split at scene cuts. Group assignments carry over from the old
// shot list by largest overlap, so re-spotting doesn't throw away grouping work.
export function buildShots(p: Project): Shot[] {
  const pres = intervals(p.boundaries, p.duration, true);
  const cuts = p.cuts ?? [];
  const minLen = 2 / p.fps;
  const pieces: Interval[] = [];
  for (const iv of pres) {
    let s = iv.start;
    for (const c of cuts) {
      if (c > s + minLen && c < iv.end - minLen) {
        pieces.push({ start: s, end: c });
        s = c;
      }
    }
    pieces.push({ start: s, end: iv.end });
  }
  return pieces
    .filter((x) => x.end - x.start >= minLen)
    .map((x) => {
      let best: Shot | null = null;
      let bestOv = 0;
      for (const o of p.shots) {
        const ov = Math.min(o.end, x.end) - Math.max(o.start, x.start);
        if (ov > bestOv) {
          bestOv = ov;
          best = o;
        }
      }
      const same = best && Math.abs(best.start - x.start) < 0.01 && Math.abs(best.end - x.end) < 0.01;
      return {
        id: same ? best!.id : uid(),
        start: x.start,
        end: x.end,
        groupId: best?.groupId ?? null,
        thumb: same ? best!.thumb : undefined,
      };
    });
}

// ---- parts ----------------------------------------------------------------

export const MIN_CLIP = 5.2; // H3 needs >= 5 s
export const MAX_CLIP = 28; // H3 takes <= 30 s
export const MAX_RUN = 14; // and no single continuous shot over ~14.7 s

// Split a group's shots into renderable parts and add looped filler where a part is
// shorter than the minimum. Existing results are kept when a part's footage is unchanged.
export function buildParts(p: Project, groupId: string): Part[] {
  const shots = p.shots.filter((s) => s.groupId === groupId).sort((a, b) => a.start - b.start);
  const parts: { pieces: PartPiece[]; duration: number }[] = [];
  let cur: { pieces: PartPiece[]; duration: number } = { pieces: [], duration: 0 };
  let run = 0;
  const flush = () => {
    if (cur.pieces.length) parts.push(cur);
    cur = { pieces: [], duration: 0 };
    run = 0;
  };
  for (const s of shots) {
    let a = s.start;
    while (a < s.end - 1e-3) {
      const last = cur.pieces[cur.pieces.length - 1];
      const contiguous = last && Math.abs(last.end - a) < 1e-3;
      if (!contiguous) run = 0;
      const room = Math.min(MAX_CLIP - cur.duration, MAX_RUN - run);
      if (room < 0.5) {
        flush();
        continue;
      }
      const b = Math.min(s.end, a + room);
      cur.pieces.push({ shotId: s.id, start: a, end: b, offset: cur.duration });
      cur.duration += b - a;
      run += b - a;
      a = b;
    }
  }
  flush();

  const old = p.parts.filter((x) => x.groupId === groupId);
  return parts.map((pt) => {
    const pad: { start: number; end: number }[] = [];
    let len = pt.duration;
    let i = 0;
    while (len < MIN_CLIP && pt.pieces.length) {
      const src = pt.pieces[i % pt.pieces.length];
      const take = Math.min(src.end - src.start, MIN_CLIP - len);
      pad.push({ start: src.start, end: src.start + take });
      len += take;
      i++;
    }
    const key = pt.pieces.map((x) => `${x.start.toFixed(3)}-${x.end.toFixed(3)}`).join("|");
    const prev = old.find((o) => o.pieces.map((x) => `${x.start.toFixed(3)}-${x.end.toFixed(3)}`).join("|") === key);
    return prev
      ? { ...prev, pieces: pt.pieces, pad, duration: pt.duration, clipLength: len }
      : { id: uid(), groupId, pieces: pt.pieces, pad, duration: pt.duration, clipLength: len, status: "idle" as const };
  });
}

export function signature(part: Part, group: Group) {
  return [
    part.pieces.map((x) => `${x.start.toFixed(3)}-${x.end.toFixed(3)}`).join("|"),
    group.prompt,
    group.modelId,
    group.refs.map((r) => `${r.name}:${r.blob.size}`).join(","),
  ].join("#");
}

// ---- formatting -----------------------------------------------------------

export const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};
export const fmtShort = (s: number) => `${s.toFixed(1)}s`;
