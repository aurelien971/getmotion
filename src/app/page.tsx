"use client";

import { fal } from "@fal-ai/client";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { MODELS, SAM2_VIDEO } from "@/lib/models";
import { muxAudio, NoDecoderError, probeVideoCodec, stitchVideos, trimVideo, warmUp } from "@/lib/trim";
import { transcodeInBrowser } from "@/lib/transcode";
import { Trimmer } from "@/components/Trimmer";
import { FrameStrip } from "@/components/FrameStrip";
import { kv, type SavedSession } from "@/lib/store";

fal.config({ proxyUrl: "/api/fal/proxy" });

type Point = { x: number; y: number; label: 0 | 1 };
type Result = { url: string; model: string; at: number; localUrl?: string };
type CastSlot = { file: File; preview: string; who: string };
type StitchItem = { id: number; name: string; url: string };
type Frame = { id: number; url: string; blob: Blob; frame: number; time: number };
type Shot = { id: number; name: string; url: string; blob: Blob };
type Direction = { prompt: string; target: string; shots: string[]; warnings: string[] };

const HISTORY_KEY = "getmotion.history";

function loadHistory(): Result[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Submit to Sume through our server routes and poll until done; returns the video URL.
async function runSume(model: string, input: Record<string, unknown>, onStatus: (s: string) => void) {
  const sub = await fetch("/api/sume/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, ...input }),
  }).then((r) => r.json());
  const id = sub.request_id ?? sub.id ?? sub.job_id;
  if (!id) throw new Error(`Sume: ${JSON.stringify(sub)}`);
  let wait = (sub.next_poll_after_seconds ?? 5) * 1000;
  for (;;) {
    await sleep(wait);
    const st = await fetch(`/api/sume/job/${id}?part=status`).then((r) => r.json());
    const status = st.sume_status ?? st.status;
    onStatus(String(status));
    if (st.terminal || ["completed", "failed", "canceled"].includes(status)) {
      if (status !== "completed") throw new Error(`Sume job ${status}: ${JSON.stringify(st)}`);
      break;
    }
    wait = (st.next_poll_after_seconds ?? 5) * 1000;
  }
  const res = await fetch(`/api/sume/job/${id}?part=result`).then((r) => r.json());
  const url = (res.result ?? res).artifacts?.find((a: { url: string }) => a.url)?.url;
  if (!url) throw new Error(`Sume result: ${JSON.stringify(res)}`);
  return url as string;
}

// fal's ApiError hides the useful part in .body; pull it out.
function describeError(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { message?: string; status?: number; body?: unknown };
    const body = o.body as { detail?: unknown } | undefined;
    const detail = body?.detail;
    const text =
      typeof detail === "string"
        ? detail
        : detail
          ? JSON.stringify(detail)
          : o.body
            ? JSON.stringify(o.body)
            : o.message;
    return `${o.status ? `HTTP ${o.status}: ` : ""}${text ?? String(e)}`;
  }
  return String(e);
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}:${sec}`;
};

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const maskRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastTime = useRef(0);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null); // fal CDN
  const [localVideo, setLocalVideo] = useState<string | null>(null);
  const [fps, setFps] = useState(30);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dims, setDims] = useState({ w: 16, h: 9 });
  const [playing, setPlaying] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [points, setPoints] = useState<Point[]>([]);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [maskOk, setMaskOk] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<"trim" | "mask">("mask");
  const [maxLen, setMaxLen] = useState<number>(15);
  const [range, setRange] = useState<[number, number]>([0, 15]);

  const [cast, setCast] = useState<CastSlot[]>([]);
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState(MODELS[0].id);

  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Result[]>([]);
  const [stitch, setStitch] = useState<StitchItem[]>([]);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [cutStage, setCutStage] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<Frame | null>(null);
  const [stripStep, setStripStep] = useState(1); // frames per thumbnail in the frame strip
  const [shots, setShots] = useState<Shot[]>([]);
  const [notes, setNotesState] = useState("");
  const setNotes = (v: string) => {
    setNotesState(v);
    try { localStorage.setItem("getmotion.notes", v); } catch {}
  };
  const [direction, setDirection] = useState<Direction | null>(null);
  const [directed, setDirectedState] = useState("");
  const setDirected = (v: string) => {
    setDirectedState(v);
    try { localStorage.setItem("getmotion.directed", v); } catch {}
  };
  const [directing, setDirecting] = useState(false);
  const [restored, setRestored] = useState(false);
  const pasteTarget = useRef<"face" | "shot">("face");

  // Dev only: ?clip=/dev-long.mp4 loads a clip from /public for quick checks.
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const name = new URLSearchParams(window.location.search).get("clip");
    if (!name) return;
    fetch(name)
      .then((r) => r.blob())
      .then((b) => onVideo(new File([b], name.split("/").pop() || "clip.mp4", { type: "video/mp4" })));
  }, []);

  useEffect(() => {
    // Hydrate saved takes, prompt and notes after mount so server and client markup match.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistory(loadHistory());
    try {
      setDirectedState(localStorage.getItem("getmotion.directed") ?? "");
      setNotesState(localStorage.getItem("getmotion.notes") ?? "");
    } catch {}
  }, []);

  // I / O set In and Out at the playhead while trimming; space toggles play.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode !== "trim" || !localVideo) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const v = videoRef.current;
      if (!v) return;
      if (e.key === "i" || e.key === "I") {
        setRange(([, b]) => {
          const a = Math.min(v.currentTime, b - 1 / fps);
          return [a, Math.min(b, a + maxLen)];
        });
      } else if (e.key === "o" || e.key === "O") {
        setRange(([a]) => {
          const b = Math.max(v.currentTime, a + 1 / fps);
          return [Math.max(a, b - maxLen), b];
        });
      } else if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Restore the last session (clip, faces, shots, frames, settings) from IndexedDB.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (new URLSearchParams(window.location.search).get("clip")) return;
        const saved = await kv.get<SavedSession>("session");
        if (cancelled || !saved) return;
        if (saved.video) onVideo(new File([saved.video.blob], saved.video.name, { type: saved.video.type }));
        setCast(saved.cast.map((c) => {
          const file = new File([c.blob], c.name, { type: c.type });
          return { file, preview: URL.createObjectURL(file), who: c.who };
        }));
        setShots(saved.shots.map((x) => ({ id: Date.now() + Math.random(), name: x.name, url: URL.createObjectURL(x.blob), blob: x.blob })));
        setFrames(saved.frames.map((f) => ({ id: Date.now() + Math.random(), url: URL.createObjectURL(f.blob), blob: f.blob, frame: f.frame, time: f.time })));
        if (MODELS.some((m) => m.id === saved.modelId)) setModelId(saved.modelId);
        setPrompt(saved.prompt ?? "");
        if (saved.maxLen) setMaxLen(saved.maxLen);
      } catch {
        /* no saved session */
      } finally {
        if (!cancelled) setRestored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Save the session whenever its parts change (debounced).
  useEffect(() => {
    if (!restored) return;
    const t = setTimeout(() => {
      const data: SavedSession = {
        video: videoFile ? { blob: videoFile, name: videoFile.name, type: videoFile.type } : undefined,
        cast: cast.map((c) => ({ blob: c.file, name: c.file.name, type: c.file.type, who: c.who })),
        shots: shots.map((x) => ({ blob: x.blob, name: x.name })),
        frames: frames.map((f) => ({ blob: f.blob, frame: f.frame, time: f.time })),
        modelId,
        prompt,
        maxLen,
        savedAt: Date.now(),
      };
      kv.set("session", data).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [restored, videoFile, cast, shots, frames, modelId, prompt, maxLen]);

  async function resetSession() {
    await kv.clear().catch(() => {});
    try {
      localStorage.removeItem("getmotion.directed");
      localStorage.removeItem("getmotion.notes");
    } catch {}
    window.location.reload();
  }

  // fal reads JPEG/PNG/WebP only; AVIF/HEIC and friends get redrawn as JPEG.
  async function normalizeImage(f: File): Promise<File> {
    if (["image/jpeg", "image/png", "image/webp"].includes(f.type)) return f;
    const bmp = await createImageBitmap(f).catch(() => null);
    if (!bmp) {
      setError(`Can't read ${f.name}. Use a JPEG or PNG.`);
      throw new Error("unreadable image");
    }
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.92));
    return new File([blob!], f.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  }

  async function addFace(f: File) {
    const file = await normalizeImage(f).catch(() => null);
    if (!file) return;
    setCast((c) => (c.length >= 4 ? c : [...c, { file, preview: URL.createObjectURL(file), who: "" }]));
  }

  function addPastedImage(f: File) {
    if (pasteTarget.current === "shot") addShot(f.name || "pasted.png", f);
    else void addFace(f);
  }

  // ⌘V anywhere drops the image into whichever list you last pasted into (faces by default).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      const f = item?.getAsFile();
      if (!f) return;
      e.preventDefault();
      addPastedImage(f);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // Paste button: read the clipboard directly.
  async function pasteFromClipboard(target: "face" | "shot") {
    pasteTarget.current = target;
    setError(null);
    try {
      const items = await navigator.clipboard.read();
      let found = false;
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        const blob = await it.getType(type);
        addPastedImage(new File([blob], `pasted-${Date.now()}.${type.split("/")[1]}`, { type }));
        found = true;
      }
      if (!found) setError("No image on the clipboard.");
    } catch {
      setError("Clipboard blocked by the browser. Click the page and press ⌘V instead.");
    }
  }

  const model = MODELS.find((m) => m.id === modelId)!;
  // What will actually be sent: the selected window while trimming, else the clip.
  const sendLen = mode === "trim" ? range[1] - range[0] : duration;
  const cost = (model.usdPerSec * sendLen).toFixed(2);

  function onVideo(file: File) {
    if (!file.type.startsWith("video/")) return;
    warmUp();
    setVideoFile(file);
    setLocalVideo(URL.createObjectURL(file));
    setVideoUrl(null);
    setPoints([]);
    setMaskUrl(null);
    setMaskOk(false);
    setError(null);
    setTime(0);
    setMode("mask");
  }

  function nudge(edge: 0 | 1, frames: number) {
    const step = frames / fps;
    setRange(([a, b]) => {
      if (edge === 0) {
        const a2 = Math.max(0, Math.min(b - 1, a + step));
        seek(a2);
        return [a2, Math.min(b, a2 + maxLen)];
      }
      const b2 = Math.min(duration, Math.max(a + 1, b + step));
      seek(b2);
      return [Math.max(a, b2 - maxLen), b2];
    });
  }

  function setSlot(n: number) {
    const len = Math.max(1, Math.min(30, n));
    setMaxLen(len);
    setRange(([s]) => [s, Math.min(duration, s + len)]);
  }

  async function saveTake(r: Result) {
    const blob = await fetch(r.localUrl ?? r.url).then((x) => x.blob());
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `getmotion-${new Date(r.at).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.mp4`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  const frameOf = (t: number) => Math.round(t * fps);

  // Grab one frame into the Frames library.
  async function grabFrame(t: number) {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    if (Math.abs(v.currentTime - t) > 0.001) {
      await new Promise<void>((res) => {
        v.addEventListener("seeked", () => res(), { once: true });
        v.currentTime = t;
      });
    }
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    if (!blob) return;
    setFrames((f) => [{ id: Date.now(), url: URL.createObjectURL(blob), blob, frame: frameOf(t), time: t }, ...f]);
  }

  function saveFrame(f: Frame) {
    const a = document.createElement("a");
    a.href = f.url;
    a.download = `frame-${String(f.frame).padStart(5, "0")}-${f.time.toFixed(3)}s.png`;
    a.click();
  }

  function addShot(name: string, blob: Blob) {
    setShots((s) => (s.length >= 8 ? s : [...s, { id: Date.now() + Math.random(), name, url: URL.createObjectURL(blob), blob }]));
  }

  // Downscale so eight screenshots don't become a 40 MB request.
  async function shrink(b: Blob, max = 1280): Promise<string> {
    const bmp = await createImageBitmap(b);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  }

  async function direct() {
    setError(null);
    setDirecting(true);
    try {
      const body = {
        targets: await Promise.all(shots.map(async (x) => ({ name: x.name, dataUrl: await shrink(x.blob) }))),
        faces: await Promise.all(cast.map(async (c) => ({ name: c.file.name, dataUrl: await shrink(c.file) }))),
        notes,
        model: model.name,
      };
      const res = await fetch("/api/direct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setDirection(json);
      setDirected(json.prompt ?? "");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setDirecting(false);
    }
  }

  function frameToCast(f: Frame) {
    const file = new File([f.blob], `frame-${f.frame}.png`, { type: "image/png" });
    setCast((c) => (c.length >= 4 ? c : [...c, { file, preview: f.url, who: "" }]));
  }

  function addToStitch(name: string, url: string) {
    setStitch((s) => [...s, { id: Date.now() + Math.random(), name, url }]);
  }

  async function runStitch() {
    if (stitch.length < 2) return;
    setError(null);
    setBusy("Stitching clips");
    try {
      const blobs = await Promise.all(stitch.map((i) => fetch(i.url).then((r) => r.blob())));
      // Conform everything to the first clip's frame size.
      const size = await new Promise<{ w: number; h: number }>((res, rej) => {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.onloadedmetadata = () => res({ w: v.videoWidth, h: v.videoHeight });
        v.onerror = () => rej(new Error("Could not read the first clip"));
        v.src = stitch[0].url;
      });
      const out = await stitchVideos(blobs, size, (p) => setLog(`${Math.round(p * 100)}%`));
      const localUrl = URL.createObjectURL(out);
      setHistory((h) => [{ url: localUrl, model: `Stitched ${stitch.length} clips`, at: Date.now(), localUrl }, ...h]);
      setStitch([]);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
      setLog("");
    }
  }

  // Cut the selected window in the browser; returns the new file and loads it.
  async function cutSelection(): Promise<File> {
    setBusy("Cutting the clip");
    setCutStage("Loading engine");
    const stages = { engine: "Loading engine", cut: "Cutting" };
    let stage = "Cutting";
    const report = (p: number) => {
      const pct = `${Math.round(p * 100)}%`;
      setLog(pct);
      setCutStage(`${stage} ${pct}`);
    };
    let cut: File;
    try {
      cut = await trimVideo(videoFile!, range[0], range[1], report, (st) => {
        stage = stages[st];
        setCutStage(stage);
      });
    } catch (e) {
      if (!(e instanceof NoDecoderError)) throw e;
      // AV1 / HEVC: play the window through the browser and record it as H.264.
      stage = "Converting (real time)";
      setCutStage(stage);
      cut = await transcodeInBrowser(videoFile!, report, { start: range[0], end: range[1] });
    }
    setLog("");
    setCutStage(null);
    onVideo(cut);
    return cut;
  }

  async function applyTrim() {
    setError(null);
    try {
      await cutSelection();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
      setCutStage(null);
    }
  }

  // Estimate fps from consecutive decoded frames so frame_index is accurate.
  // Runs muted and silent, then hands the clip back unmuted at frame 0.
  function detectFps() {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration);
    setDims({ w: v.videoWidth, h: v.videoHeight });
    if (v.duration > 30) {
      setMode("trim");
      setRange([0, Math.min(maxLen, v.duration)]);
    }
    if (!("requestVideoFrameCallback" in v)) return;
    const times: number[] = [];
    const finish = () => {
      v.pause();
      v.currentTime = 0;
      v.muted = false;
      const deltas = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0);
      const min = Math.min(...deltas);
      if (isFinite(min)) setFps(Math.round(1 / min));
    };
    const tick = (_: number, meta: VideoFrameCallbackMetadata) => {
      times.push(meta.mediaTime);
      if (times.length < 12) v.requestVideoFrameCallback(tick);
      else finish();
    };
    v.muted = true;
    v.requestVideoFrameCallback(tick);
    v.play().catch(finish);
  }

  // Play from wherever the cursor is. Only if it sits at the very end of the window
  // (or the clip) does it wrap to the start.
  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      const end = mode === "trim" ? range[1] : duration;
      if (Math.abs(v.currentTime - end) < 0.05) v.currentTime = mode === "trim" ? range[0] : 0;
      v.muted = false;
      v.play();
    } else v.pause();
  }

  function onClickFrame(e: React.MouseEvent<HTMLDivElement>) {
    const v = videoRef.current;
    if (!v) return;
    if (mode === "trim") return togglePlay();
    v.pause();
    const rect = v.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * v.videoWidth);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * v.videoHeight);
    const f = Math.round(v.currentTime * fps);
    const label: 0 | 1 = e.shiftKey || e.altKey ? 0 : 1;
    setPoints((p) => [...(f !== frameIndex ? [] : p), { x, y, label }]);
    setFrameIndex(f);
    setMaskOk(false);
  }

  const FAL_OK = new Set(["h264", "vp8", "vp9"]);

  // fal can't read HEVC (iPhone) and some other codecs; convert through the
  // browser's decoder first. Replaces the loaded clip with the converted one.
  async function ensureReadable(file: File): Promise<File> {
    setBusy("Checking clip codec");
    const codec = await probeVideoCodec(file).catch(() => null);
    if (!codec || FAL_OK.has(codec)) return file;
    setBusy(`Converting ${codec.toUpperCase()} clip to H.264 (real time)`);
    const out = await transcodeInBrowser(file, (p) => setLog(`${Math.round(p * 100)}%`));
    setLog("");
    onVideo(out);
    return out;
  }

  async function ensureUploaded(file: File) {
    if (videoUrl && file === videoFile) return videoUrl;
    setBusy("Uploading clip");
    const url = await fal.storage.upload(file);
    setVideoUrl(url);
    return url;
  }

  async function runMask() {
    setError(null);
    try {
      const url = await ensureUploaded(await ensureReadable(videoFile!));
      setBusy("Tracking the person through every frame");
      const res = await fal.subscribe(SAM2_VIDEO, {
        input: {
          video_url: url,
          prompts: points.map((p) => ({
            ...p,
            label: String(p.label) as "0" | "1",
            frame_index: frameIndex,
          })),
          apply_mask: false,
        },
        logs: true,
        onQueueUpdate: (u) => setLog(u.status),
      });
      setMaskUrl((res.data as { video: { url: string } }).video.url);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
      setLog("");
    }
  }

  function side(): "left" | "center" | "right" {
    const pos = points.filter((p) => p.label === 1);
    if (!pos.length) return "center";
    const avg = pos.reduce((s, p) => s + p.x, 0) / pos.length / dims.w;
    return avg < 0.4 ? "left" : avg > 0.6 ? "right" : "center";
  }

  async function generate() {
    setError(null);
    try {
      // Still in the trimmer: cut first, then send that.
      let file = videoFile!;
      let len = duration;
      if (mode === "trim") {
        file = await cutSelection();
        len = range[1] - range[0];
      }
      file = await ensureReadable(file);
      const url = await ensureUploaded(file);
      setBusy("Uploading faces");
      const slots = cast.slice(0, model.maxCast);
      const castUrls = await Promise.all(
        slots.map(async (c) => ({ url: await fal.storage.upload(c.file), who: c.who })),
      );
      setBusy(`Rendering with ${model.name}`);
      const input = model.build({
        videoUrl: url,
        maskUrl,
        cast: castUrls,
        prompt,
        directed,
        duration: len,
        side: side(),
      });
      let out: string;
      if (model.provider === "sume") {
        out = await runSume(model.id, input, setLog);
      } else {
        const res = await fal.subscribe(model.id, {
          input,
          logs: true,
          onQueueUpdate: (u) => {
            const last = "logs" in u && u.logs?.length ? u.logs[u.logs.length - 1].message : "";
            setLog(`${u.status} ${last}`);
          },
        });
        out = (res.data as { video: { url: string } }).video.url;
      }
      // Save the paid result the moment it exists, before any post-processing.
      const take: Result = { url: out, model: model.name, at: Date.now() };
      const persist = (list: Result[]) => {
        try {
          // Blob URLs don't survive a reload; keep only the provider URL.
          localStorage.setItem(HISTORY_KEY, JSON.stringify(list.map((r) => ({ url: r.url, model: r.model, at: r.at }))));
        } catch {}
      };
      setHistory((h) => {
        const next = [take, ...h];
        persist(next);
        return next;
      });
      if (!model.keepsAudio) {
        try {
          setBusy("Adding the original audio");
          const silent = await fetch(out).then((r) => r.blob());
          const localUrl = URL.createObjectURL(await muxAudio(silent, file));
          setHistory((h) => h.map((r) => (r.at === take.at ? { ...r, localUrl } : r)));
        } catch (e) {
          setError(`Video saved (silent). Adding audio failed: ${String(e)}`);
        }
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
      setLog("");
    }
  }

  // Keep the mask overlay in step with the clip. While trimming, playback that runs
  // past the window's end stops there (a seek beyond it is left alone).
  function sync() {
    const v = videoRef.current;
    const m = maskRef.current;
    if (!v) return;
    const prev = lastTime.current;
    lastTime.current = v.currentTime;
    if (mode === "trim" && !v.paused && prev < range[1] && v.currentTime >= range[1] && v.currentTime - prev < 0.5) {
      v.pause();
      v.currentTime = range[1];
    }
    setTime(v.currentTime);
    setPlaying(!v.paused);
    if (!m) return;
    m.currentTime = v.currentTime;
    if (v.paused) m.pause();
    else m.play().catch(() => {});
  }

  // Move the cursor; playing stays playing, paused stays paused.
  function seek(t: number) {
    const v = videoRef.current;
    if (!v) return;
    const target = Math.max(0, Math.min(duration, t));
    lastTime.current = target;
    v.currentTime = target;
  }

  const needsFaces = model.maxCast > 0;
  const missing = !videoFile
    ? "Add a clip to start"
    : model.usesMask && mode === "trim"
      ? "Cut the clip first, then click the person"
      : model.usesMask && !(maskUrl && maskOk)
        ? "Click the person, build the mask, approve it"
        : needsFaces && cast.length === 0
          ? "Add a face"
          : !needsFaces && !prompt.trim()
            ? "Describe the restyle"
            : null;
  const canGenerate = !busy && !missing;

  return (
    <div className="min-h-dvh flex flex-col">
      {busy && <div className="sweep fixed top-0 left-0 right-0 h-px z-50 overflow-hidden" />}

      <header className="flex items-center justify-between px-6 h-16">
        <h1 className="flex items-center">
          <Image src="/logo.png" alt="getmotion.art" width={1700} height={290} priority className="h-[22px] w-auto" />
        </h1>
        <div className="flex items-center gap-4">
          {(localVideo || cast.length > 0 || shots.length > 0) && (
            <button className="btn h-8 px-3 text-[12px] text-muted" onClick={resetSession} title="Clear the saved session">
              New session
            </button>
          )}
          {busy && (
            <p className="text-muted text-[13px] inline-flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
              {busy}
              {log && <span className="text-faint tabular-nums">{log}</span>}
            </p>
          )}
          {localVideo && (
            <div className="seg glass" aria-label="Grab a frame into the library">
              <span className="px-2 text-faint text-[12px]">Grab frame</span>
              <button onClick={() => grabFrame(mode === "trim" ? range[0] : 0)}>First</button>
              <button onClick={() => grabFrame(time)}>Now · f{frameOf(time)}</button>
              <button onClick={() => grabFrame(mode === "trim" ? Math.max(range[0], range[1] - 1 / fps) : Math.max(0, duration - 1 / fps))}>
                Last
              </button>
            </div>
          )}
        </div>
      </header>

      <main className={`flex-1 grid ${mode === "trim" && localVideo ? "" : "lg:grid-cols-[minmax(0,1fr)_360px]"}`}>
        {/* Stage */}
        <section className="px-6 pb-8 flex flex-col gap-4 min-w-0">
          <div
            className={`relative mx-auto max-w-full aspect-video rounded-2xl overflow-hidden bg-black ring-1 transition-shadow ${
              mode === "trim" && localVideo ? "h-[42vh]" : "h-[52vh]"
            } ${dragging ? "ring-white shadow-[0_0_0_8px_rgba(255,255,255,0.08)]" : "ring-hair"}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) onVideo(f);
            }}
          >
            {!localVideo ? (
              <button
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center"
                onClick={() => fileRef.current?.click()}
              >
                <span className="text-[22px] tracking-tight">Drop a clip</span>
                <span className="text-muted text-[13px]">or click to choose one</span>
              </button>
            ) : (
              <div
                className={`absolute inset-0 ${mode === "mask" ? "cursor-crosshair" : "cursor-pointer"}`}
                onClick={onClickFrame}
              >
                <video
                  ref={videoRef}
                  src={localVideo}
                  className="w-full h-full object-contain"
                  playsInline
                  onLoadedMetadata={detectFps}
                  onPlay={sync}
                  onPause={sync}
                  onSeeked={sync}
                  onTimeUpdate={sync}
                />
                {maskUrl && (
                  <video
                    key={maskUrl}
                    ref={maskRef}
                    src={maskUrl}
                    muted
                    playsInline
                    className="settle absolute inset-0 w-full h-full object-contain pointer-events-none opacity-50 mix-blend-screen"
                  />
                )}
                {points.map((p, i) => (
                  <span
                    key={i}
                    className={`absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full ring-2 ring-black/70 ${
                      p.label ? "bg-white" : "bg-transparent outline outline-2 outline-white"
                    }`}
                    style={{ left: `${(p.x / dims.w) * 100}%`, top: `${(p.y / dims.h) * 100}%` }}
                  />
                ))}
              </div>
            )}
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onVideo(e.target.files[0])}
          />

          {localVideo && mode === "trim" && (
            <>
              <Trimmer
                src={localVideo}
                duration={duration}
                time={time}
                maxLen={maxLen}
                range={range}
                onRange={setRange}
                onSeek={seek}
              />

              <div className="flex flex-wrap items-center gap-2">
                <button className="btn btn-icon" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay}>
                  <PlayIcon playing={playing} />
                </button>
                <span className="text-[13px] tabular-nums">
                  {fmtTime(time)} <span className="text-faint">/ {fmtTime(duration)} · f{frameOf(time)}</span>
                </span>
                <span className="flex-1" />
                <span className="text-faint text-[12px]">Window</span>
                <div className="seg glass">
                  {[5, 15, 30].map((n) => (
                    <button key={n} className={maxLen === n ? "on" : ""} onClick={() => setSlot(n)}>
                      {n}s
                    </button>
                  ))}
                  <label className={[5, 15, 30].includes(maxLen) ? "" : "on"}>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      step={0.5}
                      value={maxLen}
                      onChange={(e) => setSlot(Number(e.target.value) || 1)}
                      className="w-9 bg-transparent tabular-nums text-right"
                      aria-label="Window length in seconds"
                    />
                    s
                  </label>
                </div>
              </div>

              <FrameStrip
                src={localVideo}
                fps={fps}
                duration={duration}
                time={time}
                range={range}
                step={stripStep}
                onSeek={(t) => { videoRef.current?.pause(); seek(t); }}
              />
              <div className="flex flex-wrap items-center gap-2 -mt-1">
                <span className="text-faint text-[12px]">Frame strip</span>
                <div className="seg glass">
                  {[1, 2, 5, 15, 30].map((n) => (
                    <button key={n} className={stripStep === n ? "on" : ""} onClick={() => setStripStep(n)}>
                      {n === 1 ? "every frame" : `every ${n}`}
                    </button>
                  ))}
                </div>
                <span className="text-faint text-[12px]">Click a frame to land on it. Keys: I sets In, O sets Out, space plays.</span>
              </div>

              {/* Frame-accurate edges */}
              <div className="glass rounded-2xl px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
                <Edge label="In" t={range[0]} frame={frameOf(range[0])} onNudge={(n) => nudge(0, n)} onGo={() => seek(range[0])} />
                <Edge label="Out" t={range[1]} frame={frameOf(range[1])} onNudge={(n) => nudge(1, n)} onGo={() => seek(range[1])} />
                <span className="text-muted text-[13px] tabular-nums">
                  {(range[1] - range[0]).toFixed(2)}s · {frameOf(range[1]) - frameOf(range[0])} frames · {fps} fps
                </span>
                <span className="flex-1" />
                <button className="btn" onClick={() => fileRef.current?.click()}>
                  Replace clip
                </button>
                {duration <= 30 && (
                  <button className="btn" onClick={() => setMode("mask")}>
                    Use whole clip
                  </button>
                )}
                <button className="btn btn-on min-w-44" disabled={!!busy} onClick={applyTrim}>
                  {cutStage ?? `Use ${fmtTime(range[0])} – ${fmtTime(range[1])}`}
                </button>
              </div>
            </>
          )}

          {localVideo && mode === "mask" && (
            <>
              <div className="flex items-center gap-3">
                <button className="btn btn-icon" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay}>
                  <PlayIcon playing={playing} />
                </button>
                <input
                  type="range"
                  className="scrub flex-1"
                  min={0}
                  max={duration || 0}
                  step={1 / fps}
                  value={time}
                  onChange={(e) => seek(Number(e.target.value))}
                />
                <span className="text-muted text-[13px] tabular-nums">
                  {fmtTime(time)} <span className="text-faint">/ {fmtTime(duration)} · f{frameOf(time)}</span>
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="seg glass">
                  <button onClick={() => { videoRef.current?.pause(); seek(time - 1 / fps); }} aria-label="Previous frame">
                    ‹
                  </button>
                  <button onClick={() => { videoRef.current?.pause(); seek(time + 1 / fps); }} aria-label="Next frame">
                    ›
                  </button>
                </div>
                <span className="text-muted text-[13px]">
                  {points.length === 0
                    ? model.usesMask
                      ? "Click the person to replace. Shift-click to exclude."
                      : "Click the person to replace (optional for this model)."
                    : `${points.length} point${points.length > 1 ? "s" : ""} on frame ${frameIndex}`}
                </span>
                <span className="flex-1" />
                {points.length > 0 && (
                  <button className="btn" onClick={() => setPoints([])}>
                    Clear
                  </button>
                )}
                <button className="btn" disabled={!points.length || !!busy} onClick={runMask}>
                  {maskUrl ? "Rebuild mask" : "Build mask"}
                </button>
                {maskUrl && (
                  <button className={`btn ${maskOk ? "btn-on" : ""}`} onClick={() => setMaskOk(!maskOk)}>
                    {maskOk ? "Mask approved" : "Approve mask"}
                  </button>
                )}
                <button
                  className="btn"
                  onClick={() => {
                    setRange([0, Math.min(maxLen, duration)]);
                    setMode("trim");
                  }}
                >
                  Trim
                </button>
                <button className="btn" onClick={() => fileRef.current?.click()}>
                  Replace
                </button>
              </div>
            </>
          )}

          {error && (
            <p className="glass text-[13px] text-ink/90 break-all rounded-xl px-4 py-3">{error}</p>
          )}

          {frames.length > 0 && (
            <div className="pt-6 space-y-3">
              <div className="flex items-baseline gap-3">
                <h2 className="text-[15px]">Frames</h2>
                <span className="text-faint text-[12px]">Grabbed stills. Save them or use one as a face.</span>
              </div>
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-4">
                {frames.map((f) => (
                  <figure key={f.id} className="space-y-1.5">
                    <button className="block w-full cursor-zoom-in" onClick={() => setZoomed(f)} aria-label="Zoom into frame">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={f.url} alt="" className="w-full aspect-video object-cover rounded-xl bg-black ring-1 ring-hair" />
                    </button>
                    <figcaption className="text-[12px] text-muted flex justify-between items-center gap-2">
                      <span className="tabular-nums">f{f.frame} · {f.time.toFixed(2)}s</span>
                      <span className="flex gap-1.5">
                        <button className="btn h-7 px-2.5 text-[12px]" onClick={() => addShot(`frame-${f.frame}.png`, f.blob)}>
                          Target shot
                        </button>
                        <button className="btn h-7 px-2.5 text-[12px]" onClick={() => frameToCast(f)}>
                          Use as face
                        </button>
                        <button className="btn h-7 px-2.5 text-[12px]" onClick={() => saveFrame(f)}>
                          Save
                        </button>
                        <button className="btn h-7 w-7 px-0 text-[12px] text-muted" aria-label="Remove" onClick={() => setFrames((s) => s.filter((x) => x.id !== f.id))}>
                          ×
                        </button>
                      </span>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          )}

          {mode === "mask" && (stitch.length > 0 || history.length > 0 || videoFile) && (
            <div className="pt-8 space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-[15px]">Stitch</h2>
                <span className="text-faint text-[12px]">Joins clips back to back, in this order.</span>
                <span className="flex-1" />
                {videoFile && localVideo && (
                  <button className="btn" onClick={() => addToStitch(videoFile.name, localVideo)}>
                    Add current clip
                  </button>
                )}
                <label className="btn cursor-pointer">
                  Add a file
                  <input
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) addToStitch(f.name, URL.createObjectURL(f));
                      e.target.value = "";
                    }}
                  />
                </label>
                <button className="btn btn-on" disabled={stitch.length < 2 || !!busy} onClick={runStitch}>
                  Stitch {stitch.length > 1 ? stitch.length : ""}
                </button>
              </div>
              {stitch.length > 0 && (
                <ol className="glass rounded-2xl p-1.5 space-y-0.5">
                  {stitch.map((it, i) => (
                    <li key={it.id} className="flex items-center gap-3 px-3.5 py-2 rounded-xl">
                      <span className="text-faint text-[12px] tabular-nums w-4">{i + 1}</span>
                      <video src={it.url} muted playsInline className="h-9 w-16 object-cover rounded-md bg-black" />
                      <span className="text-[13px] truncate flex-1">{it.name}</span>
                      <div className="seg glass">
                        <button
                          disabled={i === 0}
                          onClick={() => setStitch((s) => { const c = [...s]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c; })}
                          aria-label="Move up"
                        >
                          ↑
                        </button>
                        <button
                          disabled={i === stitch.length - 1}
                          onClick={() => setStitch((s) => { const c = [...s]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; return c; })}
                          aria-label="Move down"
                        >
                          ↓
                        </button>
                      </div>
                      <button className="btn btn-icon text-muted" aria-label="Remove" onClick={() => setStitch((s) => s.filter((x) => x.id !== it.id))}>
                        ×
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {mode === "mask" && history.length > 0 && (
            <div className="pt-8 space-y-3">
              <h2 className="text-[15px]">Takes</h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {history.map((r) => (
                  <figure key={r.at} className="space-y-2">
                    <video
                      src={r.localUrl ?? r.url}
                      controls
                      playsInline
                      className="w-full rounded-xl bg-black ring-1 ring-hair"
                    />
                    <figcaption className="text-[12px] text-muted flex justify-between items-center">
                      <span>
                        {r.model} · {new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span className="flex gap-1.5">
                        <button className="btn h-7 px-3 text-[12px]" onClick={() => addToStitch(r.model, r.localUrl ?? r.url)}>
                          Stitch
                        </button>
                        <button className="btn h-7 px-3 text-[12px]" onClick={() => saveTake(r)}>
                          Save
                        </button>
                      </span>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Side panel */}
        {!(mode === "trim" && localVideo) && (
        <aside className="lg:border-l border-hair flex flex-col">
          <div className="flex-1 px-6 py-2 space-y-9 overflow-y-auto">
            <div className="space-y-3">
              <h2 className="text-[15px]">Cast</h2>
              {cast.map((c, n) => (
                <div key={c.preview} className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={c.preview} alt="" className="h-11 w-11 object-cover rounded-full ring-1 ring-hair" />
                  <input
                    value={c.who}
                    onChange={(e) =>
                      setCast((s) => s.map((x, i) => (i === n ? { ...x, who: e.target.value } : x)))
                    }
                    placeholder="replaces the man in the striped shirt"
                    className="field text-[13px] py-2"
                  />
                  <button
                    className="btn btn-icon text-muted"
                    aria-label="Remove"
                    onClick={() => setCast((s) => s.filter((_, i) => i !== n))}
                  >
                    ×
                  </button>
                </div>
              ))}
              {cast.length < 4 && (
                <div className="flex gap-2">
                <button className="btn" onClick={() => pasteFromClipboard("face")}>Paste face</button>
                <label className="btn cursor-pointer">
                  {cast.length ? "Add another" : "Add a face"}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      void addFace(f);
                      e.target.value = "";
                    }}
                  />
                </label>
                </div>
              )}
              <p className="text-faint text-[12px] leading-relaxed">
                One photo per person. Say who each one replaces by look and position.
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <h2 className="text-[15px]">Director</h2>
                <span className="text-faint text-[12px]">Claude writes the prompt</span>
              </div>
              <p className="text-faint text-[12px] leading-relaxed">
                Add screenshots of the person to replace across the clip&apos;s shots (grab frames above, or
                upload). Add the faces in Cast. Say what to keep.
              </p>
              {shots.length > 0 && (
                <div className="grid grid-cols-4 gap-1.5">
                  {shots.map((x, i) => (
                    <div key={x.id} className="relative group">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={x.url} alt="" className="w-full aspect-video object-cover rounded-md ring-1 ring-hair" />
                      <span className="absolute left-1 bottom-1 text-[10px] bg-black/60 rounded px-1 tabular-nums">{i + 1}</span>
                      <button
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-white text-black text-[11px] leading-5 opacity-0 group-hover:opacity-100"
                        aria-label="Remove shot"
                        onClick={() => setShots((s) => s.filter((y) => y.id !== x.id))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
              <button className="btn" onClick={() => pasteFromClipboard("shot")}>Paste shot</button>
              <label className="btn cursor-pointer">
                {shots.length ? "Add more shots" : "Add target shots"}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    Array.from(e.target.files ?? []).forEach((f) => addShot(f.name, f));
                    e.target.value = "";
                  }}
                />
              </label>
              </div>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Keep his full suit and the sunglasses in the shots where he wears them. Replace only the rapper, not the hype man."
                className="field text-[13px] resize-none"
                rows={3}
              />
              <button
                className="btn btn-on w-full"
                disabled={directing || shots.length === 0 || cast.length === 0}
                onClick={direct}
              >
                {directing ? "Writing prompt…" : "Write the prompt"}
              </button>
              <div className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px]">Prompt</span>
                  <span className="text-faint text-[12px]">sent as is; saved on this device</span>
                </div>
                {direction?.target && <p className="text-muted text-[12px]">Target: {direction.target}</p>}
                <textarea
                  value={directed}
                  onChange={(e) => setDirected(e.target.value)}
                  placeholder="Paste a saved prompt here, or press Write the prompt."
                  className="field text-[13px] leading-relaxed"
                  rows={directed ? 10 : 3}
                />
                {direction?.warnings?.length ? (
                  <ul className="text-[12px] text-muted list-disc pl-4 space-y-0.5">
                    {direction.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                ) : null}
                {directed.trim() && (
                  <div className="flex justify-end">
                    <button className="btn" onClick={() => { setDirected(""); setDirection(null); }}>Clear prompt</button>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <h2 className="text-[15px]">Twist</h2>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Optional. Wearing a gold crown, pouring rain…"
                className="field text-[13px] resize-none"
                rows={2}
              />
            </div>

            <div className="space-y-3">
              <h2 className="text-[15px]">Model</h2>
              <div role="radiogroup" className="glass rounded-2xl p-1.5 space-y-0.5">
                {MODELS.map((m) => {
                  const on = m.id === modelId;
                  return (
                    <button
                      key={m.id}
                      role="radio"
                      aria-checked={on}
                      onClick={() => setModelId(m.id)}
                      className={`w-full text-left px-3.5 py-2.5 rounded-xl transition-colors ${
                        on ? "bg-white/[0.09]" : "hover:bg-white/[0.04]"
                      }`}
                    >
                      <span className="flex justify-between gap-3 items-baseline">
                        <span className={`text-[13px] font-medium ${on ? "text-ink" : "text-muted"}`}>{m.name}</span>
                        <span className="text-faint text-[12px] tabular-nums">${m.usdPerSec}/s</span>
                      </span>
                      <span className="block text-faint text-[12px] leading-snug mt-0.5">{m.note}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="px-6 py-6 space-y-3">
            <button className="btn-primary" disabled={!canGenerate} onClick={generate}>
              Generate
              {sendLen > 0 && <span className="opacity-60 font-medium tabular-nums">${cost}</span>}
            </button>
            <p className="text-faint text-[12px] text-center h-4">
              {missing ?? `${sendLen.toFixed(1)}s · ${model.name}${directed.trim() ? " · directed prompt" : ""}`}
            </p>
          </div>
        </aside>
        )}
      </main>

      {zoomed && <Lightbox frame={zoomed} onClose={() => setZoomed(null)} onSave={() => saveFrame(zoomed)} />}
    </div>
  );
}

// Full-screen frame viewer: scroll to zoom, drag to pan, double-click for 1:1, Esc to close.
function Lightbox({ frame, onClose, onSave }: { frame: Frame; onClose: () => void; onSave: () => void }) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/92 backdrop-blur-xl flex flex-col"
      onWheel={(e) => {
        e.preventDefault();
        setScale((z) => Math.min(4, Math.max(1, z * (e.deltaY < 0 ? 1.06 : 0.94))));
      }}
    >
      <div className="flex items-center justify-between px-6 h-16 shrink-0">
        <span className="text-[13px] tabular-nums text-muted">
          f{frame.frame} · {frame.time.toFixed(3)}s · {Math.round(scale * 100)}%
        </span>
        <div className="flex gap-2">
          <button className="btn" onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}>Fit</button>
          <button className="btn" onClick={onSave}>Save PNG</button>
          <button className="btn btn-icon" aria-label="Close" onClick={onClose}>×</button>
        </div>
      </div>
      <div
        className={`flex-1 overflow-hidden flex items-center justify-center ${scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setPan({ x: drag.current.px + (e.clientX - drag.current.x), y: drag.current.py + (e.clientY - drag.current.y) });
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => {
          if (scale > 1) { setScale(1); setPan({ x: 0, y: 0 }); } else setScale(2);
        }}
        onClick={(e) => e.target === e.currentTarget && scale === 1 && onClose()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={frame.url}
          alt=""
          draggable={false}
          className="max-w-[78vw] max-h-[70vh] rounded-xl ring-1 ring-hair select-none"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transition: "transform 60ms linear", imageRendering: scale > 2 ? "pixelated" : "auto" }}
        />
      </div>
    </div>
  );
}

function Edge({
  label,
  t,
  frame,
  onNudge,
  onGo,
}: {
  label: string;
  t: number;
  frame: number;
  onNudge: (frames: number) => void;
  onGo: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button className="text-left" onClick={onGo} title="Jump here">
        <span className="block text-faint text-[11px] leading-none">{label}</span>
        <span className="block text-[13px] tabular-nums leading-tight">
          {fmtTime(t)} <span className="text-faint">f{frame}</span>
        </span>
      </button>
      <div className="seg glass">
        <button onClick={() => onNudge(-10)} aria-label={`${label} back 10 frames`}>‹‹</button>
        <button onClick={() => onNudge(-1)} aria-label={`${label} back 1 frame`}>‹</button>
        <button onClick={() => onNudge(1)} aria-label={`${label} forward 1 frame`}>›</button>
        <button onClick={() => onNudge(10)} aria-label={`${label} forward 10 frames`}>››</button>
      </div>
    </div>
  );
}

function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
      <rect x="2" y="1.5" width="3" height="9" rx="0.75" />
      <rect x="7" y="1.5" width="3" height="9" rx="0.75" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
      <path d="M3 1.8v8.4c0 .6.65.97 1.16.66l6.4-4.2a.78.78 0 0 0 0-1.32l-6.4-4.2A.78.78 0 0 0 3 1.8Z" />
    </svg>
  );
}
