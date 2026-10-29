"use client";

import { CUT_BELOW, similarity } from "./sync";

// Reads a dropped video entirely in the browser: finds the scene cuts, looks at a few
// frames of every shot, and groups the faces it sees into people. Nothing is uploaded.
// Face models (face-api, ~12 MB) are served from /models and cached by the browser.

export type Shot = { start: number; end: number };
export type Person = {
  id: string;
  face: string; // a square crop, as a data URL
  descriptor: Float32Array; // mean face descriptor, for matching photos
  shots: number[]; // indices into Reading.shots
  seconds: number; // time on screen, summed over those shots
};
export type Reading = { duration: number; width: number; height: number; shots: Shot[]; people: Person[] };
export type Progress = { stage: "cuts" | "faces"; ratio: number; label: string };

const SCAN_FPS = 5; // cut scan resolution; plenty to group shots for a choice of who to replace
const MIN_SHOT = 0.4;
const SAME_PERSON = 0.5; // face-api descriptor distance; 0.6 is its loose default
const MIN_FACE = 0.06; // ignore faces smaller than this share of the frame height

type FaceApi = typeof import("@vladmandic/face-api");
let api: Promise<FaceApi> | null = null;
export function faceApi() {
  api ??= (async () => {
    const f = await import("@vladmandic/face-api");
    await Promise.all([
      f.nets.ssdMobilenetv1.loadFromUri("/models"),
      f.nets.faceLandmark68Net.loadFromUri("/models"),
      f.nets.faceRecognitionNet.loadFromUri("/models"),
    ]);
    return f;
  })();
  return api;
}

const distance = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
};

async function openVideo(file: File) {
  const v = document.createElement("video");
  v.src = URL.createObjectURL(file);
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  await new Promise<void>((res, rej) => {
    v.onloadeddata = () => res();
    v.onerror = () => rej(new Error("This browser can’t play that file. An MP4 works everywhere."));
  });
  if (!v.videoWidth || !Number.isFinite(v.duration)) throw new Error("This browser can’t play that file. An MP4 works everywhere.");
  const seek = (t: number) =>
    new Promise<void>((r) => {
      v.onseeked = () => r();
      v.currentTime = Math.min(Math.max(0, t), v.duration - 0.01);
    });
  return { v, seek, close: () => URL.revokeObjectURL(v.src) };
}

function luma(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const y = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) y[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  return y;
}

// A square crop around a face box, loosened so it reads as a portrait.
function crop(src: HTMLCanvasElement, box: { x: number; y: number; width: number; height: number }) {
  const side = Math.min(Math.max(box.width, box.height) * 1.9, src.width, src.height);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const x = Math.min(Math.max(0, cx - side / 2), src.width - side);
  const y = Math.min(Math.max(0, cy - side / 2), src.height - side);
  const c = document.createElement("canvas");
  c.width = c.height = 192;
  c.getContext("2d")!.drawImage(src, x, y, side, side, 0, 0, 192, 192);
  return c.toDataURL("image/jpeg", 0.86);
}

export async function readVideo(file: File, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<Reading> {
  const { v, seek, close } = await openVideo(file);
  try {
    const duration = v.duration;

    // 1. Cuts: compare small luma frames a fifth of a second apart.
    const small = document.createElement("canvas");
    small.width = 64;
    small.height = 36;
    const sctx = small.getContext("2d", { willReadFrequently: true })!;
    const steps = Math.max(1, Math.floor(duration * SCAN_FPS));
    const cuts: number[] = [0];
    let prev: Uint8ClampedArray | null = null;
    for (let i = 0; i <= steps; i++) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const t = i / SCAN_FPS;
      await seek(t);
      sctx.drawImage(v, 0, 0, 64, 36);
      const y = luma(sctx, 64, 36);
      if (prev && similarity(prev, y) < CUT_BELOW && t - cuts[cuts.length - 1] >= MIN_SHOT) cuts.push(t - 0.5 / SCAN_FPS);
      prev = y;
      if (i % 5 === 0) onProgress({ stage: "cuts", ratio: i / steps, label: `Finding scene cuts · ${Math.round(t)} of ${Math.round(duration)} s` });
    }
    const shots: Shot[] = cuts.map((s, i) => ({ start: s, end: cuts[i + 1] ?? duration }));

    // 2. Faces: up to three frames per shot, at a working size of 960 px wide.
    onProgress({ stage: "faces", ratio: 0, label: "Loading face recognition" });
    const f = await faceApi();
    const scale = Math.min(1, 960 / v.videoWidth);
    const big = document.createElement("canvas");
    big.width = Math.round(v.videoWidth * scale);
    big.height = Math.round(v.videoHeight * scale);
    const bctx = big.getContext("2d", { willReadFrequently: true })!;
    const options = new f.SsdMobilenetv1Options({ minConfidence: 0.55 });

    type Group = { sum: Float32Array; n: number; shots: Set<number>; best: number; face: string };
    const groups: Group[] = [];
    for (let s = 0; s < shots.length; s++) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const { start, end } = shots[s];
      const len = end - start;
      const at = len < 1.2 ? [0.5] : [0.2, 0.5, 0.8];
      for (const r of at) {
        await seek(start + len * r);
        bctx.drawImage(v, 0, 0, big.width, big.height);
        const found = await f.detectAllFaces(big, options).withFaceLandmarks().withFaceDescriptors();
        for (const d of found) {
          const box = d.detection.box;
          if (box.height < big.height * MIN_FACE) continue;
          const quality = box.width * box.height * d.detection.score;
          let g = groups.find((x) => distance(mean(x), d.descriptor) < SAME_PERSON);
          if (!g) {
            g = { sum: new Float32Array(d.descriptor.length), n: 0, shots: new Set(), best: 0, face: "" };
            groups.push(g);
          }
          for (let i = 0; i < d.descriptor.length; i++) g.sum[i] += d.descriptor[i];
          g.n++;
          g.shots.add(s);
          if (quality > g.best) {
            g.best = quality;
            g.face = crop(big, box);
          }
        }
      }
      onProgress({ stage: "faces", ratio: (s + 1) / shots.length, label: `Looking for people · shot ${s + 1} of ${shots.length}` });
    }

    // Merge groups that drifted apart, then keep the people seen more than once.
    for (let i = 0; i < groups.length; i++)
      for (let j = groups.length - 1; j > i; j--) {
        if (distance(mean(groups[i]), mean(groups[j])) >= SAME_PERSON) continue;
        const [a, b] = [groups[i], groups[j]];
        for (let k = 0; k < a.sum.length; k++) a.sum[k] += b.sum[k];
        a.n += b.n;
        b.shots.forEach((x) => a.shots.add(x));
        if (b.best > a.best) [a.best, a.face] = [b.best, b.face];
        groups.splice(j, 1);
      }
    const people = groups
      .filter((g) => g.n > 1 || groups.length <= 3)
      .map((g, i) => {
        const list = [...g.shots].sort((a, b) => a - b);
        return {
          id: `p${i}`,
          face: g.face,
          descriptor: mean(g),
          shots: list,
          seconds: list.reduce((t, s) => t + shots[s].end - shots[s].start, 0),
        };
      })
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 8);

    return { duration, width: v.videoWidth, height: v.videoHeight, shots, people };
  } finally {
    close();
  }
}

function mean(g: { sum: Float32Array; n: number }) {
  const m = new Float32Array(g.sum.length);
  for (let i = 0; i < m.length; i++) m[i] = g.sum[i] / g.n;
  return m;
}

// Checks one reference photo: one clear face, big enough, not too dark, and (when given)
// the same person as the photos before it.
export type PhotoCheck = { ok: boolean; note: string; descriptor?: Float32Array };
export async function checkPhoto(file: File, sameAs?: Float32Array): Promise<PhotoCheck> {
  const f = await faceApi();
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const found = await f.detectAllFaces(c, new f.SsdMobilenetv1Options({ minConfidence: 0.5 })).withFaceLandmarks().withFaceDescriptors();
    if (!found.length) return { ok: false, note: "No face found" };
    if (found.length > 1) return { ok: false, note: "More than one face. Crop to one person" };
    const d = found[0];
    const box = d.detection.box;
    const y = luma(ctx, c.width, c.height);
    const light = y.reduce((s, x) => s + x, 0) / y.length;
    if (sameAs && distance(sameAs, d.descriptor) > 0.6) return { ok: false, note: "Looks like a different person", descriptor: d.descriptor };
    if (box.height < Math.min(c.width, c.height) * 0.12) return { ok: true, note: "Face is small. A closer photo works better", descriptor: d.descriptor };
    if (light < 55) return { ok: true, note: "A bit dark. Even light works better", descriptor: d.descriptor };
    return { ok: true, note: "Good photo", descriptor: d.descriptor };
  } finally {
    URL.revokeObjectURL(url);
  }
}
