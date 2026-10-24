"use client";

import { fal } from "@fal-ai/client";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CompositePlayer } from "@/components/CompositePlayer";
import { EdgeEditor } from "@/components/EdgeEditor";
import { FrameStrip } from "@/components/FrameStrip";
import { RangePicker } from "@/components/RangePicker";
import { ReelPlayer } from "@/components/ReelPlayer";
import { SpotTrack } from "@/components/SpotTrack";
import { submitFal, submitSume, waitFor, removeJob, type PendingJob } from "@/lib/jobs";
import { MODELS } from "@/lib/models";
import {
  buildParts,
  buildShots,
  clipTo,
  covered,
  partsInRange,
  renderOutdated,
  measureOffsets,
  findIssues,
  partKey,
  keptRange,
  pieceLive,
  takesFor,
  type Issue,
  pending as pendingFor,
  emptyProject,
  fmt,
  fmtShort,
  GROUP_COLORS,
  intervals,
  mark,
  markSpan,
  moveEdge,
  nearest,
  notPresent,
  signature,
  stateAt,
  total,
  uid,
  type Group,
  type Part,
  type Project,
  type Shot,
  type Step,
  type StoredFile,
  type Wardrobe,
  defaultTicks,
  refKey,
  refsOf,
  otherRefsOf,
  wardrobeClashes,
  wardrobePrompt,
} from "@/lib/project";
import { kv } from "@/lib/store";
import { measureOffset, openReader, refineEdge } from "@/lib/sync";
import { assembleTimeline, buildClip, detectCuts, fileHasAudio, fpsExpr, probeVideo, warmUp } from "@/lib/trim";
import { transcodeInBrowser } from "@/lib/transcode";

fal.config({ proxyUrl: "/api/fal/proxy" });

const STEPS: { id: Step; label: string; hint: string }[] = [
  { id: "source", label: "Source", hint: "Drop the full video" },
  { id: "spot", label: "Spot", hint: "Mark where he's in frame" },
  { id: "scenes", label: "Scenes", hint: "Group shots by look" },
  { id: "render", label: "Render", hint: "One render per group" },
  { id: "assemble", label: "Assemble", hint: "Back on the original timeline" },
];

const RENDER_MODELS = MODELS.filter((m) => !m.usesMask && m.maxCast > 0);
const READABLE = new Set(["h264", "vp8", "vp9"]);

type Task = { label: string; pct: number | null };

function describe(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { message?: string; status?: number; body?: { detail?: unknown } };
    const d = o.body?.detail;
    const t = typeof d === "string" ? d : d ? JSON.stringify(d) : o.message;
    return `${o.status ? `HTTP ${o.status}: ` : ""}${t ?? String(e)}`;
  }
  return String(e);
}

// Frame rate from consecutive decoded frames (muted, off-screen).
async function detectFps(src: string): Promise<number> {
  const v = document.createElement("video");
  v.src = src;
  v.muted = true;
  v.playsInline = true;
  if (!("requestVideoFrameCallback" in v)) return 30;
  await new Promise<void>((r) => (v.onloadedmetadata = () => r()));
  return new Promise<number>((resolve) => {
    const times: number[] = [];
    const tick = (_: number, m: VideoFrameCallbackMetadata) => {
      times.push(m.mediaTime);
      if (times.length < 14) v.requestVideoFrameCallback(tick);
      else {
        v.pause();
        v.src = "";
        const d = times.slice(1).map((t, i) => t - times[i]).filter((x) => x > 0);
        const min = Math.min(...d);
        resolve(isFinite(min) ? Math.round((1 / min) * 1000) / 1000 : 30);
      }
    };
    v.requestVideoFrameCallback(tick);
    v.play().catch(() => resolve(30));
    setTimeout(() => resolve(30), 4000);
  });
}

async function toJpeg(file: Blob, name: string, max = 2048): Promise<StoredFile> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.92));
  return { blob, name: name.replace(/\.[^.]+$/, "") + ".jpg", type: "image/jpeg" };
}

// One frame per shot from the playable source, for review and for Claude.
async function grabThumbs(src: string, shots: Shot[], onProgress: (r: number) => void): Promise<Record<string, string>> {
  const v = document.createElement("video");
  v.src = src;
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  await new Promise<void>((res, rej) => {
    v.onloadedmetadata = () => res();
    v.onerror = () => rej(new Error("Could not read the video for thumbnails"));
  });
  const c = document.createElement("canvas");
  const w = 480;
  const h = Math.round((v.videoHeight / v.videoWidth) * w);
  c.width = w;
  c.height = h;
  const out: Record<string, string> = {};
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    await new Promise<void>((res) => {
      v.onseeked = () => res();
      v.currentTime = Math.min(s.end - 0.05, s.start + (s.end - s.start) * 0.4);
    });
    c.getContext("2d")!.drawImage(v, 0, 0, w, h);
    out[s.id] = c.toDataURL("image/jpeg", 0.8);
    onProgress((i + 1) / shots.length);
  }
  v.src = "";
  return out;
}

export default function Chapters() {
  const [p, setP] = useState<Project>(emptyProject());
  const [loaded, setLoaded] = useState(false);
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const setTask = (k: string, t: Task | null) =>
    setTasks((s) => {
      const n = { ...s };
      if (t) n[k] = t;
      else delete n[k];
      return n;
    });
  const update = useCallback((f: (p: Project) => Project) => setP((x) => f(x)), []);
  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast((t) => (t === m ? null : t)), 2200);
  };

  // ---- persistence ---------------------------------------------------------
  // Blobs are stored under their own keys so frequent state saves stay cheap.
  useEffect(() => {
    (async () => {
      try {
        const meta = await kv.get<Project>("chapters.meta");
        const source = await kv.get<StoredFile>("chapters.source");
        const prepared = await kv.get<StoredFile>("chapters.prepared");
        const output = await kv.get<StoredFile>("chapters.output");
        if (meta) {
          // Move per-look photos (older projects) into the shared face library.
          const library = [...(meta.library ?? [])];
          const groups = (meta.groups ?? []).map((g) => {
            if (!g.refs?.length) return g;
            const ids = g.refs.map((file) => {
              const id = uid();
              library.push({ id, file, label: file.name.replace(/\.[^.]+$/, "") });
              return id;
            });
            return { ...g, refs: [], refIds: [...(g.refIds ?? []), ...ids] };
          });
          // A library with photos but no default: the first photo becomes the default.
          const defaultRefs = meta.defaultRefs?.length ? meta.defaultRefs : library.length ? [library[0].id] : [];
          setP({ ...emptyProject(), ...meta, groups, library, defaultRefs, source, prepared, output });
        }
      } catch {}
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      const { source: _s, prepared: _p, output: _o, ...meta } = p;
      void _s;
      void _p;
      void _o;
      kv.set("chapters.meta", meta).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [p, loaded]);
  useEffect(() => {
    if (loaded) (p.source ? kv.set("chapters.source", p.source) : kv.del("chapters.source")).catch(() => {});
  }, [p.source, loaded]);
  useEffect(() => {
    if (loaded) (p.prepared ? kv.set("chapters.prepared", p.prepared) : kv.del("chapters.prepared")).catch(() => {});
  }, [p.prepared, loaded]);
  useEffect(() => {
    if (loaded) (p.output ? kv.set("chapters.output", p.output) : kv.del("chapters.output")).catch(() => {});
  }, [p.output, loaded]);

  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      (window as unknown as { __engine: unknown }).__engine = { buildClip, assembleTimeline, detectCuts, measureOffset, fpsExpr, measureOffsets, findIssues };
    }
  }, []);

  // Dev only: ?clip=/dev-long.mp4 loads a test file from /public.
  useEffect(() => {
    if (!loaded || process.env.NODE_ENV !== "development") return;
    const name = new URLSearchParams(window.location.search).get("clip");
    if (!name) return;
    fetch(name)
      .then((r) => r.blob())
      .then((b) => onSource(new File([b], name.split("/").pop() || "clip.mp4", { type: "video/mp4" })));
  }, [loaded]);

  const srcUrl = useMemo(() => (p.source ? URL.createObjectURL(p.source.blob) : null), [p.source]);
  const outUrl = useMemo(() => (p.output ? URL.createObjectURL(p.output.blob) : null), [p.output]);

  // ---- background preparation ---------------------------------------------
  // 1) H.264 copy for cutting (AV1/HEVC re-recorded in real time), 2) audio check,
  // 3) scene cuts. Each runs once; the user can spot while they run.
  const running = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (!loaded || !p.source || p.prepared || running.current.prepare) return;
    running.current.prepare = true;
    const source = p.source;
    (async () => {
      try {
        warmUp();
        setTask("prepare", { label: "Checking codec", pct: null });
        const info = await probeVideo(source.blob).catch(() => ({ codec: null, fps: null }));
        const codec = info.codec;
        if (info.fps) update((x) => ({ ...x, fps: info.fps!, fpsProbed: true }));
        if (codec && READABLE.has(codec)) {
          update((x) => ({ ...x, codec, prepared: source }));
        } else {
          setTask("prepare", { label: `Converting ${codec?.toUpperCase() ?? "video"} to H.264 · keep this tab visible`, pct: 0 });
          const out = await transcodeInBrowser(source.blob, (r) =>
            setTask("prepare", { label: `Converting ${codec?.toUpperCase() ?? "video"} to H.264 · keep this tab visible`, pct: r }),
          );
          update((x) => ({ ...x, codec, prepared: { blob: out, name: out.name, type: out.type } }));
        }
      } catch (e) {
        setError(`Preparing the video failed: ${describe(e)}`);
      } finally {
        setTask("prepare", null);
        running.current.prepare = false;
      }
    })();
  }, [loaded, p.source, p.prepared, update]);

  // Older projects guessed the frame rate; read it from the container once.
  useEffect(() => {
    if (!loaded || !p.source || p.fpsProbed || running.current.fps || running.current.prepare) return;
    running.current.fps = true;
    const source = p.source;
    probeVideo(source.blob)
      .then((info) => update((x) => ({ ...x, fps: info.fps ?? x.fps, fpsProbed: true })))
      .catch(() => update((x) => ({ ...x, fpsProbed: true })))
      .finally(() => (running.current.fps = false));
  }, [loaded, p.source, p.fpsProbed, update]);

  useEffect(() => {
    if (!loaded || !p.prepared || p.cuts !== null || running.current.cuts) return;
    running.current.cuts = true;
    const prepared = p.prepared;
    const source = p.source;
    const dur = p.duration;
    const fps = p.fps;
    (async () => {
      try {
        const audio = await fileHasAudio(prepared.blob).catch(() => true);
        update((x) => ({ ...x, hasAudio: audio }));
        let offset = 0;
        if (source && prepared.blob !== source.blob) {
          setTask("cuts", { label: "Aligning the converted copy", pct: null });
          const a = URL.createObjectURL(source.blob);
          const b = URL.createObjectURL(prepared.blob);
          try {
            offset = (await measureOffset(a, b, fps, dur)) ?? 0;
          } finally {
            URL.revokeObjectURL(a);
            URL.revokeObjectURL(b);
          }
        }
        update((x) => ({ ...x, preparedOffset: offset }));
        setTask("cuts", { label: "Finding scene cuts", pct: 0 });
        const raw = await detectCuts(prepared.blob, dur, (r) => setTask("cuts", { label: "Finding scene cuts", pct: r }));
        const cuts = raw.map((c) => Math.round((c - offset) * 1000) / 1000).filter((c) => c > 0);
        update((x) => ({ ...x, cuts }));
        flash(`${cuts.length} scene cuts found`);
      } catch (e) {
        setError(`Scene detection failed: ${describe(e)}`);
        update((x) => ({ ...x, cuts: [] }));
      } finally {
        setTask("cuts", null);
        running.current.cuts = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, p.prepared, p.cuts, p.duration, update]);

  // Older projects: measure the copy's offset once (cuts stay as they are; use Resync).
  useEffect(() => {
    if (!loaded || !p.source || !p.prepared || p.preparedOffset !== undefined || running.current.offset || p.cuts === null) return;
    running.current.offset = true;
    const a = URL.createObjectURL(p.source.blob);
    const b = URL.createObjectURL(p.prepared.blob);
    const same = p.source.blob === p.prepared.blob;
    (same ? Promise.resolve(0) : measureOffset(a, b, p.fps, p.duration))
      .then((off) => update((x) => ({ ...x, preparedOffset: off ?? 0 })))
      .catch(() => update((x) => ({ ...x, preparedOffset: 0 })))
      .finally(() => {
        URL.revokeObjectURL(a);
        URL.revokeObjectURL(b);
        running.current.offset = false;
      });
  }, [loaded, p.source, p.prepared, p.preparedOffset, p.cuts, p.fps, p.duration, update]);

  // ---- source ----------------------------------------------------------------
  async function onSource(file: File) {
    if (!file.type.startsWith("video/")) return;
    const url = URL.createObjectURL(file);
    const meta = await new Promise<{ d: number; w: number; h: number }>((res, rej) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => res({ d: v.duration, w: v.videoWidth, h: v.videoHeight });
      v.onerror = () => rej(new Error("This browser can't play that file."));
      v.src = url;
    }).catch((e) => {
      setError(String(e));
      return null;
    });
    const fps = meta ? await detectFps(url).catch(() => 30) : 30;
    URL.revokeObjectURL(url);
    if (!meta) return;
    await kv.del("chapters.prepared").catch(() => {});
    setP({
      ...emptyProject(),
      name: file.name.replace(/\.[^.]+$/, ""),
      source: { blob: file, name: file.name, type: file.type },
      duration: meta.d,
      width: meta.w,
      height: meta.h,
      fps,
      step: "spot",
    });
  }

  async function newProject() {
    if (!confirm("Start a new project? This clears the current one from this browser.")) return;
    await kv.del("chapters.meta").catch(() => {});
    await kv.del("chapters.source").catch(() => {});
    await kv.del("chapters.prepared").catch(() => {});
    await kv.del("chapters.output").catch(() => {});
    window.location.reload();
  }

  // ---- derived -----------------------------------------------------------------
  const present = intervals(p.boundaries, p.duration, true);
  const absent = notPresent(p.boundaries, p.duration);
  const presentLen = total(present);
  const unassigned = p.shots.filter((s) => !s.groupId);
  const groupedLen = total(p.shots.filter((s) => s.groupId));
  const partsDone = p.parts.filter((x) => x.status === "done").length;
  const reach: Record<Step, boolean> = {
    source: true,
    spot: !!p.source,
    scenes: !!p.source && presentLen > 0,
    render: p.shots.length > 0 && unassigned.length === 0 && p.groups.length > 0,
    assemble: partsDone > 0,
  };
  const go = (s: Step) => {
    if (!reach[s]) return;
    if (s === "render") return enterRender();
    update((x) => ({ ...x, step: s }));
  };

  // ---- scenes: shots, thumbs, grouping --------------------------------------
  async function enterScenes() {
    setError(null);
    const shots = buildShots(p);
    update((x) => ({ ...x, shots, step: "scenes" }));
    const missing = shots.filter((s) => !s.thumb);
    let withThumbs = shots;
    if (missing.length && srcUrl) {
      setTask("thumbs", { label: "Reading shots", pct: 0 });
      try {
        const map = await grabThumbs(srcUrl, missing, (r) => setTask("thumbs", { label: "Reading shots", pct: r }));
        withThumbs = shots.map((s) => (map[s.id] ? { ...s, thumb: map[s.id] } : s));
        update((x) => ({ ...x, shots: x.shots.map((s) => (map[s.id] ? { ...s, thumb: map[s.id] } : s)) }));
      } finally {
        setTask("thumbs", null);
      }
    }
    if (!p.groups.length || withThumbs.every((s) => !s.groupId)) await autoGroup(withThumbs);
  }

  async function autoGroup(shots: Shot[]) {
    setTask("group", { label: "Claude is grouping shots by look", pct: null });
    try {
      const res = await fetch("/api/group", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frames: shots.filter((s) => s.thumb).map((s) => ({ id: s.id, start: s.start, end: s.end, dataUrl: s.thumb })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      const groups: Group[] = (json.groups as { name: string; description: string; shotIds: string[] }[]).map((g, i) => ({
        id: uid(),
        name: g.name,
        description: g.description,
        color: GROUP_COLORS[i % GROUP_COLORS.length],
        refs: [],
        notes: "",
        prompt: "",
        modelId: "fal-ai/minimax-h3-max-recast",
      }));
      const byShot: Record<string, string> = {};
      (json.groups as { shotIds: string[] }[]).forEach((g, i) => g.shotIds.forEach((id) => (byShot[id] = groups[i].id)));
      update((x) => ({
        ...x,
        groups,
        parts: [],
        shots: x.shots.map((s) => ({ ...s, groupId: byShot[s.id] ?? null })),
      }));
      setSel(groups[0]?.id ?? "unassigned");
      flash(`${groups.length} looks found`);
    } catch (e) {
      setError(`Auto-grouping failed: ${describe(e)}. Group the shots by hand below.`);
    } finally {
      setTask("group", null);
    }
  }

  function addGroup(name = "New look"): string {
    const id = uid();
    update((x) => ({
      ...x,
      groups: [
        ...x.groups,
        {
          id,
          name,
          description: "",
          color: GROUP_COLORS[x.groups.length % GROUP_COLORS.length],
          refs: [],
          notes: "",
          prompt: "",
          modelId: "fal-ai/minimax-h3-max-recast",
        },
      ],
    }));
    return id;
  }
  const setShotGroup = (shotId: string, groupId: string | null) =>
    update((x) => ({ ...x, shots: x.shots.map((s) => (s.id === shotId ? { ...s, groupId } : s)) }));
  const patchGroup = (id: string, patch: Partial<Group>) =>
    update((x) => ({ ...x, groups: x.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }));
  const deleteGroup = (id: string) =>
    update((x) => ({
      ...x,
      groups: x.groups.filter((g) => g.id !== id),
      parts: x.parts.filter((pt) => pt.groupId !== id),
      shots: x.shots.map((s) => (s.groupId === id ? { ...s, groupId: null } : s)),
    }));

  // Flip a span between "him" and "not him" from the Scenes step, then rebuild shots.
  async function flipSpan(a: number, b: number, presentNow: boolean) {
    const frame = 1 / p.fps;
    const next = { ...p, boundaries: markSpan(p.boundaries, a, b, presentNow, frame) };
    const shots = buildShots(next);
    update(() => ({ ...next, shots }));
    const missing = shots.filter((s) => !s.thumb);
    if (missing.length && srcUrl) {
      const map = await grabThumbs(srcUrl, missing, () => {});
      update((x) => ({ ...x, shots: x.shots.map((s) => (map[s.id] ? { ...s, thumb: map[s.id] } : s)) }));
    }
  }

  // Move a shot's edges. An edge is either a spotting mark or a scene cut; moving it
  // moves that mark/cut, so the neighbouring shot follows and grouping is kept.
  async function moveEdges(shotId: string, newStart: number, newEnd: number) {
    const shot = p.shots.find((s) => s.id === shotId);
    if (!shot) return;
    const tol = 0.6 / p.fps;
    let st = { boundaries: p.boundaries, cuts: p.cuts ?? [] };
    st = moveEdge(st.boundaries, st.cuts, shot.start, newStart, tol);
    st = moveEdge(st.boundaries, st.cuts, shot.end, newEnd, tol);
    const next = { ...p, ...st };
    const shots = buildShots(next);
    const trimmed = shots.find((s) => Math.abs(s.start - newStart) < tol);
    if (trimmed) trimmed.groupId = shot.groupId;
    update(() => ({ ...next, shots }));
    await refreshThumbs(shots);
    flash("Edges saved");
  }

  async function refreshThumbs(shots: Shot[]) {
    const missing = shots.filter((s) => !s.thumb);
    if (missing.length && srcUrl) {
      const map = await grabThumbs(srcUrl, missing, () => {});
      update((x) => ({ ...x, shots: x.shots.map((s) => (map[s.id] ? { ...s, thumb: map[s.id] } : s)) }));
    }
  }

  // Re-find every edge on the original file: each edge snaps to the hard cut
  // within ±6 frames, if there is one. Edges already on a cut stay put.
  // groupId null = everything (all shot edges plus every detected cut);
  // "unassigned" = shots not in a look; "absent" = the edges of the not-in-frame spans.
  async function resync(groupId: string | null) {
    if (!srcUrl) return;
    const key = `resync-${groupId ?? "all"}`;
    const label =
      groupId === "absent"
        ? "Resyncing not-in-frame edges"
        : groupId === "unassigned"
          ? "Resyncing ungrouped shots"
          : groupId
            ? `Resyncing ${p.groups.find((g) => g.id === groupId)?.name}`
            : "Resyncing every edge";
    setTask(key, { label, pct: 0 });
    try {
      const fps = p.fps;
      const tol = 0.6 / fps;
      const totalFrames = Math.floor(p.duration * fps);
      const shots =
        groupId === "absent"
          ? []
          : p.shots.filter((s) => (groupId === "unassigned" ? !s.groupId : groupId ? s.groupId === groupId : true));
      const edges = new Set<number>();
      for (const s of shots) {
        if (s.start > tol) edges.add(s.start);
        if (s.end < p.duration - tol) edges.add(s.end);
      }
      if (groupId === "absent") for (const b of p.boundaries) if (b.t > tol && b.t < p.duration - tol) edges.add(b.t);
      if (!groupId) for (const c of p.cuts ?? []) edges.add(c);
      const list = [...edges].sort((a, b) => a - b);
      const reader = await openReader(srcUrl, fps);
      const moves: [number, number][] = [];
      try {
        for (let i = 0; i < list.length; i++) {
          const f = await refineEdge(reader, fps, list[i], totalFrames);
          if (f !== null && Math.abs(f / fps - list[i]) > tol) moves.push([list[i], f / fps]);
          setTask(key, { label, pct: (i + 1) / list.length });
        }
      } finally {
        reader.close();
      }
      let st = { boundaries: p.boundaries, cuts: p.cuts ?? [] };
      for (const [from, to] of moves) st = moveEdge(st.boundaries, st.cuts, from, to, tol);
      const next = { ...p, ...st };
      const rebuilt = buildShots(next);
      update(() => ({ ...next, shots: rebuilt }));
      await refreshThumbs(rebuilt);
      const avg = moves.length ? moves.reduce((s, [a, b]) => s + (b - a), 0) / moves.length : 0;
      flash(
        moves.length
          ? `${moves.length} of ${list.length} edges moved (avg ${avg > 0 ? "+" : ""}${Math.round(avg * fps)} frames)`
          : `All ${list.length} edges already on the cut`,
      );
    } catch (e) {
      setError(`Resync failed: ${describe(e)}`);
    } finally {
      setTask(key, null);
    }
  }

  const [sel, setSel] = useState<string>("unassigned");
  const [trimming, setTrimming] = useState<string | null>(null);
  const [trimmingRender, setTrimmingRender] = useState<{ partId: string; j: number } | null>(null);

  // ---- render ---------------------------------------------------------------
  const plan = (x: Project): Part[] => {
    let parts: Part[] = [];
    for (const g of x.groups) parts = parts.concat(buildParts(x, g.id));
    // Renders of looks that no longer exist are dropped; renders are otherwise kept forever.
    return parts;
  };
  function enterRender() {
    update((x) => {
      const range = x.range ?? { start: 0, end: x.duration };
      const groups = x.groups.map((g) => (g.prompt.trim() ? g : { ...g, prompt: defaultPrompt(g) }));
      const next = { ...x, range, groups };
      return { ...next, parts: plan(next), step: "render" };
    });
  }
  function setRange(r: { start: number; end: number }) {
    update((x) => {
      const next = { ...x, range: r };
      return { ...next, parts: plan(next) };
    });
  }
  const patchPart = (id: string, patch: Partial<Part>) =>
    update((x) => ({ ...x, parts: x.parts.map((pt) => (pt.id === id ? { ...pt, ...patch } : pt)) }));

  async function addFaces(files: File[], asDefault = true): Promise<string[]> {
    const added: { id: string; file: StoredFile; label: string }[] = [];
    for (const f of files) {
      const j = await toJpeg(f, f.name || "face.png").catch(() => null);
      if (!j) {
        setError(`Can't read ${f.name}. Use a JPEG or PNG.`);
        continue;
      }
      added.push({ id: uid(), file: j, label: (f.name || "face").replace(/\.[^.]+$/, "") });
    }
    if (!added.length) return [];
    update((x) => {
      const library = [...(x.library ?? []), ...added];
      // The first face ever added becomes the default for the whole video.
      const defaultRefs = x.defaultRefs?.length || !asDefault ? (x.defaultRefs ?? []) : [added[0].id];
      return { ...x, library, defaultRefs };
    });
    return added.map((a) => a.id);
  }
  const toggleDefault = (id: string) =>
    update((x) => {
      const d = x.defaultRefs ?? [];
      return { ...x, defaultRefs: d.includes(id) ? d.filter((y) => y !== id) : [...d, id] };
    });
  const removeFace = (id: string) =>
    update((x) => ({
      ...x,
      library: (x.library ?? []).filter((f) => f.id !== id),
      defaultRefs: (x.defaultRefs ?? []).filter((y) => y !== id),
      groups: x.groups.map((g) => ({ ...g, refIds: g.refIds?.filter((y) => y !== id) })),
    }));
  const toggleGroupFace = (gid: string, id: string) =>
    update((x) => ({
      ...x,
      groups: x.groups.map((g) => {
        if (g.id !== gid) return g;
        const cur = g.refIds?.length ? g.refIds : [];
        return { ...g, refIds: cur.includes(id) ? cur.filter((y) => y !== id) : [...cur, id] };
      }),
    }));

  const patchOthers = (gid: string, f: (o: NonNullable<Wardrobe["others"]>) => NonNullable<Wardrobe["others"]>) =>
    update((x) => ({
      ...x,
      groups: x.groups.map((g) => {
        if (g.id !== gid || !g.wardrobe) return g;
        const w = { ...g.wardrobe, others: f(g.wardrobe.others ?? []) };
        return { ...g, wardrobe: w, ...(g.promptEdited ? {} : { prompt: wardrobePrompt(g.description, w, refsOf(x, g).length) }) };
      }),
    }));

  // Picking a face for another person also reads their wardrobe against that photo.
  async function setOtherFace(g: Group, i: number, faceId: string | undefined) {
    patchOthers(g.id, (os) => os.map((o, k) => (k === i ? { ...o, faceId, wardrobe: faceId ? o.wardrobe : undefined } : o)));
    if (!faceId) return;
    const person = g.wardrobe?.others?.[i];
    const face = p.library?.find((f) => f.id === faceId)?.file;
    if (!person || !face) return;
    const key = `other-${g.id}-${i}`;
    setTask(key, { label: `Reading the outfit for ${person.label.split(",")[0]}`, pct: null });
    try {
      const target = person.thumb ?? p.shots.find((s) => s.groupId === g.id && s.thumb)?.thumb;
      const res = await fetch("/api/wardrobe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targets: target ? [{ name: "person", dataUrl: target }] : [],
          refs: [{ name: face.name, dataUrl: await blobToDataUrl((await toJpeg(face.blob, face.name, 1280)).blob) }],
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      const wears = (person.wears?.length ? person.wears : (json.target as string[])) ?? [];
      const reference = (json.reference as string[]).some((x) => /^face$/i.test(x)) ? (json.reference as string[]) : ["Face", ...(json.reference as string[])];
      const ticks = defaultTicks(wears, reference);
      patchOthers(g.id, (os) => os.map((o, k) => (k === i ? { ...o, wardrobe: ticks } : o)));
    } catch (e) {
      setError(`Outfit for the other person: ${describe(e)}`);
    } finally {
      setTask(key, null);
    }
  }

  async function analyzeWardrobe(g: Group) {
    setTask(`wardrobe-${g.id}`, { label: `Reading the wardrobe for ${g.name}`, pct: null });
    try {
      const range = p.range ?? { start: 0, end: p.duration };
      const shots = p.shots.filter((s) => s.groupId === g.id && s.thumb && s.end > range.start && s.start < range.end).slice(0, 8);
      const photos = refsOf(p, g);
      const refs = await Promise.all(
        photos.map(async (r) => ({ name: r.name, dataUrl: await blobToDataUrl((await toJpeg(r.blob, r.name, 1280)).blob) })),
      );
      const res = await fetch("/api/wardrobe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: shots.map((s) => ({ name: s.id, dataUrl: s.thumb })), refs }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      const prev = g.wardrobe;
      const was = (list: { label: string; on: boolean }[] | undefined, label: string) => list?.find((x) => x.label === label)?.on;
      const reference = (json.reference as string[]).some((x) => /^face$/i.test(x)) ? (json.reference as string[]) : ["Face", ...(json.reference as string[])];
      const ticks = defaultTicks(json.target as string[], reference);
      const w: Wardrobe = {
        target: ticks.target.map((x) => ({ ...x, on: was(prev?.target, x.label) ?? x.on })),
        reference: ticks.reference.map((x) => ({ ...x, on: /^face$/i.test(x.label) ? true : (was(prev?.reference, x.label) ?? x.on) })),
        alone: !!json.alone,
        faceHidden: !!json.faceHidden,
        eyewear: !!json.eyewear,
        performance: typeof json.performance === "string" ? json.performance : undefined,
        refKey: refKey(photos),
        others: await Promise.all(
          (Array.isArray(json.others) ? json.others : []).map(
            async (o: string | { label: string; shot?: number; box?: number[]; wears?: string[] }) => {
              const label = typeof o === "string" ? o : o.label;
              const old = prev?.others?.find((x) => x.label === label);
              let thumb = old?.thumb;
              if (!thumb && typeof o !== "string" && o.box?.length === 4) {
                const src = shots[o.shot ?? 0]?.thumb ?? shots[0]?.thumb;
                if (src) thumb = await cropDataUrl(src, o.box).catch(() => undefined);
              }
              return { label, faceId: old?.faceId, thumb, wears: typeof o === "string" ? old?.wears : o.wears, wardrobe: old?.wardrobe };
            },
          ),
        ),
      };
      update((x) => ({
        ...x,
        groups: x.groups.map((gg) =>
          gg.id === g.id
            ? { ...gg, wardrobe: w, ...(gg.promptEdited ? {} : { prompt: wardrobePrompt(gg.description, w, photos.length) }) }
            : gg,
        ),
      }));
    } catch (e) {
      setError(`Wardrobe for ${g.name}: ${describe(e)}`);
    } finally {
      setTask(`wardrobe-${g.id}`, null);
    }
  }

  async function writeGroupPrompt(g: Group) {
    setTask(`prompt-${g.id}`, { label: `Writing prompt for ${g.name}`, pct: null });
    try {
      const shots = p.shots.filter((s) => s.groupId === g.id && s.thumb).slice(0, 8);
      const faces = await Promise.all(
        refsOf(p, g).map(async (r) => ({ name: r.name, dataUrl: await blobToDataUrl((await toJpeg(r.blob, r.name, 1280)).blob) })),
      );
      const res = await fetch("/api/direct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targets: shots.map((s, i) => ({ name: `${g.name} shot ${i + 1}`, dataUrl: s.thumb })),
          faces,
          model: RENDER_MODELS.find((m) => m.id === g.modelId)?.name ?? g.modelId,
          notes: [
            `This clip contains only one look: "${g.name}". ${g.description}`,
            "It is a stitched sequence of short shots; the target appears in every single shot of it, often the only person or the one rapping to camera. Replace him in all of them, even with sunglasses, a hat, a side angle or when small in frame.",
            g.wardrobe
              ? `Wardrobe, follow exactly. Take from reference image 1: ${g.wardrobe.reference.filter((x) => x.on).map((x) => x.label).join(", ")}. Keep from the original: ${g.wardrobe.target.filter((x) => x.on).map((x) => x.label).join(", ") || "nothing"}. Replace: ${g.wardrobe.target.filter((x) => !x.on).map((x) => x.label).join(", ") || "nothing"}.`
              : "",
            g.notes,
          ]
            .filter(Boolean)
            .join(" "),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      patchGroup(g.id, { prompt: json.prompt ?? "", promptEdited: true });
    } catch (e) {
      setError(`Prompt for ${g.name}: ${describe(e)}`);
    } finally {
      setTask(`prompt-${g.id}`, null);
    }
  }

  // Review decisions. Using a take parks every other take of the same shot (kept, not
  // deleted); Redo marks all of them unwanted so the shot is queued again.
  function useTake(shotRange: { start: number; end: number }, partId: string, j: number) {
    update((x) => {
      const others = takesFor(x, shotRange).filter((t) => !(t.part.id === partId && t.j === j));
      return {
        ...x,
        parts: x.parts.map((pt) => {
          let next = pt;
          if (pt.id === partId) {
            next = {
              ...next,
              reviewed: [...new Set([...(pt.reviewed ?? []), j])],
              rejected: (pt.rejected ?? []).filter((k) => k !== j),
              unused: (pt.unused ?? []).filter((k) => k !== j),
            };
          }
          const mine = others.filter((t) => t.part.id === pt.id).map((t) => t.j);
          if (mine.length) next = { ...next, unused: [...new Set([...(next.unused ?? []), ...mine])] };
          return next;
        }),
      };
    });
  }
  function redoShot(shotRange: { start: number; end: number }) {
    update((x) => {
      const takes = takesFor(x, shotRange);
      return {
        ...x,
        parts: x.parts.map((pt) => {
          const mine = takes.filter((t) => t.part.id === pt.id).map((t) => t.j);
          return mine.length
            ? {
                ...pt,
                rejected: [...new Set([...(pt.rejected ?? []), ...mine])],
                unused: (pt.unused ?? []).filter((k) => !mine.includes(k)),
                reviewed: (pt.reviewed ?? []).filter((k) => !mine.includes(k)),
              }
            : pt;
        }),
      };
    });
  }

  // Keep only the frames picked in a rendered piece. Cut-off frames that sit across a
  // hard cut in the original are another scene's: the shot edge moves so they belong
  // there. The rest stay in this look and go into its next render.
  async function trimRenderPiece(partId: string, j: number, a: number, b: number) {
    const part = p.parts.find((x) => x.id === partId);
    if (!part || !srcUrl) return;
    const pc = part.pieces[j];
    const off = part.measuredOffsets?.[j] ?? pc.offset;
    const fps = p.fps;
    const snap = (t: number) => Math.round(t * fps) / fps;
    const newStart = Math.max(pc.start, snap(pc.start + (a - off)));
    const newEnd = Math.min(pc.end, snap(pc.start + (b - off)));
    if (newEnd - newStart < 1 / fps) return;
    const tol = 0.6 / fps;
    const shot = p.shots.find((x) => x.id === pc.shotId);
    let st = { boundaries: p.boundaries, cuts: p.cuts ?? [] };
    let foreign = 0;
    const reader = await openReader(srcUrl, fps);
    try {
      const total = Math.floor(p.duration * fps);
      if (shot && newStart > pc.start + tol && Math.abs(shot.start - pc.start) < tol) {
        const f = await refineEdge(reader, fps, newStart, total, 1);
        if (f === Math.round(newStart * fps)) {
          foreign += Math.round((newStart - pc.start) * fps);
          st = moveEdge(st.boundaries, st.cuts, shot.start, newStart, tol);
        }
      }
      if (shot && newEnd < pc.end - tol && Math.abs(shot.end - pc.end) < tol) {
        const f = await refineEdge(reader, fps, newEnd, total, 1);
        if (f === Math.round(newEnd * fps)) {
          foreign += Math.round((pc.end - newEnd) * fps);
          st = moveEdge(st.boundaries, st.cuts, shot.end, newEnd, tol);
        }
      }
    } finally {
      reader.close();
    }
    const cutOff = Math.round((pc.end - pc.start - (newEnd - newStart)) * fps);
    const next = {
      ...p,
      ...st,
      parts: p.parts.map((x) => (x.id === partId ? { ...x, trims: { ...(x.trims ?? {}), [j]: { start: newStart, end: newEnd } } } : x)),
    };
    const shots = buildShots(next);
    update(() => ({ ...next, shots }));
    await refreshThumbs(shots);
    flash(
      `Trimmed ${cutOff} frame${cutOff === 1 ? "" : "s"}: ${foreign} back to the neighbouring scene, ${cutOff - foreign} into this look's next render`,
    );
  }

  // Build the clip, upload it with the faces, submit. Returns the job so the caller
  // decides whether to wait; the job id is saved before any waiting happens.
  // The exact clip a part sends, built locally (cached until its pieces change).
  const clipCache = useRef(new Map<string, File>());
  async function buildPartClip(part: Part): Promise<File> {
    const key = partKey(part) + `#${part.pad.length}`;
    const hit = clipCache.current.get(key);
    if (hit) return hit;
    const h = Math.min(720, p.height);
    const w = Math.round((p.width / p.height) * h);
    const off = p.preparedOffset ?? 0;
    const clip = await buildClip(
      p.prepared!.blob,
      [...part.pieces, ...part.pad].map((x) => ({ start: Math.max(0, x.start + off), end: x.end + off })),
      { w, h },
      p.hasAudio,
      (r) => patchPart(part.id, { progress: r }),
      fpsExpr(p.fps),
    );
    clipCache.current.set(key, clip);
    return clip;
  }

  // Pre-flight: build the clip, find its cuts, and flag any cut the plan doesn't expect.
  async function checkPart(part: Part): Promise<Issue[]> {
    if (!p.prepared) throw new Error("The video is still being prepared.");
    patchPart(part.id, { status: "building", progress: 0, error: undefined });
    try {
      const clip = await buildPartClip(part);
      const cuts = await detectCuts(clip, part.clipLength, undefined, 0.25);
      const issues = findIssues(part, cuts, p.fps);
      patchPart(part.id, { status: "idle", progress: undefined, issues, checkedKey: issues.length ? undefined : partKey(part) });
      return issues;
    } catch (e) {
      patchPart(part.id, { status: "idle", progress: undefined, error: describe(e) });
      throw e;
    }
  }

  async function checkParts(ids: string[]) {
    let found = 0;
    for (const id of ids) {
      const part = p.parts.find((x) => x.id === id);
      if (part) found += (await checkPart(part).catch(() => [])).length;
    }
    flash(found ? `Found ${found} stray-frame spot${found === 1 ? "" : "s"}. Fix them before rendering.` : "All clips clean");
  }

  // Trim slivers onto the neighbouring shot; split shots where a cut was missed.
  async function fixIssues(part: Part) {
    if (!part.issues?.length) return;
    const tol = 0.6 / p.fps;
    let st = { boundaries: p.boundaries, cuts: p.cuts ?? [] };
    for (const is of part.issues) {
      const shot = p.shots.find((x) => x.id === is.shotId);
      if (!shot) continue;
      if (is.kind === "start") st = moveEdge(st.boundaries, st.cuts, shot.start, is.at, tol);
      else if (is.kind === "end") st = moveEdge(st.boundaries, st.cuts, shot.end, is.at, tol);
      else st = { ...st, cuts: [...new Set([...st.cuts, is.at])].sort((a, b) => a - b) };
    }
    const next = { ...p, ...st };
    const shots = buildShots(next);
    update(() => ({ ...next, shots }));
    await refreshThumbs(shots);
    flash("Fixed. The parts were rebuilt; check again before rendering.");
  }

  // Build the clip, upload it with the faces, submit. Returns the job so the caller
  // decides whether to wait; the job id is saved before any waiting happens.
  async function startPart(part: Part): Promise<PendingJob | null> {
    const g = p.groups.find((x) => x.id === part.groupId)!;
    const model = RENDER_MODELS.find((m) => m.id === g.modelId) ?? RENDER_MODELS[0];
    if (!p.prepared) {
      setError("The video is still being prepared. Try again in a moment.");
      return null;
    }
    const photos = refsOf(p, g);
    if (!photos.length) {
      setError(`Pick a face for "${g.name}" first.`);
      return null;
    }
    try {
      if (part.checkedKey !== partKey(part)) {
        const issues = await checkPart(part);
        if (issues.length) {
          patchPart(part.id, { error: `${issues.length} stray-frame spot${issues.length === 1 ? "" : "s"} in this clip. Fix before rendering.` });
          return null;
        }
      }
      patchPart(part.id, { status: "building", progress: 0, error: undefined });
      const clip = await buildPartClip(part);
      patchPart(part.id, { status: "uploading", progress: undefined });
      const videoUrl = await fal.storage.upload(clip);
      const extra = otherRefsOf(p, g);
      if (photos.length + extra.length > 4) {
        throw new Error(`H3 takes at most 4 photos; this look uses ${photos.length} for him and ${extra.length} for others.`);
      }
      const cast = await Promise.all(
        [...photos, ...extra].map(async (r) => ({ url: await fal.storage.upload(new File([r.blob], r.name, { type: r.type })), who: "" })),
      );
      const input = model.build({
        videoUrl,
        maskUrl: null,
        cast,
        prompt: "",
        directed:
          g.prompt ||
          `The target appears in every single shot of this clip. Replace him with the man in reference image 1 in all of them, even with sunglasses, a hat, a side angle or when small in frame. ${g.description} Keep his clothing, hats and sunglasses exactly. Everyone else unchanged. Preserve lip-sync and motion.`,
        duration: part.clipLength,
        side: "center",
      });
      const job =
        model.provider === "sume"
          ? await submitSume(model.id, model.name, input)
          : await submitFal(model.id, model.name, input, (n) =>
              patchPart(part.id, { error: `Provider busy, retrying (${n}/3)…` }),
            );
      patchPart(part.id, {
        status: "rendering",
        error: undefined,
        endpoint: job.endpoint,
        requestId: job.requestId,
        signature: signature(part, g, photos),
      });
      return job;
    } catch (e) {
      patchPart(part.id, { status: "failed", error: describe(e) });
      return null;
    }
  }

  async function waitPart(partId: string, job: PendingJob) {
    try {
      const url = await waitFor(job, () => patchPart(partId, { error: undefined }));
      removeJob(job.requestId);
      patchPart(partId, { status: "done", resultUrl: url, renderedAt: Date.now(), calibrated: false, measuredOffsets: undefined });
    } catch (e) {
      patchPart(partId, { status: "failed", error: describe(e) });
    }
  }

  async function renderParts(ids: string[]) {
    setError(null);
    const waits: Promise<void>[] = [];
    for (const id of ids) {
      let part = p.parts.find((x) => x.id === id);
      if (!part) continue;
      // Re-rolling a finished part renders a copy, so the existing take stays saved.
      if (part.status === "done") {
        const copy: Part = {
          ...part,
          id: uid(),
          status: "idle",
          resultUrl: undefined,
          requestId: undefined,
          renderedAt: undefined,
          measuredOffsets: undefined,
          calibrated: false,
          trims: undefined,
          rejected: undefined,
          reviewed: undefined,
          unused: undefined,
          issues: undefined,
        };
        update((x) => ({ ...x, parts: [...x.parts, copy] }));
        part = copy;
      }
      const job = await startPart(part);
      if (job) waits.push(waitPart(id, job));
    }
    await Promise.all(waits);
  }

  // Looks reaching the Render step with an empty prompt get the suggested one.
  useEffect(() => {
    if (!loaded || p.step !== "render" || !p.groups.some((g) => !g.prompt.trim())) return;
    queueMicrotask(() =>
      update((x) => ({
        ...x,
        groups: x.groups.map((g) => (g.prompt.trim() ? g : { ...g, prompt: defaultPrompt(g, refsOf(x, g).length) })),
      })),
    );
  }, [loaded, p.step, p.groups, update]);

  // On the Render step, every look in the span with a face gets its wardrobe read
  // (once per set of photos), which also rebuilds its prompt unless it was typed by hand.
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (!loaded || p.step !== "render") return;
    // Dev only: ?noauto keeps test sessions from spending API calls.
    if (process.env.NODE_ENV === "development" && new URLSearchParams(window.location.search).has("noauto")) return;
    if (Object.keys(tasks).some((k) => k.startsWith("wardrobe-"))) return;
    const next = p.groups.find((g) => {
      const photos = refsOf(p, g);
      if (!photos.length || partsInRange(p, g.id).length === 0) return false;
      const key = `${g.id}:${refKey(photos)}`;
      return g.wardrobe?.refKey !== refKey(photos) && !tried.current.has(key);
    });
    if (!next) return;
    tried.current.add(`${next.id}:${refKey(refsOf(p, next))}`);
    queueMicrotask(() => void analyzeWardrobe(next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, p.step, p.groups, p.library, p.defaultRefs, p.range, tasks]);

  // Every finished render gets its piece positions measured once from its own cuts.
  const calibrating = useRef(false);
  useEffect(() => {
    if (!loaded || calibrating.current) return;
    const next = p.parts.find((x) => x.status === "done" && x.resultUrl && !x.calibrated);
    if (!next) return;
    calibrating.current = true;
    const fps = p.fps;
    (async () => {
      try {
        const blob = await fetch(next.resultUrl!).then((r) => r.blob());
        const cuts = await detectCuts(blob, next.clipLength);
        const offsets = measureOffsets(next, cuts, fps);
        const moved = offsets.filter((o, i) => Math.abs(o - next.pieces[i].offset) > 0.5 / fps).length;
        patchPart(next.id, { measuredOffsets: offsets, calibrated: true });
        if (moved) flash(`Lined up ${moved} piece${moved === 1 ? "" : "s"} in a render with its real cuts`);
      } catch {
        patchPart(next.id, { calibrated: true });
      } finally {
        calibrating.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, p.parts]);

  // Parts always follow the current shots and span: any trim in Scenes or span drag
  // rebuilds the not-yet-rendered parts, wherever you navigate from.
  const shotsKey = p.shots.map((s) => `${s.id}:${s.start.toFixed(4)}-${s.end.toFixed(4)}:${s.groupId}`).join("|");
  // What's already covered: finished/running renders with their trims and redos.
  const coverKey = p.parts
    .filter((x) => x.status !== "idle" && x.status !== "failed")
    .map((x) => `${x.id}:${x.status}:${JSON.stringify(x.trims ?? {})}:${(x.rejected ?? []).join(",")}:${(x.unused ?? []).join(",")}`)
    .join("|");
  useEffect(() => {
    if (!loaded || !p.groups.length) return;
    queueMicrotask(() => update((x) => ({ ...x, parts: plan(x) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, shotsKey, coverKey, p.range?.start, p.range?.end, p.groups.length]);

  // Resume renders that were in flight when the page closed.
  const resumed = useRef(false);
  useEffect(() => {
    if (!loaded || resumed.current) return;
    resumed.current = true;
    const parts = p.parts;
    queueMicrotask(() => {
      for (const pt of parts) {
        if (pt.status === "rendering" && pt.requestId && pt.endpoint) {
          const prov = MODELS.find((m) => m.id === pt.endpoint)?.provider ?? "fal";
          void waitPart(pt.id, { provider: prov, endpoint: pt.endpoint, requestId: pt.requestId, model: pt.endpoint, at: Date.now() });
        } else if (pt.status === "building" || pt.status === "uploading") {
          patchPart(pt.id, { status: "idle", progress: undefined });
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // ---- assemble -------------------------------------------------------------
  const [rangeMode, setRangeMode] = useState<"range" | "all" | "span">("range");
  async function assemble() {
    if (!p.prepared) return;
    setError(null);
    setTask("assemble", { label: "Downloading renders", pct: null });
    try {
      const span =
        rangeMode === "range" && p.range
          ? p.range
          : rangeMode === "span" && present.length
            ? { start: present[0].start, end: present[present.length - 1].end }
            : { start: 0, end: p.duration };
      // Every finished render that touches the span, from any batch; newest wins on overlap.
      const done = p.parts
        .filter((x) => x.status === "done" && x.resultUrl)
        .filter((x) => x.pieces.some((pc) => pc.end > span.start && pc.start < span.end))
        .sort((a, b) => (a.renderedAt ?? 0) - (b.renderedAt ?? 0));
      const results = await Promise.all(done.map((d) => fetch(d.resultUrl!).then((r) => r.blob())));
      // Each render should be exactly as long as the clip that was sent. If the model
      // returned it shorter or longer, read it stretched so every piece lands on its frame.
      const lengths = await Promise.all(
        results.map(
          (b) =>
            new Promise<number>((res) => {
              const v = document.createElement("video");
              const u = URL.createObjectURL(b);
              v.preload = "metadata";
              v.onloadedmetadata = () => {
                res(v.duration);
                URL.revokeObjectURL(u);
              };
              v.onerror = () => res(NaN);
              v.src = u;
            }),
        ),
      );
      // Calibrated renders already have measured piece positions; only uncalibrated ones get stretched.
      const stretch = [
        1,
        ...done.map((d, i) => (d.measuredOffsets ? 1 : isFinite(lengths[i]) && lengths[i] > 0 ? lengths[i] / d.clipLength : 1)),
      ];
      const drift = stretch.slice(1).map((k, i) => Math.abs(k - 1) * done[i].clipLength * p.fps);
      const files: Blob[] = [p.prepared.blob, ...results];
      type Rep = { start: number; end: number; file: number; offset: number };
      let reps: Rep[] = [];
      done.forEach((d, i) =>
        d.pieces.forEach((pc, j) => {
          if (!pieceLive(d, j)) return;
          const kept = keptRange(d, j);
          const at = (d.measuredOffsets?.[j] ?? pc.offset) + (kept.start - pc.start);
          pc = { ...pc, start: kept.start, end: kept.end };
          // Newer renders replace older ones where they overlap.
          reps = reps.flatMap((r) => {
            if (pc.end <= r.start || pc.start >= r.end) return [r];
            const out: Rep[] = [];
            if (pc.start > r.start) out.push({ ...r, end: pc.start });
            if (pc.end < r.end) out.push({ ...r, start: pc.end, offset: r.offset + (pc.end - r.start) });
            return out;
          });
          reps.push({ start: pc.start, end: pc.end, file: i + 1, offset: at });
        }),
      );
      reps.sort((a, b) => a.start - b.start);
      const pieces: { file: number; start: number; end: number }[] = [];
      let t = span.start;
      for (const r of reps) {
        if (r.end <= span.start || r.start >= span.end) continue;
        const a = Math.max(r.start, span.start);
        const b = Math.min(r.end, span.end);
        if (a - t > 0.5 / p.fps) pieces.push({ file: 0, start: t, end: a });
        pieces.push({ file: r.file, start: r.offset + (a - r.start), end: r.offset + (b - r.start) });
        t = b;
      }
      if (span.end - t > 0.5 / p.fps) pieces.push({ file: 0, start: t, end: span.end });
      const size = await new Promise<{ w: number; h: number }>((res) => {
        if (!done[0]) return res({ w: Math.round((p.width / p.height) * Math.min(720, p.height)), h: Math.min(720, p.height) });
        const v = document.createElement("video");
        v.crossOrigin = "anonymous";
        v.preload = "metadata";
        v.onloadedmetadata = () => res({ w: v.videoWidth, h: v.videoHeight });
        v.onerror = () => res({ w: 1280, h: 720 });
        v.src = done[0].resultUrl!;
      });
      setTask("assemble", { label: "Assembling on the original timeline", pct: 0 });
      const off = p.preparedOffset ?? 0;
      const shifted = pieces.map((x) => (x.file === 0 ? { ...x, start: Math.max(0, x.start + off), end: x.end + off } : x));
      const audioSpan = { start: Math.max(0, span.start + off), end: span.end + off };
      const out = await assembleTimeline(
        files,
        shifted,
        p.hasAudio ? audioSpan : null,
        size,
        (r) => setTask("assemble", { label: "Assembling on the original timeline", pct: r }),
        fpsExpr(p.fps),
        stretch,
      );
      update((x) => ({ ...x, output: { blob: out, name: `${x.name}-${fmt(span.start)}-${fmt(span.end)}.mp4`.replace(/:/g, "."), type: "video/mp4" } }));
      const worst = Math.max(0, ...drift);
      flash(worst >= 1 ? `Assembled · corrected a render that was ${Math.round(worst)} frames off` : "Assembled · every render matched its clip");
    } catch (e) {
      setError(`Assembly failed: ${describe(e)}`);
    } finally {
      setTask("assemble", null);
    }
  }

  // ---- analysis backup ------------------------------------------------------
  function exportAnalysis() {
    const data = {
      kind: "getmotion.analysis",
      version: 1,
      source: { name: p.source?.name, duration: p.duration, width: p.width, height: p.height, fps: p.fps },
      boundaries: p.boundaries,
      cuts: p.cuts,
      watched: p.watched,
      shots: p.shots.map(({ thumb: _t, ...s }) => (void _t, s)),
      groups: p.groups.map(({ refs: _r, ...g }) => (void _r, g)),
      parts: p.parts.filter((x) => x.status === "done"),
      range: p.range,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    save({ blob, name: `${p.name}-analysis.json`, type: "application/json" });
  }
  async function importAnalysis(f: File) {
    try {
      const d = JSON.parse(await f.text());
      if (d.kind !== "getmotion.analysis") throw new Error("Not a getmotion analysis file");
      if (p.duration && Math.abs(d.source.duration - p.duration) > 0.5) {
        if (!confirm(`This analysis is for a ${fmt(d.source.duration)} video, the loaded one is ${fmt(p.duration)}. Import anyway?`)) return;
      }
      update((x) => ({
        ...x,
        boundaries: d.boundaries ?? [],
        cuts: d.cuts ?? x.cuts,
        watched: d.watched ?? x.watched,
        fps: d.source?.fps ?? x.fps,
        shots: d.shots ?? [],
        groups: (d.groups ?? []).map((g: Group) => ({ ...g, refs: [] })),
        parts: d.parts ?? [],
        range: d.range,
        step: d.shots?.length ? "scenes" : "spot",
      }));
      flash("Analysis imported");
      if (srcUrl && d.shots?.length) await refreshThumbs(d.shots);
    } catch (e) {
      setError(`Import failed: ${describe(e)}`);
    }
  }

  function save(file: StoredFile) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file.blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  // ---- render ------------------------------------------------------------------
  const taskList = Object.entries(tasks);

  return (
    <div className="min-h-dvh flex flex-col">
      {taskList.length > 0 && <div className="sweep fixed top-0 left-0 right-0 h-px z-50 overflow-hidden" />}

      <header className="flex items-center gap-6 px-6 h-16 border-b border-hair">
        <Link href="/" className="flex items-center shrink-0">
          <Image src="/logo.png" alt="getmotion.art" width={1700} height={290} priority className="h-[20px] w-auto" />
        </Link>
        <nav className="flex items-center gap-1 overflow-x-auto">
          {STEPS.map((s, i) => {
            const on = p.step === s.id;
            const can = reach[s.id];
            return (
              <button
                key={s.id}
                onClick={() => go(s.id)}
                disabled={!can}
                className={`flex items-center gap-2 h-8 pl-1.5 pr-3 rounded-full text-[13px] transition-colors ${
                  on ? "bg-white text-black" : can ? "text-ink hover:bg-white/[0.06]" : "text-faint cursor-not-allowed"
                }`}
                title={s.hint}
              >
                <span
                  className={`w-5 h-5 rounded-full grid place-items-center text-[11px] tabular-nums ${
                    on ? "bg-black text-white" : "bg-white/10"
                  }`}
                >
                  {i + 1}
                </span>
                {s.label}
              </button>
            );
          })}
        </nav>
        <span className="flex-1" />
        {p.shots.length > 0 && (
          <button className="btn h-8 px-3 text-[12px]" onClick={exportAnalysis} title="Download the spotting, cuts, looks and renders as a file">
            Export analysis
          </button>
        )}
        {p.source && (
          <label className="btn h-8 px-3 text-[12px] cursor-pointer" title="Load a saved analysis for this video">
            Import
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importAnalysis(f);
                e.target.value = "";
              }}
            />
          </label>
        )}
        <Link href="/" className="btn h-8 px-3 text-[12px]">Single clip</Link>
        {p.source && (
          <button className="btn h-8 px-3 text-[12px] text-muted" onClick={newProject}>
            New project
          </button>
        )}
      </header>

      <main className="flex-1 min-h-0">
        {p.step === "source" && (
          <SourceStep onPick={() => fileRef.current?.click()} onDrop={onSource} project={p} onContinue={() => go("spot")} />
        )}
        {p.step === "spot" && srcUrl && (
          <SpotStep
            p={p}
            src={srcUrl}
            update={update}
            onNext={enterScenes}
            presentLen={presentLen}
          />
        )}
        {p.step === "scenes" && srcUrl && (
          <ScenesStep
            p={p}
            src={srcUrl}
            sel={sel}
            setSel={setSel}
            present={present}
            absent={absent}
            presentLen={presentLen}
            groupedLen={groupedLen}
            onAuto={() => autoGroup(p.shots)}
            onAdd={() => setSel(addGroup())}
            onSetShot={setShotGroup}
            onPatch={patchGroup}
            onDelete={(id) => {
              deleteGroup(id);
              setSel("unassigned");
            }}
            onFlip={flipSpan}
            onNewGroupFor={(shotId) => {
              const id = addGroup();
              setShotGroup(shotId, id);
              setSel(id);
            }}
            onNext={enterRender}
            canNext={reach.render}
            onTrim={setTrimming}
            onResync={resync}
            resyncing={Object.keys(tasks).some((k) => k.startsWith("resync"))}
          />
        )}
        {p.step === "render" && srcUrl && (
          <RenderStep
            p={p}
            src={srcUrl}
            tasks={tasks}
            onPatch={patchGroup}
            onAddFaces={addFaces}
            onOtherFace={(g, i, id) => void setOtherFace(g, i, id)}
            onToggleDefault={toggleDefault}
            onRemoveFace={removeFace}
            onToggleGroupFace={toggleGroupFace}
            onWrite={writeGroupPrompt}
            onAnalyze={analyzeWardrobe}
            onRender={renderParts}
            onCheck={checkParts}
            onUseTake={useTake}
            onRedoShot={redoShot}
            onTrimPiece={(id, j) => setTrimmingRender({ partId: id, j })}
            onFix={fixIssues}
            onReject={(id, j, rejected) =>
              update((x) => ({
                ...x,
                parts: x.parts.map((pt) =>
                  pt.id !== id
                    ? pt
                    : {
                        ...pt,
                        rejected: rejected ? [...new Set([...(pt.rejected ?? []), j])] : (pt.rejected ?? []).filter((k) => k !== j),
                        // Keep in the part's own review counts as reviewed.
                        reviewed: rejected ? (pt.reviewed ?? []).filter((k) => k !== j) : [...new Set([...(pt.reviewed ?? []), j])],
                        unused: (pt.unused ?? []).filter((k) => k !== j),
                      },
                ),
              }))
            }
            onNext={() => go("assemble")}
            onError={setError}
            onRange={setRange}
          />
        )}
        {p.step === "assemble" && srcUrl && (
          <AssembleStep
            p={p}
            present={present}
            rangeMode={rangeMode}
            setRangeMode={setRangeMode}
            busy={!!tasks.assemble}
            onAssemble={assemble}
            outUrl={outUrl}
            onSave={() => p.output && save(p.output)}
            onBack={() => go("render")}
          />
        )}
      </main>

      <input
        ref={fileRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onSource(e.target.files[0])}
      />

      {trimming && srcUrl && (() => {
        const s = p.shots.find((x) => x.id === trimming);
        if (!s) return null;
        const g = p.groups.find((x) => x.id === s.groupId);
        return (
          <EdgeEditor
            src={srcUrl}
            fps={p.fps}
            duration={p.duration}
            start={s.start}
            end={s.end}
            title={`${g?.name ?? "Shot"} · ${fmt(s.start)}`}
            onClose={() => setTrimming(null)}
            onSave={(a, b) => {
              setTrimming(null);
              void moveEdges(s.id, a, b);
            }}
          />
        );
      })()}

      {trimmingRender && (() => {
        const pt = p.parts.find((x) => x.id === trimmingRender.partId);
        if (!pt?.resultUrl) return null;
        const j = trimmingRender.j;
        const pc = pt.pieces[j];
        const off = pt.measuredOffsets?.[j] ?? pc.offset;
        const k = keptRange(pt, j);
        const g = p.groups.find((x) => x.id === pt.groupId);
        return (
          <EdgeEditor
            src={pt.resultUrl}
            fps={24}
            duration={pt.clipLength + 0.2}
            start={off + (k.start - pc.start)}
            end={off + (k.end - pc.start)}
            title={`render · ${g?.name ?? ""} · piece ${j + 1} · ${fmt(pc.start)}`}
            onClose={() => setTrimmingRender(null)}
            onSave={(a, b) => {
              setTrimmingRender(null);
              void trimRenderPiece(pt.id, j, a, b);
            }}
          />
        );
      })()}

      {(taskList.length > 0 || error || toast) && (
        <div className="fixed bottom-5 right-5 z-40 w-[340px] space-y-2">
          {taskList.map(([k, t]) => (
            <div key={k} className="glass rounded-2xl p-3.5 space-y-2">
              <div className="flex justify-between gap-3 text-[13px]">
                <span>{t.label}</span>
                {t.pct !== null && <span className="text-muted tabular-nums">{Math.round(t.pct * 100)}%</span>}
              </div>
              <div className="h-1 rounded-full bg-white/10 overflow-hidden relative">
                {t.pct !== null ? (
                  <div className="h-full bg-white transition-[width] duration-200" style={{ width: `${Math.round(t.pct * 100)}%` }} />
                ) : (
                  <div className="sweep absolute inset-0" />
                )}
              </div>
            </div>
          ))}
          {error && (
            <div className="glass rounded-2xl p-3.5 text-[13px] flex gap-3 items-start">
              <span className="flex-1 break-words">{error}</span>
              <button className="text-muted" onClick={() => setError(null)} aria-label="Dismiss">×</button>
            </div>
          )}
          {toast && <div className="glass rounded-2xl px-3.5 py-2.5 text-[13px]">{toast}</div>}
        </div>
      )}
    </div>
  );
}

// Crop a region (fractions of the image) out of a data-URL image, with some padding.
async function cropDataUrl(src: string, box: number[], size = 240): Promise<string> {
  const img = document.createElement("img");
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("Could not read the shot"));
    img.src = src;
  });
  const [x, y, w, h] = box.map((v) => Math.max(0, Math.min(1, v)));
  const pad = 0.15;
  const sx = Math.max(0, (x - w * pad) * img.width);
  const sy = Math.max(0, (y - h * pad) * img.height);
  const sw = Math.min(img.width - sx, w * (1 + 2 * pad) * img.width);
  const sh = Math.min(img.height - sy, h * (1 + 2 * pad) * img.height);
  const c = document.createElement("canvas");
  const k = size / Math.max(sw, sh);
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  c.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}

// Starting prompt for a look, built from its description and wardrobe. Editable; Claude can rewrite it.
function defaultPrompt(g: Group, refCount = 1) {
  return wardrobePrompt(g.description, g.wardrobe, Math.max(1, refCount));
}

function blobToDataUrl(b: Blob) {
  return new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}

// ============================================================================
// Step 1: Source

function SourceStep({
  onPick,
  onDrop,
  project,
  onContinue,
}: {
  onPick: () => void;
  onDrop: (f: File) => void;
  project: Project;
  onContinue: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div className="max-w-3xl mx-auto px-6 py-16 space-y-10">
      <div className="space-y-3">
        <h1 className="text-[34px] leading-tight tracking-tight">Recast a whole video, one look at a time.</h1>
        <p className="text-muted text-[15px] max-w-xl">
          Mark where he&apos;s on screen, let it group the shots by outfit and place, render each look on its own, and
          get one video back on the original timeline with the original audio.
        </p>
      </div>
      <button
        onClick={onPick}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onDrop(f);
        }}
        className={`w-full aspect-[21/9] rounded-3xl ring-1 transition-all grid place-items-center ${
          over ? "ring-white bg-white/[0.06]" : "ring-hair bg-white/[0.02] hover:bg-white/[0.04]"
        }`}
      >
        <span className="space-y-2 text-center">
          <span className="block text-[22px] tracking-tight">Drop the full video</span>
          <span className="block text-muted text-[13px]">Any length. MP4, MOV, WebM. AV1 and HEVC get converted.</span>
        </span>
      </button>
      {project.source && (
        <div className="glass rounded-2xl p-4 flex items-center gap-4">
          <span className="flex-1 text-[13px]">
            {project.source.name} · {fmt(project.duration)} · {project.width}×{project.height}
          </span>
          <button className="btn btn-on" onClick={onContinue}>Continue</button>
        </div>
      )}
      <ol className="grid sm:grid-cols-4 gap-3 text-[13px]">
        {STEPS.slice(1).map((s, i) => (
          <li key={s.id} className="glass rounded-2xl p-4 space-y-1">
            <span className="text-faint text-[11px] tabular-nums">Step {i + 2}</span>
            <span className="block">{s.label}</span>
            <span className="block text-muted text-[12px]">{s.hint}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ============================================================================
// Step 2: Spot

function SpotStep({
  p,
  src,
  update,
  onNext,
  presentLen,
}: {
  p: Project;
  src: string;
  update: (f: (p: Project) => Project) => void;
  onNext: () => void;
  presentLen: number;
}) {
  const v = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [snap, setSnap] = useState(true);
  const [, setHistory] = useState<Project["boundaries"][]>([]);
  const watchedRef = useRef(p.watched);
  const frame = 1 / p.fps;

  // Smooth playhead + track the furthest point watched.
  useEffect(() => {
    if (!playing) return;
    const el = v.current!;
    const id = setInterval(() => {
      setTime(el.currentTime);
      if (el.currentTime > watchedRef.current + 0.5) {
        watchedRef.current = el.currentTime;
        update((x) => ({ ...x, watched: Math.max(x.watched, el.currentTime) }));
      }
    }, 40);
    return () => clearInterval(id);
  }, [playing, update]);

  const seek = useCallback((t: number) => {
    const el = v.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(p.duration, t));
    setTime(el.currentTime);
  }, [p.duration]);

  const toggle = useCallback(() => {
    const el = v.current;
    if (!el) return;
    if (el.paused) el.play();
    else el.pause();
  }, []);

  const doMark = useCallback(
    (present: boolean) => {
      const el = v.current;
      if (!el) return;
      let t = Math.round(el.currentTime * p.fps) / p.fps;
      const c = snap ? nearest(p.cuts, t, 0.35) : null;
      if (c !== null) t = c;
      setHistory((h) => [...h.slice(-50), p.boundaries]);
      update((x) => ({ ...x, boundaries: mark(x.boundaries, t, present, 1 / x.fps), watched: Math.max(x.watched, t) }));
    },
    [p.boundaries, p.cuts, p.fps, snap, update],
  );

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      update((x) => ({ ...x, boundaries: prev }));
      return h.slice(0, -1);
    });
  }, [update]);

  // Jump to the previous / next cut or mark.
  const hop = useCallback(
    (dir: 1 | -1) => {
      const pts = [...(p.cuts ?? []), ...p.boundaries.map((b) => b.t), 0, p.duration].sort((a, b) => a - b);
      const cur = v.current?.currentTime ?? 0;
      const t = dir > 0 ? pts.find((x) => x > cur + 0.02) : [...pts].reverse().find((x) => x < cur - 0.02);
      if (t !== undefined) {
        v.current?.pause();
        seek(t + 0.001);
      }
    },
    [p.cuts, p.boundaries, p.duration, seek],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "y" || e.key === "Y" || e.key === "Enter") doMark(true);
      else if (e.key === "n" || e.key === "N" || e.key === "Backspace") doMark(false);
      else if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        undo();
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const d = e.key === "ArrowRight" ? 1 : -1;
        if (e.shiftKey) hop(d as 1 | -1);
        else {
          v.current?.pause();
          seek((v.current?.currentTime ?? 0) + d * frame);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, doMark, undo, hop, seek, frame]);

  const state = stateAt(p.boundaries, time);
  const watchedPct = Math.min(100, Math.round((p.watched / (p.duration || 1)) * 100));
  const unmarked = p.boundaries.length ? p.boundaries[0].t : p.duration;

  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] lg:h-[calc(100dvh-4rem)]">
      <section className="p-6 space-y-4 min-w-0 overflow-y-auto">
        <div className="relative mx-auto h-[50vh] max-w-full aspect-video rounded-2xl overflow-hidden bg-black ring-1 ring-hair">
          <video
            ref={v}
            src={src}
            playsInline
            className="w-full h-full object-contain cursor-pointer"
            onClick={toggle}
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              el.currentTime = Math.min(p.watched, el.duration);
              setTime(el.currentTime);
            }}
            onPlay={() => setPlaying(true)}
            onPause={(e) => {
              setPlaying(false);
              setTime(e.currentTarget.currentTime);
            }}
            onSeeked={(e) => setTime(e.currentTarget.currentTime)}
          />
          <span
            className={`absolute left-3 top-3 text-[12px] rounded-full px-2.5 py-1 backdrop-blur-md ${
              state === true ? "bg-[rgba(74,222,128,0.85)] text-black" : state === false ? "bg-black/60" : "bg-black/60 text-muted"
            }`}
          >
            {state === true ? "He's in frame" : state === false ? "Not in frame" : "Not marked yet"}
          </span>
        </div>

        <SpotTrack
          duration={p.duration}
          boundaries={p.boundaries}
          cuts={p.cuts}
          time={time}
          watched={p.watched}
          onSeek={(t) => seek(t)}
        />

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-icon" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <div className="seg glass">
            <button onClick={() => hop(-1)} title="Previous cut or mark (Shift ←)">⇤ cut</button>
            <button onClick={() => { v.current?.pause(); seek(time - frame); }} title="Previous frame (←)">‹</button>
            <button onClick={() => { v.current?.pause(); seek(time + frame); }} title="Next frame (→)">›</button>
            <button onClick={() => hop(1)} title="Next cut or mark (Shift →)">cut ⇥</button>
          </div>
          <span className="text-[13px] tabular-nums">
            {fmt(time)} <span className="text-faint">/ {fmt(p.duration)} · f{Math.round(time * p.fps)}</span>
          </span>
          <span className="flex-1" />
          <label className="flex items-center gap-2 text-[12px] text-muted cursor-pointer">
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} className="accent-white" />
            Snap marks to scene cuts
          </label>
        </div>

        <FrameStrip
          src={src}
          fps={p.fps}
          duration={p.duration}
          time={time}
          range={[-10, -10]}
          step={1}
          onSeek={(t) => {
            v.current?.pause();
            seek(t);
          }}
        />
      </section>

      <aside className="lg:border-l border-hair flex flex-col min-h-0">
        <div className="flex-1 min-h-0 p-6 space-y-7 overflow-y-auto">
          <div className="space-y-4">
            <div>
              <p className="text-faint text-[12px]">Play, pause where it changes, answer.</p>
              <h2 className="text-[22px] tracking-tight mt-1">Is he in frame?</h2>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => doMark(true)}
                className={`h-20 rounded-2xl text-[17px] font-medium transition-all ring-1 ${
                  state === true ? "bg-[rgba(74,222,128,0.9)] text-black ring-transparent" : "glass hover:bg-white/[0.08]"
                }`}
              >
                Yes
                <span className="block text-[11px] font-normal opacity-60">Y</span>
              </button>
              <button
                onClick={() => doMark(false)}
                className={`h-20 rounded-2xl text-[17px] font-medium transition-all ring-1 ${
                  state === false ? "bg-white text-black ring-transparent" : "glass hover:bg-white/[0.08]"
                }`}
              >
                No
                <span className="block text-[11px] font-normal opacity-60">N</span>
              </button>
            </div>
            <p className="text-muted text-[12px] leading-relaxed">
              Each answer applies from this frame until the next change. Start at 0:00 with Yes or No, press play, and
              pause the moment he appears or leaves. Space plays, ← → steps a frame, Shift ← → jumps to the next cut,
              ⌘Z undoes.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-[12px]">
              <span className="text-muted">Reviewed</span>
              <span className="tabular-nums">{watchedPct}%</span>
            </div>
            <div className="h-1 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-white" style={{ width: `${watchedPct}%` }} />
            </div>
            <div className="grid grid-cols-3 gap-2 pt-2 text-center">
              <Stat label="in frame" value={fmtShort(presentLen)} />
              <Stat label="changes" value={String(p.boundaries.length)} />
              <Stat label="scene cuts" value={p.cuts === null ? "…" : String(p.cuts.length)} />
            </div>
          </div>

          {p.boundaries.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-[13px]">Changes</h3>
              <ol className="glass rounded-2xl p-1.5 max-h-64 overflow-y-auto">
                {p.boundaries.map((b, i) => (
                  <li key={b.t} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.05]">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ background: b.present ? "rgba(74,222,128,0.9)" : "rgba(255,255,255,0.3)" }}
                    />
                    <button className="flex-1 text-left text-[12px] tabular-nums" onClick={() => seek(b.t + 0.001)}>
                      {fmt(b.t)} · {b.present ? "appears" : "leaves"}
                    </button>
                    <button
                      className="text-faint hover:text-ink text-[12px]"
                      aria-label="Remove change"
                      onClick={() => {
                        setHistory((h) => [...h, p.boundaries]);
                        update((x) => ({ ...x, boundaries: x.boundaries.filter((_, k) => k !== i) }));
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        <div className="p-6 border-t border-hair space-y-2">
          <button className="btn-primary" disabled={presentLen === 0} onClick={onNext}>
            Group the shots · {fmtShort(presentLen)}
          </button>
          <p className="text-faint text-[12px] text-center">
            {presentLen === 0
              ? "Mark at least one Yes"
              : unmarked > 0.05
                ? `First ${fmtShort(unmarked)} unmarked counts as not in frame`
                : watchedPct < 98
                  ? `Only ${watchedPct}% reviewed; the rest keeps its last answer`
                  : "Whole video reviewed"}
          </p>
        </div>
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass rounded-xl py-2">
      <div className="text-[15px] tabular-nums">{value}</div>
      <div className="text-faint text-[11px]">{label}</div>
    </div>
  );
}

// ============================================================================
// Step 3: Scenes

function ScenesStep(props: {
  p: Project;
  src: string;
  sel: string;
  setSel: (s: string) => void;
  present: { start: number; end: number }[];
  absent: { start: number; end: number }[];
  presentLen: number;
  groupedLen: number;
  onAuto: () => void;
  onAdd: () => void;
  onSetShot: (shotId: string, groupId: string | null) => void;
  onPatch: (id: string, patch: Partial<Group>) => void;
  onDelete: (id: string) => void;
  onFlip: (a: number, b: number, present: boolean) => void;
  onNewGroupFor: (shotId: string) => void;
  onNext: () => void;
  canNext: boolean;
  onTrim: (shotId: string) => void;
  onResync: (groupId: string | null) => void;
  resyncing: boolean;
}) {
  const { p, src, sel, setSel } = props;
  const [reelIdx, setReelIdx] = useState(0);
  const unassigned = p.shots.filter((s) => !s.groupId);
  const coverage = props.presentLen ? Math.round((props.groupedLen / props.presentLen) * 100) : 0;
  const group = p.groups.find((g) => g.id === sel);
  const shownShots =
    sel === "absent" ? [] : sel === "unassigned" ? unassigned : p.shots.filter((s) => s.groupId === sel);
  const reel = sel === "absent" ? props.absent : shownShots.map((s) => ({ start: s.start, end: s.end }));

  return (
    <div className="grid lg:grid-cols-[280px_minmax(0,1fr)] lg:h-[calc(100dvh-4rem)]">
      <aside className="lg:border-r border-hair p-5 space-y-5 overflow-y-auto">
        <div className="space-y-2">
          <div className="flex justify-between text-[12px]">
            <span className="text-muted">Footage with him, grouped</span>
            <span className="tabular-nums">{coverage}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden flex">
            {p.groups.map((g) => {
              const len = total(p.shots.filter((s) => s.groupId === g.id));
              return <div key={g.id} style={{ width: `${(len / (props.presentLen || 1)) * 100}%`, background: g.color }} />;
            })}
          </div>
          <p className="text-faint text-[11px]">
            {fmtShort(props.groupedLen)} of {fmtShort(props.presentLen)} · {p.shots.length} shots
          </p>
          <p className="text-faint text-[11px] tabular-nums leading-relaxed">
            Looks {fmtShort(props.groupedLen)} + not grouped {fmtShort(total(unassigned))} + not in frame{" "}
            {fmtShort(total(props.absent))} = {fmtShort(props.groupedLen + total(unassigned) + total(props.absent))} of{" "}
            {fmtShort(p.duration)}
          </p>
        </div>

        <nav className="space-y-1">
          {p.groups.map((g) => {
            const shots = p.shots.filter((s) => s.groupId === g.id);
            return (
              <SideItem
                key={g.id}
                on={sel === g.id}
                onClick={() => setSel(g.id)}
                color={g.color}
                title={g.name}
                meta={`${shots.length} shot${shots.length === 1 ? "" : "s"} · ${fmtShort(total(shots))}`}
              />
            );
          })}
          {unassigned.length > 0 && (
            <SideItem
              on={sel === "unassigned"}
              onClick={() => setSel("unassigned")}
              color="transparent"
              ring
              title="Not grouped yet"
              meta={`${unassigned.length} shot${unassigned.length === 1 ? "" : "s"} · ${fmtShort(total(unassigned))}`}
            />
          )}
          <div className="pt-3 mt-2 border-t border-hair">
            <SideItem
              on={sel === "absent"}
              onClick={() => setSel("absent")}
              color="rgba(255,255,255,0.15)"
              title="Not in frame"
              meta={`${props.absent.length} spans · ${fmtShort(total(props.absent))} · check he never appears`}
            />
          </div>
        </nav>

        <div className="flex flex-col gap-2">
          <button className="btn" onClick={props.onAdd}>New look</button>
          <button
            className="btn"
            disabled={props.resyncing}
            title="Snap every edge and scene cut to the real cut on the original video"
            onClick={() => props.onResync(null)}
          >
            Resync all edges
          </button>
          <button className="btn" onClick={props.onAuto}>Regroup with Claude</button>
        </div>
      </aside>

      <section className="flex flex-col min-w-0 min-h-0">
        <div className="flex-1 min-h-0 p-6 space-y-5 overflow-y-auto">
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0 space-y-1">
              {group ? (
                <>
                  <input
                    value={group.name}
                    onChange={(e) => props.onPatch(group.id, { name: e.target.value })}
                    className="bg-transparent text-[22px] tracking-tight w-full outline-none"
                  />
                  <input
                    value={group.description}
                    onChange={(e) => props.onPatch(group.id, { description: e.target.value })}
                    placeholder="How he looks here: outfit, headwear, sunglasses, framing"
                    className="bg-transparent text-muted text-[13px] w-full outline-none placeholder:text-faint"
                  />
                </>
              ) : (
                <>
                  <h2 className="text-[22px] tracking-tight">{sel === "absent" ? "Not in frame" : "Not grouped yet"}</h2>
                  <p className="text-muted text-[13px]">
                    {sel === "absent"
                      ? "Play it through. He should never appear here. If he does, mark that span as him."
                      : "Put every shot in a look before rendering."}
                  </p>
                </>
              )}
            </div>
            {!group && (sel === "absent" ? props.absent.length > 0 : unassigned.length > 0) && (
              <button
                className="btn"
                disabled={props.resyncing}
                title="Snap these edges to the real cut on the original video"
                onClick={() => props.onResync(sel)}
              >
                Resync edges
              </button>
            )}
            {group && (
              <>
                <button
                  className="btn"
                  disabled={props.resyncing}
                  title="Snap every edge in this look to the real cut on the original video"
                  onClick={() => props.onResync(group.id)}
                >
                  Resync edges
                </button>
                <button className="btn text-muted" onClick={() => props.onDelete(group.id)}>Delete look</button>
              </>
            )}
          </div>

          <div className="max-w-4xl space-y-2">
            <ReelPlayer src={src} fps={p.fps} spans={reel} onShot={setReelIdx} className="h-[44vh] max-w-full aspect-video mx-auto" />
            {sel !== "absent" && shownShots[reelIdx] && (
              <div className="flex justify-end">
                <button className="btn" onClick={() => props.onTrim(shownShots[reelIdx].id)}>
                  Trim shot {reelIdx + 1} frame by frame
                </button>
              </div>
            )}
          </div>

          {sel !== "absent" ? (
            <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
              {shownShots.map((s) => (
                <figure key={s.id} className="space-y-1.5">
                  <div className="relative rounded-xl overflow-hidden ring-1 ring-hair bg-black aspect-video">
                    {s.thumb && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.thumb} alt="" className="w-full h-full object-cover" />
                    )}
                    <span className="absolute left-1.5 bottom-1.5 text-[10px] tabular-nums bg-black/60 rounded px-1.5">
                      {fmt(s.start)} · {fmtShort(s.end - s.start)}
                    </span>
                  </div>
                  <div className="flex gap-1.5">
                    <select
                      value={s.groupId ?? ""}
                      onChange={(e) =>
                        e.target.value === "__new" ? props.onNewGroupFor(s.id) : props.onSetShot(s.id, e.target.value || null)
                      }
                      className="field py-1 px-2 text-[12px] flex-1 min-w-0"
                    >
                      <option value="">Not grouped</option>
                      {p.groups.map((g) => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                      <option value="__new">+ New look</option>
                    </select>
                    <button className="btn h-8 px-2.5 text-[11px]" title="Pick the exact first and last frame" onClick={() => props.onTrim(s.id)}>
                      Trim
                    </button>
                    <button
                      className="btn h-8 px-2.5 text-[11px]"
                      title="This isn't him: mark as not in frame"
                      onClick={() => props.onFlip(s.start, s.end, false)}
                    >
                      Not him
                    </button>
                  </div>
                </figure>
              ))}
            </div>
          ) : (
            <ol className="glass rounded-2xl p-1.5 max-w-2xl">
              {props.absent.map((a) => (
                <li key={`${a.start}`} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.04]">
                  <span className="text-[12px] tabular-nums flex-1">
                    {fmt(a.start)} – {fmt(a.end)} <span className="text-faint">· {fmtShort(a.end - a.start)}</span>
                  </span>
                  <button className="btn h-7 px-3 text-[12px]" onClick={() => props.onFlip(a.start, a.end, true)}>
                    He&apos;s in this
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="p-6 border-t border-hair flex items-center gap-4">
          <span className="text-faint text-[12px] flex-1">
            {unassigned.length
              ? `${unassigned.length} shot${unassigned.length === 1 ? "" : "s"} still need a look`
              : `${p.groups.length} looks · every shot with him is covered`}
          </span>
          <button className="btn-primary w-auto! px-8" disabled={!props.canNext} onClick={props.onNext}>
            Set up renders
          </button>
        </div>
      </section>
    </div>
  );
}

function SideItem({
  on,
  onClick,
  color,
  title,
  meta,
  ring,
}: {
  on: boolean;
  onClick: () => void;
  color: string;
  title: string;
  meta: string;
  ring?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-xl flex gap-3 items-start transition-colors ${
        on ? "bg-white/[0.09]" : "hover:bg-white/[0.04]"
      }`}
    >
      <span
        className={`mt-1 w-2.5 h-2.5 rounded-full shrink-0 ${ring ? "ring-1 ring-white/50" : ""}`}
        style={{ background: color }}
      />
      <span className="min-w-0">
        <span className="block text-[13px] truncate">{title}</span>
        <span className="block text-faint text-[11px]">{meta}</span>
      </span>
    </button>
  );
}

// ============================================================================
// Step 4: Render

function RenderStep(props: {
  p: Project;
  src: string;
  tasks: Record<string, Task>;
  onPatch: (id: string, patch: Partial<Group>) => void;
  onAddFaces: (files: File[], asDefault?: boolean) => Promise<string[]>;
  onOtherFace: (g: Group, i: number, faceId: string | undefined) => void;
  onToggleDefault: (id: string) => void;
  onRemoveFace: (id: string) => void;
  onToggleGroupFace: (gid: string, id: string) => void;
  onWrite: (g: Group) => void;
  onAnalyze: (g: Group) => void;
  onRender: (partIds: string[]) => void;
  onCheck: (partIds: string[]) => void;
  onUseTake: (shot: { start: number; end: number }, partId: string, j: number) => void;
  onRedoShot: (shot: { start: number; end: number }) => void;
  onTrimPiece: (partId: string, piece: number) => void;
  onFix: (part: Part) => void;
  onReject: (partId: string, piece: number, rejected: boolean) => void;
  onNext: () => void;
  onError: (m: string) => void;
  onRange: (r: { start: number; end: number }) => void;
}) {
  const { p } = props;
  const [snap, setSnap] = useState(true);
  const range = p.range ?? { start: 0, end: p.duration };
  const inRange = partsInRange(p);
  const toRender = inRange.filter((x) => x.status === "idle" || x.status === "failed");
  const doneIn = inRange.filter((x) => x.status === "done").length;
  const costOf = (pt: Part) => {
    const g = p.groups.find((x) => x.id === pt.groupId);
    const m = RENDER_MODELS.find((x) => x.id === g?.modelId) ?? RENDER_MODELS[0];
    return m.usdPerSec * pt.clipLength;
  };
  const est = toRender.reduce((s, pt) => s + costOf(pt), 0);
  const himInRange = total(clipTo(p.shots.map((s) => ({ start: s.start, end: s.end })), range));
  const renderedAll = covered(p);
  const renderedIn = total(clipTo(renderedAll, range));
  const acceptedPct = himInRange ? Math.min(100, Math.round((renderedIn / himInRange) * 100)) : 0;
  const issueCount = toRender.reduce((n, x) => n + (x.issues?.length ?? 0), 0);
  const activeGroups = p.groups.filter((g) => partsInRange(p, g.id).length > 0);
  const idleGroups = p.groups.filter((g) => !activeGroups.includes(g));
  const missingFaces = activeGroups.filter((g) => !refsOf(p, g).length && partsInRange(p, g.id).some((x) => x.status === "idle" || x.status === "failed"));
  const snapPoints = [...(p.cuts ?? []), ...p.boundaries.map((b) => b.t)];

  const paste = async () => {
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const it of items) {
        const t = it.types.find((x) => x.startsWith("image/"));
        if (t) files.push(new File([await it.getType(t)], `pasted-${Date.now()}.${t.split("/")[1]}`, { type: t }));
      }
      if (files.length) void props.onAddFaces(files);
      else props.onError("No image on the clipboard.");
    } catch {
      props.onError("Clipboard blocked. Use Upload instead.");
    }
  };
  const lib = p.library ?? [];
  const defaults = p.defaultRefs ?? [];

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <section className="glass rounded-3xl p-5 space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-60">
            <h2 className="text-[20px] tracking-tight">What to render</h2>
            <p className="text-muted text-[13px]">
              Drag the span. Only shots with him inside it are rendered, and anything already rendered is reused.
            </p>
          </div>
          <label className="flex items-center gap-2 text-[12px] text-muted cursor-pointer">
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} className="accent-white" />
            Snap to cuts
          </label>
          <div className="seg glass">
            <button onClick={() => props.onRange({ start: 0, end: p.duration })}>Whole video</button>
            <button onClick={() => p.shots.length && props.onRange({ start: Math.min(...p.shots.map((s) => s.start)), end: Math.max(...p.shots.map((s) => s.end)) })}>
              All of him
            </button>
          </div>
        </div>
        <div className="max-w-3xl mx-auto">
          <CompositePlayer
            src={props.src}
            fps={p.fps}
            span={range}
            renders={p.parts
              .filter((x) => x.status === "done" && x.resultUrl)
              .sort((a, b) => (a.renderedAt ?? 0) - (b.renderedAt ?? 0))
              .flatMap((x) =>
                x.pieces
                  .map((pc, j) => {
                    const k = keptRange(x, j);
                    return { start: k.start, end: k.end, offset: (x.measuredOffsets?.[j] ?? pc.offset) + (k.start - pc.start), url: x.resultUrl!, j };
                  })
                  .filter((r) => pieceLive(x, r.j)),
              )
              .reverse()}
            className="h-[34vh] max-w-full aspect-video mx-auto"
          />
        </div>
        <RangePicker
          duration={p.duration}
          blocks={p.shots.map((s) => ({ start: s.start, end: s.end, color: p.groups.find((g) => g.id === s.groupId)?.color ?? "#888" }))}
          rendered={renderedAll}
          snapPoints={snapPoints}
          snap={snap}
          range={range}
          onChange={props.onRange}
        />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
          <Stat label="span" value={fmtShort(range.end - range.start)} />
          <Stat label="him in span" value={fmtShort(himInRange)} />
          <Stat label={`kept · ${acceptedPct}% of him`} value={fmtShort(renderedIn)} />
          <Stat label={`to render · ${toRender.length} parts`} value={`$${est.toFixed(2)}`} />
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-48 h-1.5 rounded-full bg-white/10 overflow-hidden flex">
            {inRange.map((pt) => (
              <div
                key={pt.id}
                className="h-full border-r border-black/50"
                style={{
                  width: `${100 / (inRange.length || 1)}%`,
                  background:
                    pt.status === "done" ? "#fff" : pt.status === "failed" ? "rgba(252,165,165,0.8)" : pt.status === "idle" ? "transparent" : "rgba(255,255,255,0.4)",
                }}
              />
            ))}
          </div>
          <span className="text-muted text-[12px] tabular-nums">
            {doneIn} of {inRange.length} parts done
          </span>
          <button className="btn" disabled={!toRender.length} onClick={() => props.onCheck(toRender.map((x) => x.id))}>
            Check clips{issueCount ? ` · ${issueCount} issues` : ""}
          </button>
          <button
            className="btn btn-on"
            disabled={!toRender.length || missingFaces.length > 0}
            title={missingFaces.length ? `Add a face to: ${missingFaces.map((g) => g.name).join(", ")}` : ""}
            onClick={() => props.onRender(toRender.map((x) => x.id))}
          >
            Render {toRender.length ? `${toRender.length} part${toRender.length === 1 ? "" : "s"}` : "all"}
          </button>
          <button className="btn" disabled={doneIn === 0} onClick={props.onNext}>Assemble span</button>
        </div>
        {missingFaces.length > 0 && (
          <p className="text-[12px] text-muted">Add a face to {missingFaces.map((g) => g.name).join(", ")} to render.</p>
        )}
      </section>

      <ReviewPanel
        p={p}
        range={range}
        onUse={props.onUseTake}
        onRedo={props.onRedoShot}
        onTrim={(partId, j) => props.onTrimPiece(partId, j)}
      />

      <section className="glass rounded-3xl p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-60">
            <h2 className="text-[17px] tracking-tight">Faces</h2>
            <p className="text-muted text-[13px]">
              All your reference photos. Ticked ones are the default for the whole video; each look can pick its own below.
            </p>
          </div>
          <button className="btn" onClick={paste}>Paste</button>
          <label className="btn cursor-pointer">
            Upload
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void props.onAddFaces(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {lib.length === 0 ? (
          <p className="text-faint text-[12px]">No photos yet. Upload or paste one: a face shot, an outfit shot, or both.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {lib.map((f) => (
              <FaceTile
                key={f.id}
                file={f.file}
                label={f.label}
                on={defaults.includes(f.id)}
                onToggle={() => props.onToggleDefault(f.id)}
                onRemove={() => props.onRemoveFace(f.id)}
                caption={defaults.includes(f.id) ? "Default" : "Not default"}
              />
            ))}
          </div>
        )}
      </section>

      {activeGroups.map((g) => {
        const parts = partsInRange(p, g.id);
        const shots = p.shots.filter((s) => s.groupId === g.id && s.end > range.start && s.start < range.end);
        const len = total(clipTo(shots.map((s) => ({ start: s.start, end: s.end })), range));
        const left = total(pendingFor(p, g.id));
        const model = RENDER_MODELS.find((m) => m.id === g.modelId) ?? RENDER_MODELS[0];
        const writing = !!props.tasks[`prompt-${g.id}`];
        return (
          <section key={g.id} className="glass rounded-3xl p-5 space-y-5">
            <header className="flex items-start gap-3">
              <span className="mt-2 w-3 h-3 rounded-full" style={{ background: g.color }} />
              <div className="flex-1 min-w-0">
                <h3 className="text-[18px] tracking-tight">{g.name}</h3>
                <p className="text-muted text-[13px]">{g.description}</p>
                <p className="text-faint text-[12px] mt-0.5">
                  {shots.length} shots in span · {fmtShort(len)} · {left > 0.01 ? `${fmtShort(left)} to render` : "all rendered"}
                </p>
              </div>
            </header>

            <div className="space-y-1.5">
              <ReelPlayer
                src={props.src}
                fps={p.fps}
                spans={clipTo(shots.map((s) => ({ start: s.start, end: s.end })), range)}
                className="h-[30vh] max-w-full aspect-video"
              />
              <p className="text-faint text-[11px]">Every shot of this look inside the span, back to back. This is the footage that gets replaced.</p>
            </div>

            <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-5">
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[13px]">Who goes in</span>
                    <span className="text-faint text-[11px]">
                      {g.refIds?.length ? "Picked for this look" : defaults.length ? "Using the default" : "Pick at least one"}
                    </span>
                  </div>
                  {lib.length === 0 ? (
                    <p className="text-faint text-[11px]">Add photos in Faces above.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {lib.map((f) => {
                        const own = g.refIds?.length ? g.refIds.includes(f.id) : false;
                        const viaDefault = !g.refIds?.length && defaults.includes(f.id);
                        return (
                          <FaceTile
                            key={f.id}
                            small
                            file={f.file}
                            label={f.label}
                            on={own || viaDefault}
                            dim={viaDefault}
                            onToggle={() => props.onToggleGroupFace(g.id, f.id)}
                          />
                        );
                      })}
                      {!!g.refIds?.length && (
                        <button className="btn h-8 px-3 text-[11px]" onClick={() => props.onPatch(g.id, { refIds: [] })}>
                          Use default
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <WardrobePanel
                  group={g}
                  hasFaces={refsOf(p, g).length > 0}
                  busy={!!props.tasks[`wardrobe-${g.id}`]}
                  onAnalyze={() => props.onAnalyze(g)}
                  onChange={(w) =>
                    props.onPatch(g.id, {
                      wardrobe: w,
                      ...(g.promptEdited ? {} : { prompt: wardrobePrompt(g.description, w, refsOf(p, g).length) }),
                    })
                  }
                  onBuild={() =>
                    props.onPatch(g.id, { prompt: wardrobePrompt(g.description, g.wardrobe, refsOf(p, g).length), promptEdited: false })
                  }
                />
                <div className="space-y-2">
                  <span className="text-[13px]">Model</span>
                  <div className="flex flex-wrap gap-1.5">
                    {RENDER_MODELS.map((m) => (
                      <button
                        key={m.id}
                        className={`btn h-8 px-3 text-[12px] ${g.modelId === m.id ? "btn-on" : ""}`}
                        onClick={() => props.onPatch(g.id, { modelId: m.id })}
                      >
                        {m.name.replace(" (fal)", "")}
                      </button>
                    ))}
                  </div>
                  <p className="text-faint text-[11px]">{model.note} · ~${model.usdPerSec}/s</p>
                </div>
                <textarea
                  value={g.notes}
                  onChange={(e) => props.onPatch(g.id, { notes: e.target.value })}
                  placeholder="Notes for this look: keep the sunglasses, he turns sideways at the end…"
                  className="field text-[13px] resize-none"
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[13px]">Prompt</span>
                  <button className="btn h-7 px-3 text-[12px]" disabled={writing || !refsOf(p, g).length} onClick={() => props.onWrite(g)}>
                    {writing ? "Writing…" : g.prompt ? "Rewrite with Claude" : "Write with Claude"}
                  </button>
                </div>
                <textarea
                  value={g.prompt}
                  onChange={(e) => props.onPatch(g.id, { prompt: e.target.value, promptEdited: true })}
                  placeholder="Empty uses a safe default: replace him in every shot, keep wardrobe and sunglasses."
                  className="field text-[13px] leading-relaxed"
                  rows={8}
                />
              </div>
            </div>

            {g.wardrobe && (
              <PeoplePanel
                group={g}
                library={p.library ?? []}
                busy={(i) => !!props.tasks[`other-${g.id}-${i}`]}
                onFace={(i, id) => props.onOtherFace(g, i, id)}
                onUploadFace={async (i, files) => {
                  const ids = await props.onAddFaces(files, false);
                  if (ids[0]) props.onOtherFace(g, i, ids[0]);
                }}
                onChange={(others) => props.onPatch(g.id, { wardrobe: { ...g.wardrobe!, others } })}
              />
            )}

            <ol className="space-y-2">
              {parts.map((pt, i) => (
                <PartRow
                  key={pt.id}
                  onCheck={() => props.onCheck([pt.id])}
                  onFix={() => props.onFix(pt)}
                  onReject={(j, r) => props.onReject(pt.id, j, r)}
                  onTrim={(j) => props.onTrimPiece(pt.id, j)}
                  src={props.src}
                  fps={p.fps}
                  part={pt}
                  index={i}
                  stale={pt.status === "done" && ((!!pt.signature && pt.signature !== signature(pt, g, refsOf(p, g))) || renderOutdated(p, pt))}
                  outdated={pt.status === "done" && renderOutdated(p, pt)}
                  cost={costOf(pt)}
                  canRender={refsOf(p, g).length > 0}
                  onRender={() => props.onRender([pt.id])}
                />
              ))}
            </ol>
          </section>
        );
      })}

      {idleGroups.length > 0 && (
        <p className="text-faint text-[12px]">
          Not in this span: {idleGroups.map((g) => g.name).join(", ")}
        </p>
      )}
    </div>
  );
}

function WardrobePanel({
  group,
  hasFaces,
  busy,
  onAnalyze,
  onChange,
  onBuild,
}: {
  group: Group;
  hasFaces: boolean;
  busy: boolean;
  onAnalyze: () => void;
  onChange: (w: Wardrobe) => void;
  onBuild: () => void;
}) {
  const w = group.wardrobe;
  const clashes = w ? wardrobeClashes(w) : [];
  const set = (side: "target" | "reference", i: number, on: boolean) =>
    w && onChange({ ...w, [side]: w[side].map((x, k) => (k === i ? { ...x, on } : x)) });
  const remove = (side: "target" | "reference", i: number) => w && onChange({ ...w, [side]: w[side].filter((_, k) => k !== i) });
  const add = (side: "target" | "reference", label: string) =>
    onChange({
      target: w?.target ?? [],
      reference: w?.reference ?? [{ label: "Face", on: true }],
      [side]: [...(w?.[side] ?? (side === "reference" ? [{ label: "Face", on: true }] : [])), { label, on: true }],
    } as Wardrobe);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[13px]">Wardrobe</span>
        <button
          className="btn h-7 px-3 text-[12px]"
          disabled={busy || !hasFaces}
          title={hasFaces ? "Claude lists what he wears here and what your photo has" : "Pick a face first"}
          onClick={onAnalyze}
        >
          {busy ? "Reading…" : w ? "Analyze again" : "Analyze"}
        </button>
      </div>
      {!w ? (
        <p className="text-faint text-[11px]">
          Analyze to list what he wears in this look and what your reference photo has, then tick what to keep and what
          to take. Or{" "}
          <button className="underline text-muted" onClick={() => onChange({ target: [], reference: [{ label: "Face", on: true }] })}>
            start the list by hand
          </button>
          .
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <ItemList
            title="Take from the photo"
            items={w.reference}
            locked={(x) => /^face$/i.test(x.label)}
            onToggle={(i, on) => set("reference", i, on)}
            onRemove={(i) => remove("reference", i)}
            onAdd={(l) => add("reference", l)}
          />
          <ItemList
            title="Keep from the original"
            items={w.target}
            onToggle={(i, on) => set("target", i, on)}
            onRemove={(i) => remove("target", i)}
            onAdd={(l) => add("target", l)}
          />
        </div>
      )}
      {clashes.map((c) => (
        <p key={c} className="text-[11px] text-[#fcd34d]">{c}</p>
      ))}
      {w && (
        <p className="text-faint text-[11px]">
          {w.alone ? "Alone in this look · " : ""}
          {w.faceHidden ? "face hidden in some frames · " : ""}
          {w.performance ?? ""}
        </p>
      )}
      <button className="btn w-full" onClick={onBuild}>
        {group.promptEdited ? "Rebuild prompt (replaces your edits)" : "Rebuild prompt from checklist"}
      </button>
    </div>
  );
}

type ShotState = "done" | "review" | "missing" | "queued";

function ReviewPanel({
  p,
  range,
  onUse,
  onRedo,
  onTrim,
}: {
  p: Project;
  range: { start: number; end: number };
  onUse: (shot: { start: number; end: number }, partId: string, j: number) => void;
  onRedo: (shot: { start: number; end: number }) => void;
  onTrim: (partId: string, j: number) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ shot: string; take: string } | null>(null);
  const rows = p.shots
    .filter((s) => s.groupId && s.end > range.start + 1e-3 && s.start < range.end - 1e-3)
    .sort((a, b) => a.start - b.start)
    .map((s) => {
      const r = { start: Math.max(s.start, range.start), end: Math.min(s.end, range.end) };
      const takes = takesFor(p, r);
      const live = takes.filter((t) => t.live);
      const chosen = live[live.length - 1];
      const inFlight = p.parts.some(
        (pt) => (pt.status === "rendering" || pt.status === "building" || pt.status === "uploading") && pt.pieces.some((pc) => pc.end > r.start && pc.start < r.end),
      );
      const state: ShotState = chosen ? (live.every((t) => t.reviewed) ? "done" : "review") : inFlight ? "queued" : "missing";
      return { shot: s, r, takes, chosen, state };
    });
  const len = (range.end - range.start) || 1;
  const pct = (t: number) => `${((t - range.start) / len) * 100}%`;
  const count = (st: ShotState) => rows.filter((x) => x.state === st).length;
  const color: Record<ShotState, string> = {
    done: "#ffffff",
    review: "#fcd34d",
    missing: "#fca5a5",
    queued: "rgba(255,255,255,0.35)",
  };
  const label: Record<ShotState, string> = { done: "Reviewed", review: "To review", missing: "Needs a render", queued: "Rendering" };
  const nextUp = rows.find((x) => x.state === "review");

  return (
    <section className="glass rounded-3xl p-5 space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-60">
          <h2 className="text-[17px] tracking-tight">Review</h2>
          <p className="text-muted text-[13px]">
            Every shot with him in the span, with every take ever rendered for it. Pick the take to use; old takes are kept.
          </p>
        </div>
        <div className="flex gap-3 text-[12px] tabular-nums">
          {(["done", "review", "missing", "queued"] as ShotState[]).map((st) => (
            <span key={st} className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color[st] }} /> {count(st)} {label[st].toLowerCase()}
            </span>
          ))}
        </div>
        <button className="btn btn-on" disabled={!nextUp} onClick={() => nextUp && setOpen(nextUp.shot.id)}>
          {nextUp ? "Next to review" : "All reviewed"}
        </button>
      </div>

      <div className="relative h-6 rounded-lg overflow-hidden bg-white/[0.04] ring-1 ring-hair">
        {rows.map((x) => (
          <button
            key={x.shot.id}
            onClick={() => setOpen(x.shot.id)}
            className={`absolute inset-y-0 border-r border-black/50 ${open === x.shot.id ? "ring-2 ring-inset ring-white" : ""}`}
            style={{ left: pct(x.r.start), width: pct(range.start + x.r.end - x.r.start), background: color[x.state], opacity: x.state === "done" ? 0.85 : 0.75 }}
            title={`${fmt(x.r.start)} · ${label[x.state]}`}
          />
        ))}
      </div>

      <ol className="max-h-[60vh] overflow-y-auto space-y-1.5 pr-1">
        {rows.map((x, idx) => {
          const g = p.groups.find((gg) => gg.id === x.shot.groupId);
          const isOpen = open === x.shot.id;
          return (
            <li key={x.shot.id} className={`rounded-2xl ring-1 ${isOpen ? "ring-white/40 bg-white/[0.03]" : "ring-hair"} p-2.5`}>
              <button className="w-full flex items-center gap-3 text-left" onClick={() => setOpen(isOpen ? null : x.shot.id)}>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color[x.state] }} />
                <span className="text-faint text-[11px] tabular-nums w-6">{idx + 1}</span>
                {x.shot.thumb && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={x.shot.thumb} alt="" className="h-9 aspect-video object-cover rounded-md ring-1 ring-hair" />
                )}
                <span className="flex-1 min-w-0">
                  <span className="block text-[12px] tabular-nums">
                    {fmt(x.r.start)} – {fmt(x.r.end)} <span className="text-faint">· {Math.round((x.r.end - x.r.start) * p.fps)}f</span>
                  </span>
                  <span className="block text-[11px] text-muted truncate">
                    <span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle" style={{ background: g?.color }} />
                    {g?.name} · {x.takes.length} take{x.takes.length === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="text-[11px] text-muted">{label[x.state]}</span>
              </button>

              {isOpen && (
                <div className="mt-3 space-y-3">
                  {x.takes.length === 0 ? (
                    <p className="text-[12px] text-muted">
                      No take yet. {x.state === "queued" ? "It's rendering." : "It's in a Ready part below; render it."}
                    </p>
                  ) : (
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {x.takes.map((t, n) => {
                        const key = `${t.part.id}:${t.j}`;
                        const off = (t.part.measuredOffsets?.[t.j] ?? t.part.pieces[t.j].offset) + (t.range.start - t.part.pieces[t.j].start);
                        const isChosen = x.chosen && x.chosen.part.id === t.part.id && x.chosen.j === t.j;
                        return (
                          <div key={key} className={`rounded-xl p-2 space-y-2 ring-1 ${isChosen ? "ring-white" : "ring-hair"} ${t.rejected ? "opacity-50" : ""}`}>
                            {playing?.shot === x.shot.id && playing.take === key ? (
                              <ReelPlayer src={t.part.resultUrl!} fps={24} spans={[{ start: off, end: off + (t.range.end - t.range.start) }]} className="aspect-video" />
                            ) : (
                              <button
                                className="w-full aspect-video rounded-lg bg-black ring-1 ring-hair grid place-items-center text-[12px] text-muted hover:text-ink"
                                onClick={() => setPlaying({ shot: x.shot.id, take: key })}
                              >
                                ▶ Play take {n + 1}
                              </button>
                            )}
                            <div className="flex items-center gap-2 text-[11px]">
                              <span className="flex-1 text-muted tabular-nums">
                                Take {n + 1} · {new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                {isChosen ? (t.reviewed ? " · in use ✓" : " · in use, not reviewed") : t.rejected ? " · redo" : " · alternative"}
                              </span>
                              <button className="btn h-7 px-2.5 text-[11px]" onClick={() => onTrim(t.part.id, t.j)}>Trim</button>
                              <button
                                className={`btn h-7 px-2.5 text-[11px] ${isChosen && t.reviewed ? "btn-on" : ""}`}
                                onClick={() => onUse(x.r, t.part.id, t.j)}
                              >
                                Use this take
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {x.takes.length > 0 && (
                    <div className="flex justify-end">
                      <button className="btn h-8 px-3 text-[12px]" onClick={() => onRedo(x.r)}>
                        None of these: redo this shot
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function PeoplePanel({
  group,
  library,
  busy,
  onFace,
  onUploadFace,
  onChange,
}: {
  group: Group;
  library: { id: string; file: StoredFile; label: string }[];
  busy: (i: number) => boolean;
  onFace: (i: number, faceId: string | undefined) => void;
  onUploadFace: (i: number, files: File[]) => void;
  onChange: (others: NonNullable<Wardrobe["others"]>) => void;
}) {
  const others = group.wardrobe?.others ?? [];
  const setShot = async (i: number, f: File) => {
    const j = await toJpeg(f, f.name || "person.png", 480).catch(() => null);
    if (!j) return;
    const url = await blobToDataUrl(j.blob);
    onChange(others.map((o, k) => (k === i ? { ...o, thumb: url } : o)));
  };
  const pasteShot = async (i: number) => {
    try {
      for (const it of await navigator.clipboard.read()) {
        const t = it.types.find((x) => x.startsWith("image/"));
        if (t) return setShot(i, new File([await it.getType(t)], "person.png", { type: t }));
      }
    } catch {}
  };
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h4 className="text-[14px]">Other people in this look</h4>
        <span className="text-faint text-[11px]">Pick a face to replace someone; no face = they stay as they are.</span>
      </div>
      {others.length === 0 && <p className="text-faint text-[12px]">Nobody else detected in this look.</p>}
      <div className="grid md:grid-cols-2 gap-3">
        {others.map((o, i) => (
          <div key={`${o.label}-${i}`} className="rounded-2xl ring-1 ring-hair p-3 space-y-3">
            <div className="flex gap-3">
              <div className="w-24 shrink-0 space-y-1.5">
                <div className="w-24 h-24 rounded-xl overflow-hidden bg-white/[0.04] ring-1 ring-hair grid place-items-center">
                  {o.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={o.thumb} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-faint text-[11px] text-center px-2">No picture</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <button className="btn h-6 px-0 text-[10px] w-full" onClick={() => pasteShot(i)} title="Paste a screenshot of this person">Paste</button>
                  <label className="btn h-6 px-0 text-[10px] w-full cursor-pointer" title="Pick a screenshot of this person">
                    File
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && setShot(i, e.target.files[0])} />
                  </label>
                </div>
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                <textarea
                  value={o.label}
                  onChange={(e) => onChange(others.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))}
                  rows={2}
                  className="w-full bg-transparent text-[12px] leading-snug resize-none outline-none"
                />
                <div className="space-y-1">
                  <span className="text-[11px] text-muted">Replace with</span>
                  <div className="flex flex-wrap gap-1.5 items-center">
                    <button
                      className={`btn h-8 px-2.5 text-[11px] ${!o.faceId ? "btn-on" : ""}`}
                      onClick={() => onFace(i, undefined)}
                    >
                      Keep as is
                    </button>
                    {library.map((f) => (
                      <FaceTile key={f.id} small file={f.file} label={f.label} on={o.faceId === f.id} onToggle={() => onFace(i, o.faceId === f.id ? undefined : f.id)} />
                    ))}
                    <label className="btn h-8 px-2.5 text-[11px] cursor-pointer">
                      Upload face
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          onUploadFace(i, Array.from(e.target.files ?? []));
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>
              <button
                className="text-faint hover:text-ink text-[12px] self-start"
                onClick={() => onChange(others.filter((_, k) => k !== i))}
                aria-label="Remove person"
              >
                ×
              </button>
            </div>
            {o.faceId && (
              busy(i) ? (
                <p className="text-faint text-[11px]">Reading their outfit…</p>
              ) : o.wardrobe ? (
                <div className="grid grid-cols-2 gap-2">
                  <ItemList
                    title="Take from the photo"
                    items={o.wardrobe.reference}
                    locked={(x) => /^face$/i.test(x.label)}
                    onToggle={(k, on) => onChange(others.map((x, n) => (n === i && x.wardrobe ? { ...x, wardrobe: { ...x.wardrobe, reference: x.wardrobe.reference.map((r, m) => (m === k ? { ...r, on } : r)) } } : x)))}
                    onRemove={(k) => onChange(others.map((x, n) => (n === i && x.wardrobe ? { ...x, wardrobe: { ...x.wardrobe, reference: x.wardrobe.reference.filter((_, m) => m !== k) } } : x)))}
                    onAdd={(l) => onChange(others.map((x, n) => (n === i && x.wardrobe ? { ...x, wardrobe: { ...x.wardrobe, reference: [...x.wardrobe.reference, { label: l, on: true }] } } : x)))}
                  />
                  <ItemList
                    title="Keep from them"
                    items={o.wardrobe.target}
                    onToggle={(k, on) => onChange(others.map((x, n) => (n === i && x.wardrobe ? { ...x, wardrobe: { ...x.wardrobe, target: x.wardrobe.target.map((r, m) => (m === k ? { ...r, on } : r)) } } : x)))}
                    onRemove={(k) => onChange(others.map((x, n) => (n === i && x.wardrobe ? { ...x, wardrobe: { ...x.wardrobe, target: x.wardrobe.target.filter((_, m) => m !== k) } } : x)))}
                    onAdd={(l) => onChange(others.map((x, n) => (n === i && x.wardrobe ? { ...x, wardrobe: { ...x.wardrobe, target: [...x.wardrobe.target, { label: l, on: true }] } } : x)))}
                  />
                </div>
              ) : null
            )}
          </div>
        ))}
      </div>
      <OtherAdd onAdd={(label) => onChange([...others, { label }])} />
    </section>
  );
}

function OtherAdd({ onAdd }: { onAdd: (label: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim()) onAdd(draft.trim());
        setDraft("");
      }}
    >
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="+ add a person (e.g. man in yellow cap on the right)"
        className="w-full bg-transparent text-[12px] outline-none placeholder:text-faint"
      />
    </form>
  );
}

function ItemList({
  title,
  items,
  locked,
  onToggle,
  onRemove,
  onAdd,
}: {
  title: string;
  items: { label: string; on: boolean }[];
  locked?: (x: { label: string; on: boolean }) => boolean;
  onToggle: (i: number, on: boolean) => void;
  onRemove: (i: number) => void;
  onAdd: (label: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="rounded-xl ring-1 ring-hair p-2.5 space-y-1.5">
      <span className="block text-[11px] text-muted">{title}</span>
      {items.map((x, i) => {
        const lock = locked?.(x);
        return (
          <label key={`${x.label}-${i}`} className="flex items-center gap-2 text-[12px] group cursor-pointer">
            <input
              type="checkbox"
              checked={lock ? true : x.on}
              disabled={lock}
              onChange={(e) => onToggle(i, e.target.checked)}
              className="accent-white"
            />
            <span className={`flex-1 ${x.on || lock ? "" : "text-faint line-through"}`}>{x.label}</span>
            {!lock && (
              <button className="text-faint opacity-0 group-hover:opacity-100" onClick={(e) => { e.preventDefault(); onRemove(i); }} aria-label="Remove">
                ×
              </button>
            )}
          </label>
        );
      })}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) onAdd(draft.trim());
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="+ add item"
          className="w-full bg-transparent text-[12px] outline-none placeholder:text-faint"
        />
      </form>
    </div>
  );
}

function FaceTile({
  file,
  label,
  on,
  dim,
  small,
  caption,
  onToggle,
  onRemove,
}: {
  file: StoredFile;
  label: string;
  on: boolean;
  dim?: boolean;
  small?: boolean;
  caption?: string;
  onToggle: () => void;
  onRemove?: () => void;
}) {
  const url = useMemo(() => URL.createObjectURL(file.blob), [file.blob]);
  return (
    <div className={`relative group ${small ? "w-14" : "w-24"} space-y-1`}>
      <button
        onClick={onToggle}
        className={`relative block w-full aspect-square rounded-xl overflow-hidden transition ${
          on ? (dim ? "ring-2 ring-white/40" : "ring-2 ring-white") : "ring-1 ring-hair opacity-50 hover:opacity-100"
        }`}
        title={label}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" className="w-full h-full object-cover" />
        {on && (
          <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-white text-black text-[10px] grid place-items-center">✓</span>
        )}
      </button>
      {!small && <span className="block text-[11px] truncate text-muted">{caption ?? label}</span>}
      {onRemove && (
        <button
          onClick={onRemove}
          className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-white text-black text-[11px] opacity-0 group-hover:opacity-100"
          aria-label="Remove photo"
        >
          ×
        </button>
      )}
    </div>
  );
}

function PartRow({
  onCheck,
  onFix,
  onReject,
  onTrim,
  src,
  fps,
  part,
  index,
  stale,
  outdated,
  cost,
  canRender,
  onRender,
}: {
  onCheck: () => void;
  onFix: () => void;
  onReject: (piece: number, rejected: boolean) => void;
  onTrim: (piece: number) => void;
  src: string;
  fps: number;
  part: Part;
  index: number;
  stale: boolean;
  outdated?: boolean;
  cost: number;
  canRender: boolean;
  onRender: () => void;
}) {
  const label: Record<Part["status"], string> = {
    idle: "Ready",
    building: "Building clip",
    uploading: "Uploading",
    rendering: "Rendering",
    done: outdated ? "Outdated · shot edges changed, a new part replaces it" : stale ? "Done · settings changed" : "Done",
    failed: "Failed",
  };
  const busy = part.status === "building" || part.status === "uploading" || part.status === "rendering";
  const padLen = part.clipLength - part.duration;
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-2xl ring-1 ring-hair p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-4">
      <span className="text-[13px] w-16">Part {index + 1}</span>
      <span className="text-muted text-[12px] tabular-nums w-48">
        {part.pieces.length} pieces · {fmtShort(part.duration)}
        {padLen > 0.05 ? ` + ${fmtShort(padLen)} loop` : ""}
      </span>
      <span className="flex items-center gap-2 text-[12px] min-w-40">
        <span
          className={`w-2 h-2 rounded-full ${busy ? "animate-pulse" : ""}`}
          style={{
            background:
              part.status === "done" ? (stale ? "#fcd34d" : "#86efac") : part.status === "failed" ? "#fca5a5" : busy ? "#fff" : "rgba(255,255,255,0.3)",
          }}
        />
        {label[part.status]}
        {part.progress !== undefined && busy && <span className="text-faint tabular-nums">{Math.round(part.progress * 100)}%</span>}
      </span>
      {part.error && <span className="text-[12px] text-[#fca5a5] break-all flex-1 min-w-48">{part.error}</span>}
      <span className="flex-1" />
      {part.resultUrl && !open && (
        <video src={part.resultUrl} muted playsInline className="h-12 rounded-md ring-1 ring-hair bg-black" />
      )}
      <span className="text-faint text-[12px] tabular-nums">~${cost.toFixed(2)}</span>
      {(part.status === "idle" || part.status === "failed") && (
        <button className="btn" onClick={onCheck} title="Build the clip locally and look for frames from other scenes">
          {part.checkedKey ? "Checked ✓" : "Check"}
        </button>
      )}
      <button className="btn" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : part.status === "done" ? "Review" : "Preview"}</button>
      <button className={`btn ${part.status === "idle" ? "btn-on" : ""}`} disabled={busy || !canRender || outdated} onClick={onRender}>
        {outdated ? "Superseded" : part.status === "done" || part.status === "failed" ? "Re-roll" : "Render"}
      </button>
      </div>
      {!!part.issues?.length && part.status !== "done" && (
        <div className="rounded-xl bg-[rgba(252,211,77,0.08)] ring-1 ring-[rgba(252,211,77,0.3)] p-3 space-y-2">
          <div className="flex items-center gap-3">
            <span className="text-[13px] flex-1">Frames from another scene in this clip</span>
            <button className="btn btn-on h-8 px-3 text-[12px]" onClick={onFix}>Fix all</button>
          </div>
          <ul className="text-[12px] text-muted space-y-0.5 tabular-nums">
            {part.issues.map((is, k) => (
              <li key={k}>
                {fmt(is.at)} ·{" "}
                {is.kind === "start"
                  ? `${is.frames} frame${is.frames === 1 ? "" : "s"} at the start of a shot: trim onto the previous shot`
                  : is.kind === "end"
                    ? `${is.frames} frame${is.frames === 1 ? "" : "s"} at the end of a shot: trim onto the next shot`
                    : "a cut inside a shot that wasn't marked: split the shot here"}
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && part.status === "done" && part.resultUrl && (
        <div className="space-y-2">
          <span className="text-[12px] text-muted">
            Review each piece. Redo frees just that footage; it comes back as a new part to render.
          </span>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {part.pieces.map((pc, j) => {
              const k = part.trims?.[j] ?? { start: pc.start, end: pc.end };
              const off = (part.measuredOffsets?.[j] ?? pc.offset) + (k.start - pc.start);
              const trimmed = !!part.trims?.[j];
              const rej = part.rejected?.includes(j);
              return (
                <div key={j} className={`space-y-1.5 ${rej ? "opacity-50" : ""}`}>
                  <ReelPlayer src={part.resultUrl!} fps={24} spans={[{ start: off, end: off + (k.end - k.start) }]} className="aspect-video" />
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted tabular-nums flex-1">
                      {j + 1} · {fmt(k.start)} · {Math.round((k.end - k.start) * fps)}f{trimmed ? " · trimmed" : ""}
                    </span>
                    <button className="btn h-7 px-2.5 text-[11px]" disabled={rej} onClick={() => onTrim(j)} title="Pick the first and last good frame">
                      Trim
                    </button>
                    <div className="seg glass">
                      <button className={!rej ? "on" : ""} onClick={() => onReject(j, false)}>Keep</button>
                      <button className={rej ? "on" : ""} onClick={() => onReject(j, true)}>Redo</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {open && (
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <span className="text-[12px] text-muted">What gets sent{padLen > 0.05 ? ` (last ${fmtShort(padLen)} is loop filler, thrown away)` : ""}</span>
            <ReelPlayer src={src} fps={fps} spans={[...part.pieces, ...part.pad]} className="aspect-video" />
          </div>
          {part.resultUrl && (
            <div className="space-y-1.5">
              <span className="text-[12px] text-muted">What came back</span>
              <video src={part.resultUrl} controls playsInline className="w-full aspect-video rounded-2xl ring-1 ring-hair bg-black" />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ============================================================================
// Step 5: Assemble

function AssembleStep(props: {
  p: Project;
  present: { start: number; end: number }[];
  rangeMode: "range" | "all" | "span";
  setRangeMode: (m: "range" | "all" | "span") => void;
  busy: boolean;
  onAssemble: () => void;
  outUrl: string | null;
  onSave: () => void;
  onBack: () => void;
}) {
  const { p } = props;
  const span = props.present.length ? { start: props.present[0].start, end: props.present[props.present.length - 1].end } : null;
  const doneShots = new Set(p.parts.filter((x) => x.status === "done").flatMap((x) => x.pieces.map((pc) => pc.shotId)));
  const missingShots = p.shots.filter((s) => !doneShots.has(s.id));

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="grid md:grid-cols-[minmax(0,1fr)_320px] gap-6">
        <div className="space-y-4">
          {props.outUrl ? (
            <video src={props.outUrl} controls playsInline className="w-full rounded-2xl ring-1 ring-hair bg-black" />
          ) : (
            <div className="aspect-video rounded-2xl ring-1 ring-hair bg-white/[0.02] grid place-items-center text-muted text-[13px]">
              The assembled video shows up here
            </div>
          )}
          <SpotTrack
            duration={p.duration}
            boundaries={p.boundaries}
            cuts={null}
            time={0}
            watched={p.duration}
            onSeek={() => {}}
            groups={p.parts
              .filter((x) => x.status === "done")
              .flatMap((x) =>
                x.pieces.map((pc) => ({ start: pc.start, end: pc.end, color: p.groups.find((g) => g.id === x.groupId)?.color ?? "#fff" })),
              )}
          />
          <p className="text-faint text-[12px]">Colored marks under the bar are the rendered pieces that go back in.</p>
        </div>

        <aside className="space-y-5">
          <div className="glass rounded-2xl p-4 space-y-3">
            <h3 className="text-[14px]">Checklist</h3>
            <ul className="space-y-2">
              {p.groups.map((g) => {
                const parts = p.parts.filter((x) => x.groupId === g.id);
                const d = parts.filter((x) => x.status === "done").length;
                return (
                  <li key={g.id} className="flex items-center gap-2 text-[13px]">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: g.color }} />
                    <span className="flex-1 truncate">{g.name}</span>
                    <span className={`tabular-nums text-[12px] ${d === parts.length ? "" : "text-muted"}`}>
                      {d === parts.length ? "✓" : `${d}/${parts.length}`}
                    </span>
                  </li>
                );
              })}
            </ul>
            {missingShots.length > 0 && (
              <p className="text-[12px] text-muted">
                {missingShots.length} shot{missingShots.length === 1 ? "" : "s"} ({fmtShort(total(missingShots))}) not rendered yet will
                stay original.
              </p>
            )}
          </div>

          <div className="glass rounded-2xl p-4 space-y-3">
            <h3 className="text-[14px]">Length</h3>
            {p.range && (
              <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                <input type="radio" checked={props.rangeMode === "range"} onChange={() => props.setRangeMode("range")} className="accent-white" />
                Render span · {fmt(p.range.start)} – {fmt(p.range.end)}
              </label>
            )}
            <label className="flex items-center gap-2 text-[13px] cursor-pointer">
              <input type="radio" checked={props.rangeMode === "all"} onChange={() => props.setRangeMode("all")} className="accent-white" />
              Whole video · {fmt(p.duration)}
            </label>
            {span && (
              <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                <input type="radio" checked={props.rangeMode === "span"} onChange={() => props.setRangeMode("span")} className="accent-white" />
                First to last appearance · {fmt(span.start)} – {fmt(span.end)}
              </label>
            )}
            <p className="text-faint text-[11px]">Original audio throughout. Output at the render resolution.</p>
          </div>

          <button className="btn-primary" disabled={props.busy} onClick={props.onAssemble}>
            {props.busy ? "Assembling…" : props.outUrl ? "Assemble again" : "Assemble"}
          </button>
          {props.outUrl && (
            <button className="btn w-full h-10" onClick={props.onSave}>Save video</button>
          )}
          <button className="btn w-full" onClick={props.onBack}>Back to renders</button>
        </aside>
      </div>
    </div>
  );
}
