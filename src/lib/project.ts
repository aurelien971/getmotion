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

export type LibFace = { id: string; file: StoredFile; label: string };

// A prompt written by Claude for one render clip, from that clip's own scenes.
export type ScenePrompt = {
  prompt: string;
  target: string;
  scenes: { time: string; shot: string; where: string; action: string; visibility: string; decoys?: string }[];
  warnings: string[];
  present?: number[]; // swapped people (index into wardrobe.others) Claude saw in this clip and wrote into the prompt
  at: number;
  edited?: boolean;
};

export type Group = {
  partPrompts?: Record<string, ScenePrompt>; // by partKey
  accepted?: Interval[]; // leftover footage the user validated as fine without a render
  frameSwaps?: Record<string, Record<number, string>>;
  swapPrompts?: Record<string, { all?: string; frames?: Record<number, string> }>;
  swapMode?: Record<string, "swap" | "edit">; // by partKey: swap people in, or edit the frame only (no reference photos)
  swapInput?: Record<string, boolean>;
  swapRegion?: Record<string, { x: number; y: number; w: number; h: number }>; // by partKey: only this box (0-1 of the frame) is edited // by partKey: render from the edited frames instead of the original // by partKey: your edits to the frame-swap prompt // by partKey: clip frame → swapped image URL (Inspect → Swap)
  partPeople?: Record<string, number[]>; // by partKey: which swapped people (index into wardrobe.others) this render includes
  id: string;
  name: string;
  description: string;
  color: string;
  refs: StoredFile[]; // legacy, migrated into the library on load
  refIds?: string[]; // faces from the library for this look; empty = the project default
  promptEdited?: boolean; // typed by hand: never overwritten automatically
  notes: string;
  prompt: string;
  modelId: string;
  oneShot?: boolean; // render every shot on its own clip (padded with itself), never several shots per render
  wardrobe?: Wardrobe;
};

export type WardrobeItem = { label: string; on: boolean };
// target: what he wears in this look (on = keep it); reference: what the photo has (on = take it).
export type Wardrobe = {
  target: WardrobeItem[];
  reference: WardrobeItem[];
  alone?: boolean; // he's the only person in every shot of this look
  faceHidden?: boolean; // some frames hide his face (looking down, brim, turned away)
  eyewear?: boolean; // sunglasses/glasses in this look
  performance?: string; // what he does: "raps to camera with hand gestures"
  refKey?: string; // which photos this analysis was made with
  others?: OtherPerson[]; // other people in this look; faceId set = replace them too
};

export type OtherPerson = {
  label: string;
  faceId?: string; // set = replace this person with that library photo
  thumb?: string; // cropped picture of them (data URL)
  wears?: string[]; // their visible clothing, from the look analysis
  wardrobe?: { target: WardrobeItem[]; reference: WardrobeItem[] }; // keep / take for their swap
};

const TOPS = /hoodie|tee|t-shirt|shirt|sweatshirt|jacket|coat|suit|top|jersey|vest|sweater|blazer/i;

export function wardrobeClashes(w: Wardrobe): string[] {
  const keepTops = w.target.filter((x) => x.on && TOPS.test(x.label)).map((x) => x.label);
  const takeTops = w.reference.filter((x) => x.on && TOPS.test(x.label)).map((x) => x.label);
  return keepTops.length && takeTops.length
    ? [`Keeping ${keepTops.join(", ")} while taking ${takeTops.join(", ")}: the tops will fight each other.`]
    : [];
}

const KEEP_BY_DEFAULT = /sunglass|glasses|shades|chain|necklace|pendant|earring|stud|watch|ring|bracelet|grill/i;
const HAIR_OR_FACE = /^face$|hair|beard|stubble|mustache|moustache/i;

// Default ticks: with an outfit in the photo, keep his jewelry and eyewear and
// replace his clothes; with a face-only photo, keep everything he wears.
export function defaultTicks(target: string[], reference: string[]): Wardrobe {
  const outfit = reference.some((r) => !HAIR_OR_FACE.test(r));
  return {
    target: target.map((label) => ({ label, on: !outfit || KEEP_BY_DEFAULT.test(label) })),
    reference: reference.map((label) => ({ label, on: true })),
  };
}

export function wardrobePrompt(description: string, w: Wardrobe | undefined, refCount: number): string {
  const swaps = (w?.others ?? []).filter((o) => o.faceId);
  const alone = !!w?.alone && !(w?.others ?? []).length;
  const take = (w?.reference ?? []).filter((x) => x.on && !/^face$/i.test(x.label)).map((x) => x.label.toLowerCase());
  const hair = take.filter((x) => HAIR_OR_FACE.test(x));
  const outfit = take.filter((x) => !HAIR_OR_FACE.test(x));
  // His own hair and beard go with the new face; they're not wardrobe.
  const worn = (w?.target ?? []).filter((x) => !HAIR_OR_FACE.test(x.label));
  const keep = worn.filter((x) => x.on).map((x) => x.label.toLowerCase());
  const drop = worn.filter((x) => !x.on).map((x) => x.label.toLowerCase());
  const who = refCount > 1 ? `the man in reference images 1 to ${refCount} (all the same person)` : "the man in reference image 1";
  const list = (xs: string[], and = "and") => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${and} ${xs[xs.length - 1]}`);

  const lines: string[] = [];
  if (alone) lines.push("He is the only person in every shot of this clip.");
  else
    lines.push(
      `The man to replace appears in every single shot of this clip. ${description}`.trim(),
      ...(w?.eyewear || w?.faceHidden
        ? ["He is the same person in every shot, even when sunglasses, a hat or a turned head hide part of his face."]
        : []),
    );
  lines.push(
    `Replace him with ${who}: ${list(["his face, identity", ...hair])}${outfit.length ? `, wearing a ${list(outfit)}` : ""}.`,
  );
  // Models keep the original's bare arms unless told the new sleeves cover them.
  if (outfit.some((x) => /suit|jacket|blazer|coat|long[- ]sleeve|dress shirt/.test(x)))
    lines.push("His arms are covered by the long jacket and shirt sleeves down to the wrists in every frame; no bare arms, no short sleeves.");
  if (keep.length) lines.push(`Keep ${list(keep)} exactly as in the original${outfit.length ? ", over the new outfit" : ""}.`);
  if (drop.length)
    lines.push(
      outfit.length
        ? `No ${list(drop, "or")}: none of the original outfit stays visible.`
        : `Remove ${list(drop)}.`,
    );
  lines.push(
    `Match the original performance exactly: perfect lip-sync to the vocals, the same mouth shapes, facial expressions, hand gestures, arm movements and head turns${
      w?.faceHidden ? ", including the frames where he looks down or turns away" : ""
    }${w?.performance ? ` (${w.performance})` : ""}.`,
  );
  swaps.forEach((o, k) => {
    const n = refCount + k + 1;
    const ow = o.wardrobe;
    const oTake = (ow?.reference ?? []).filter((x) => x.on && !/^face$/i.test(x.label)).map((x) => x.label.toLowerCase());
    const oOutfit = oTake.filter((x) => !HAIR_OR_FACE.test(x));
    const oKeep = (ow?.target ?? []).filter((x) => x.on && !HAIR_OR_FACE.test(x.label)).map((x) => x.label.toLowerCase());
    const who = o.label.replace(/^(a|an|the) /i, "");
    lines.push(
      ow
        ? `Also replace one other person (${who}) with the person in reference image ${n}: their face and identity${
            oOutfit.length ? `, wearing a ${list(oOutfit)}` : ""
          }${oKeep.length ? `; keep ${list(oKeep)} from the original` : ""}${
            !oOutfit.length ? "; keep that person's clothing" : ""
          }, and keep that person's position and movements.`
        : `Also replace one other person (${who}) with the person in reference image ${n}, keeping that person's clothing, position and movements.`,
    );
  });
  lines.push(
    alone
      ? "Keep the background, camera motion, framing, lighting and color grade unchanged."
      : `${swaps.length ? "Everyone else" : "Everyone else, including the other people,"} the background, camera motion, framing, lighting and color grade stay unchanged.`,
  );
  return lines.join(" ");
}

export type PartPiece = { shotId: string; start: number; end: number; offset: number };

export type PartStatus = "idle" | "building" | "uploading" | "rendering" | "done" | "failed";

export type Part = {
  id: string;
  groupId: string;
  pieces: PartPiece[]; // real footage, in clip order, with offset into the clip
  pad: { start: number; end: number; reverse?: boolean }[]; // filler to reach the model's minimum length: the footage played backward and forward, so it never cuts
  duration: number; // real footage length
  clipLength: number; // real + filler
  status: PartStatus;
  progress?: number;
  live?: string; // provider status while rendering
  rerollOf?: string; // the finished part this re-roll is a new take of
  issuesVerified?: boolean; // issues confirmed on the original (flares dropped, counts from the real cut)
  submittedAt?: number;
  endpoint?: string;
  requestId?: string;
  resultUrl?: string;
  error?: string;
  renderedAt?: number;
  signature?: string; // pieces + prompt + refs; a change marks the result stale
  // Where each piece actually starts inside the render, found from the render's own
  // scene cuts. Corrects clips that carried a stray frame. Undefined = not measured.
  measuredOffsets?: number[];
  edges?: { head: number; tail: number }[]; // junk render frames at each piece's start / end, held over
  linedUp?: boolean; // measured frame by frame against the original
  edgesV?: number; // version of the edge-glitch check that ran on this render
  calibrated?: boolean;
  issues?: Issue[]; // stray footage found by the pre-flight check
  checkedKey?: string; // pieces the last clean check was for
  rejected?: number[]; // piece indices marked Redo after review
  deleted?: number[]; // takes deleted as failed renders: gone from review, footage counts as unrendered
  trims?: Record<number, { start: number; end: number }>; // kept source range of a piece after review
  reviewed?: number[]; // pieces confirmed in review ("Use this take")
  ignored?: number[]; // source times of flagged cuts confirmed as false alarms
  unused?: number[]; // pieces parked because another take of the same footage is used
};

// A piece counts toward the video unless it was redone or parked for another take.
export const pieceLive = (pt: Part, j: number) => !pt.rejected?.includes(j) && !pt.unused?.includes(j) && !pt.deleted?.includes(j);

export type Take = { part: Part; j: number; range: Interval; at: number; live: boolean; reviewed: boolean; rejected: boolean };

// Every rendered take that overlaps a span of source footage, oldest first.
export function takesFor(p: Project, r: Interval): Take[] {
  const out: Take[] = [];
  for (const pt of p.parts) {
    if (pt.status !== "done" || !pt.resultUrl) continue;
    pt.pieces.forEach((_, j) => {
      if (pt.deleted?.includes(j)) return;
      const k = keptRange(pt, j);
      if (k.end <= r.start + 1e-3 || k.start >= r.end - 1e-3) return;
      out.push({
        part: pt,
        j,
        range: k,
        at: pt.renderedAt ?? 0,
        live: pieceLive(pt, j),
        reviewed: !!pt.reviewed?.includes(j),
        rejected: !!pt.rejected?.includes(j),
      });
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

// The source range a piece actually contributes (its trim, if reviewed).
export const keptRange = (pt: Part, j: number) => pt.trims?.[j] ?? { start: pt.pieces[j].start, end: pt.pieces[j].end };

// Junk frames still inside the kept range of a piece (a trim may already cut them off).
export function edgeJunk(pt: Part, j: number, fps: number) {
  const e = pt.edges?.[j];
  if (!e) return { head: 0, tail: 0 };
  const k = keptRange(pt, j);
  const pc = pt.pieces[j];
  return {
    head: Math.max(0, e.head - Math.round((k.start - pc.start) * fps)),
    tail: Math.max(0, e.tail - Math.round((pc.end - k.end) * fps)),
  };
}

// Footage from another scene inside a piece, found as an unplanned cut in the built clip.
export type Issue = { shotId: string; at: number; kind: "start" | "end" | "mid"; frames: number };

export const partKey = (pt: Part) => pt.pieces.map((x) => `${x.start.toFixed(4)}-${x.end.toFixed(4)}`).join("|");

// Compare the cuts found in a built clip with the cuts the plan expects (between
// non-contiguous pieces). Any other cut means foreign frames inside a piece.
export function findIssues(part: Part, cuts: number[], fps: number): Issue[] {
  const f = 1 / fps;
  const expected: number[] = [];
  part.pieces.forEach((pc, i) => {
    if (i > 0 && Math.abs(part.pieces[i - 1].end - pc.start) > 1e-3) expected.push(pc.offset);
  });
  const issues: Issue[] = [];
  for (const c of cuts) {
    if (c < 0.5 * f || c > part.duration - 0.5 * f) continue; // clip start, or loop filler
    if (expected.some((e) => Math.abs(e - c) <= 1.5 * f)) continue;
    const j = part.pieces.findIndex((pc) => c > pc.offset && c < pc.offset + (pc.end - pc.start));
    if (j < 0) continue;
    const pc = part.pieces[j];
    const toStart = Math.round((c - pc.offset) * fps);
    const toEnd = Math.round((pc.offset + (pc.end - pc.start) - c) * fps);
    const at = Math.round((pc.start + (c - pc.offset)) * fps) / fps;
    issues.push(
      toStart <= 4
        ? { shotId: pc.shotId, at, kind: "start", frames: toStart }
        : toEnd <= 4
          ? { shotId: pc.shotId, at, kind: "end", frames: toEnd }
          : { shotId: pc.shotId, at, kind: "mid", frames: 0 },
    );
  }
  return issues;
}

// Line pieces up with the cuts found in the render. A piece that follows a hard cut
// starts on the detected cut nearest its planned offset (within ±4 frames); a piece
// continuing the same shot follows the previous piece directly.
export function measureOffsets(part: Part, cuts: number[], fps: number): number[] {
  const out: number[] = [];
  const win = 4 / fps;
  part.pieces.forEach((pc, i) => {
    if (i === 0) return out.push(0);
    const prev = part.pieces[i - 1];
    const follow = out[i - 1] + (prev.end - prev.start);
    const contiguous = Math.abs(prev.end - pc.start) < 1e-3;
    if (contiguous) return out.push(follow);
    // A stray frame from another scene makes two cuts (into it and out of it); the
    // piece starts after the last one, so take the latest cut in the window.
    const near = cuts.filter((c) => Math.abs(c - follow) <= win);
    out.push(near.length ? Math.max(...near) : follow);
  });
  return out;
}


// Frame accounting for an export, against the original span.
export type ExportReport = {
  span: Interval;
  fps: number;
  size: { w: number; h: number };
  expected: number; // frames in the original span
  out: number; // frames in the exported file
  approved: number; // rendered frames from validated / reviewed takes
  unreviewed: number; // rendered frames not reviewed yet
  held: number; // 1-2 frame gaps and junk frames filled with the neighbouring rendered frame
  himOriginal: number; // frames of him left as the original (not rendered, kept original)
  others: number; // frames without him (original)
};

export type Step = "source" | "spot" | "scenes" | "render" | "assemble";

export type Project = {
  name: string;
  source?: StoredFile; // as dropped (may be AV1/HEVC; the browser plays it)
  prepared?: StoredFile; // H.264 copy for cutting
  codec?: string | null;
  duration: number;
  fps: number;
  fpsProbed?: boolean; // fps read from the container (not guessed)
  width: number;
  height: number;
  hasAudio: boolean;
  boundaries: Boundary[];
  watched: number; // furthest point reviewed while spotting
  cuts: number[] | null; // null = not detected yet; times on the original file
  preparedOffset?: number; // copy time = original time + offset (converted copies drift a couple of frames)
  shots: Shot[];
  groups: Group[];
  parts: Part[];
  step: Step;
  output?: StoredFile;
  outputReport?: ExportReport;
  range?: Interval; // the span being rendered now; all renders are kept across spans
  library?: LibFace[]; // every reference photo for this project
  trash?: (Part & { trashedAt: number })[]; // deleted renders, restorable
  defaultRefs?: string[]; // library ids used by looks that don't pick their own
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

// Union of the source spans already covered by renders (done or in flight).
export function covered(p: Project, groupId?: string): Interval[] {
  const xs = p.parts
    .filter((x) => (groupId ? x.groupId === groupId : true))
    .filter((x) => x.status === "done" || x.status === "rendering" || x.status === "building" || x.status === "uploading")
    // A render whose shot edges changed no longer counts: its footage gets a fresh part.
    .filter((x) => !(x.status === "done" && renderOutdated(p, x)))
    .flatMap((x) =>
      x.pieces.flatMap((_, j) => (pieceLive(x, j) ? [keptRange(x, j)] : [])),
    );
  return merge(xs);
}

export function merge(xs: Interval[]): Interval[] {
  const s = [...xs].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end + 1e-4) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

// a minus b
export function subtract(a: Interval[], b: Interval[]): Interval[] {
  let out = a.map((x) => ({ ...x }));
  for (const cut of b) {
    const next: Interval[] = [];
    for (const x of out) {
      if (cut.end <= x.start || cut.start >= x.end) next.push(x);
      else {
        if (cut.start > x.start) next.push({ start: x.start, end: cut.start });
        if (cut.end < x.end) next.push({ start: cut.end, end: x.end });
      }
    }
    out = next;
  }
  return out.filter((x) => x.end - x.start > 1e-3);
}

export const clipTo = (xs: Interval[], r: Interval) =>
  xs.map((x) => ({ start: Math.max(x.start, r.start), end: Math.min(x.end, r.end) })).filter((x) => x.end - x.start > 1e-3);

// What still needs rendering for one look inside the span, as shot pieces.
export function pending(p: Project, groupId: string): { shotId: string; start: number; end: number }[] {
  const range = p.range ?? { start: 0, end: p.duration };
  const accepted = p.groups.find((g) => g.id === groupId)?.accepted ?? [];
  const done = merge([...covered(p, groupId), ...accepted]);
  const out: { shotId: string; start: number; end: number }[] = [];
  for (const s of p.shots.filter((x) => x.groupId === groupId).sort((a, b) => a.start - b.start)) {
    for (const piece of subtract(clipTo([{ start: s.start, end: s.end }], range), done)) {
      // 1-2 frame slivers (left by trims) are held over at assembly, never rendered.
      if (piece.end - piece.start > 2.5 / p.fps) out.push({ shotId: s.id, ...piece });
    }
  }
  return out;
}

// Split what's pending for a look into renderable parts (H3 limits), loop short
// parts up to the minimum, and keep renders that already exist.
// Filler up to the model's minimum: the clip played backward from its last frame, then
// forward again, and so on. Motion just reverses, so there is never a cut to lose him at.
// Turnaround frames aren't repeated. The filler is thrown away after rendering.
export function pingPong(pieces: { start: number; end: number }[], duration: number, f: number) {
  // Stay one frame clear of every shot edge: a converted copy's timing can jitter by a
  // frame, and a filler pass must never run into the neighbouring shot (that's a cut).
  const inner = pieces.map((pc) => (pc.end - pc.start >= 4 * f ? { start: pc.start + f, end: pc.end - f } : pc));
  const pad: { start: number; end: number; reverse?: boolean }[] = [];
  let len = duration;
  let back = true;
  for (let pass = 0; len < MIN_CLIP - 1e-3 && inner.length && pass < 400; pass++) {
    const seq = back ? [...inner].reverse() : inner;
    for (let k = 0; k < seq.length && len < MIN_CLIP - 1e-3; k++) {
      const pc = seq[k];
      let a = pc.start;
      let b = pc.end;
      // Skip the frame we turned around on (the previous pass already showed it). The
      // first pass turns around on the real clip's last frame, which is outside `inner`.
      if (k === 0 && pass > 0) {
        if (back) b -= f;
        else a += f;
      }
      if (b - a < f / 2) continue;
      const need = MIN_CLIP - len;
      if (b - a > need) {
        if (back) a = b - need;
        else b = a + need;
      }
      pad.push(back ? { start: a, end: b, reverse: true } : { start: a, end: b });
      len += b - a;
    }
    back = !back;
  }
  return { pad, len };
}

export function buildParts(p: Project, groupId: string): Part[] {
  const todo = pending(p, groupId);
  const parts: { pieces: PartPiece[]; duration: number }[] = [];
  let cur: { pieces: PartPiece[]; duration: number } = { pieces: [], duration: 0 };
  let run = 0;
  const flush = () => {
    if (cur.pieces.length) parts.push(cur);
    cur = { pieces: [], duration: 0 };
    run = 0;
  };
  const oneShot = !!p.groups.find((g) => g.id === groupId)?.oneShot;
  for (const s of todo) {
    // One shot per render: every shot starts its own part.
    if (oneShot) flush();
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
      cur.pieces.push({ shotId: s.shotId, start: a, end: b, offset: cur.duration });
      cur.duration += b - a;
      run += b - a;
      a = b;
    }
  }
  flush();

  const keyOf = (pcs: PartPiece[]) => pcs.map((x) => `${x.start.toFixed(3)}-${x.end.toFixed(3)}`).join("|");
  const old = p.parts.filter((x) => x.groupId === groupId);
  const fresh = parts.map((pt) => {
    const { pad, len } = pingPong(pt.pieces, pt.duration, 1 / p.fps);
    const prev = old.find((o) => (o.status === "idle" || o.status === "failed") && keyOf(o.pieces) === keyOf(pt.pieces));
    return prev
      ? { ...prev, pad, clipLength: len }
      : { id: uid(), groupId, pieces: pt.pieces, pad, duration: pt.duration, clipLength: len, status: "idle" as const };
  });
  // Renders that exist (or are running) stay, whatever span is selected.
  // Re-roll copies stay whatever their state (only ✕ removes them), so a failed one shows why.
  const keep = old.filter((x) => (x.status !== "idle" && x.status !== "failed") || x.rerollOf);
  return [...keep, ...fresh];
}

// Parts relevant to the current span: new ones, plus existing renders overlapping it.
export function partsInRange(p: Project, groupId?: string): Part[] {
  const r = p.range ?? { start: 0, end: p.duration };
  return p.parts.filter(
    (x) => (!groupId || x.groupId === groupId) && x.pieces.some((pc) => pc.end > r.start + 1e-3 && pc.start < r.end - 1e-3),
  );
}

export function signature(part: Part, group: Group, refs: StoredFile[]) {
  return [
    part.pieces.map((x) => `${x.start.toFixed(3)}-${x.end.toFixed(3)}`).join("|"),
    group.prompt,
    group.modelId,
    refKey(refs),
    (group.wardrobe?.others ?? []).map((o) => o.faceId ?? "-").join(","),
  ].join("#");
}

export const refKey = (refs: StoredFile[]) => refs.map((r) => `${r.name}:${r.blob.size}`).join(",");

export function refsOf(p: Project, g: Group): StoredFile[] {
  const ids = g.refIds?.length ? g.refIds : (p.defaultRefs ?? []);
  return ids.map((id) => p.library?.find((f) => f.id === id)?.file).filter((f): f is StoredFile => !!f);
}

// ---- formatting -----------------------------------------------------------

export const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};
export const fmtShort = (s: number) => `${s.toFixed(1)}s`;

// Move an edge (a spotting mark and/or a scene cut sitting at `from`) to `to`.
export function moveEdge(
  boundaries: Boundary[],
  cuts: number[],
  from: number,
  to: number,
  tol: number,
): { boundaries: Boundary[]; cuts: number[] } {
  if (Math.abs(from - to) < 1e-6) return { boundaries, cuts };
  let hit = false;
  const b = boundaries.map((x) => (Math.abs(x.t - from) < tol ? ((hit = true), { ...x, t: to }) : x));
  const c = cuts.map((x) => (Math.abs(x - from) < tol ? ((hit = true), to) : x));
  if (!hit) c.push(to);
  b.sort((x, y) => x.t - y.t);
  return { boundaries: b, cuts: [...new Set(c)].sort((x, y) => x - y) };
}

// A finished render is outdated if any of its pieces is no longer fully inside a
// shot of the same look (edges were trimmed or shots moved after it was rendered).
export function renderOutdated(p: Project, part: Part): boolean {
  const shots = p.shots.filter((s) => s.groupId === part.groupId);
  const tol = 0.5 / p.fps;
  return part.pieces.some((_, j) => {
    if (!pieceLive(part, j)) return false;
    const r = keptRange(part, j);
    return !shots.some((s) => r.start >= s.start - tol && r.end <= s.end + tol);
  });
}

// Photos for the other people this look replaces, in prompt order (after the target's).
// Swapped people this part's render includes: your pick, else who Claude saw in the clip, else all.
export function partPeople(g: Group, part: Part): number[] {
  const key = partKey(part);
  const swapped = (g.wardrobe?.others ?? []).flatMap((o, i) => (o.faceId ? [i] : []));
  const pick = g.partPeople?.[key] ?? g.partPrompts?.[key]?.present;
  return pick ? pick.filter((i) => swapped.includes(i)) : swapped;
}

// The look as this part sees it: swapped people who aren't in it stay unchanged.
export function groupForPart(g: Group, part: Part): Group {
  if (!g.wardrobe?.others?.length) return g;
  const keep = partPeople(g, part);
  return {
    ...g,
    wardrobe: { ...g.wardrobe, others: g.wardrobe.others.map((o, i) => (o.faceId && !keep.includes(i) ? { ...o, faceId: undefined } : o)) },
  };
}

export function otherRefsOf(p: Project, g: Group): StoredFile[] {
  return (g.wardrobe?.others ?? [])
    .filter((o) => o.faceId)
    .map((o) => p.library?.find((f) => f.id === o.faceId)?.file)
    .filter((f): f is StoredFile => !!f);
}
