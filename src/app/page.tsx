"use client";

import { fal } from "@fal-ai/client";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { MODELS, SAM2_VIDEO } from "@/lib/models";
import { muxAudio, stitchVideos, trimVideo } from "@/lib/trim";
import { Trimmer } from "@/components/Trimmer";

fal.config({ proxyUrl: "/api/fal/proxy" });

type Point = { x: number; y: number; label: 0 | 1 };
type Result = { url: string; model: string; at: number; localUrl?: string };
type CastSlot = { file: File; preview: string; who: string };
type StitchItem = { id: number; name: string; url: string };

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
    // Hydrate saved takes after mount so server and client markup match.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistory(loadHistory());
  }, []);

  // Paste a face straight from the clipboard.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      const f = item?.getAsFile();
      if (!f) return;
      e.preventDefault();
      setCast((c) => (c.length >= 4 ? c : [...c, { file: f, preview: URL.createObjectURL(f), who: "" }]));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const model = MODELS.find((m) => m.id === modelId)!;
  // What will actually be sent: the selected window while trimming, else the clip.
  const sendLen = mode === "trim" ? range[1] - range[0] : duration;
  const cost = (model.usdPerSec * sendLen).toFixed(2);

  function onVideo(file: File) {
    if (!file.type.startsWith("video/")) return;
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

  // Save a single frame of the current clip as PNG.
  async function saveFrame(t: number) {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    if (Math.abs(v.currentTime - t) > 0.01) {
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
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `frame-${t.toFixed(2)}s.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
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
      setError(String(e));
    } finally {
      setBusy(null);
      setLog("");
    }
  }

  // Cut the selected window in the browser; returns the new file and loads it.
  async function cutSelection(): Promise<File> {
    setBusy("Cutting the clip");
    const cut = await trimVideo(videoFile!, range[0], range[1], (p) => setLog(`${Math.round(p * 100)}%`));
    setLog("");
    onVideo(cut);
    return cut;
  }

  async function applyTrim() {
    setError(null);
    try {
      await cutSelection();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
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
      const url = await ensureUploaded(videoFile!);
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
      setError(String(e));
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
      let localUrl: string | undefined;
      if (!model.keepsAudio) {
        setBusy("Adding the original audio");
        const silent = await fetch(out).then((r) => r.blob());
        localUrl = URL.createObjectURL(await muxAudio(silent, file));
      }
      const take: Result = { url: out, model: model.name, at: Date.now(), localUrl };
      const next = [take, ...history];
      setHistory(next);
      try {
        // Blob URLs don't survive a reload; keep only the provider URL.
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next.map((r) => ({ url: r.url, model: r.model, at: r.at }))));
      } catch {}
    } catch (e) {
      setError(String(e));
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
        {busy && (
          <p className="text-muted text-[13px] inline-flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
            {busy}
            {log && <span className="text-faint tabular-nums">{log}</span>}
          </p>
        )}
      </header>

      <main className="flex-1 grid lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Stage */}
        <section className="px-6 pb-8 flex flex-col gap-4 min-w-0">
          <div
            className={`relative rounded-2xl overflow-hidden bg-black aspect-video ring-1 transition-shadow ${
              dragging ? "ring-white shadow-[0_0_0_8px_rgba(255,255,255,0.08)]" : "ring-hair"
            }`}
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
                <span className="text-[13px] tabular-nums">
                  {fmtTime(time)} <span className="text-faint">/ {fmtTime(duration)}</span>
                </span>
                <span className="text-muted text-[13px] tabular-nums">
                  {fmtTime(range[0])} – {fmtTime(range[1])}{" "}
                  <span className="text-faint">({(range[1] - range[0]).toFixed(1)}s)</span>
                </span>
                <span className="flex-1" />
                <FrameSaver onSave={saveFrame} first={range[0]} current={time} last={Math.max(range[0], range[1] - 1 / fps)} />
                {duration <= 30 && (
                  <button className="btn" onClick={() => setMode("mask")}>
                    Use whole clip
                  </button>
                )}
                <button className="btn" onClick={() => fileRef.current?.click()}>
                  Replace
                </button>
                <button className="btn btn-on" disabled={!!busy} onClick={applyTrim}>
                  Cut
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
                  {fmtTime(time)} <span className="text-faint">/ {fmtTime(duration)}</span>
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
                <FrameSaver onSave={saveFrame} first={0} current={time} last={Math.max(0, duration - 1 / fps)} />
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

          {(stitch.length > 0 || history.length > 0 || videoFile) && (
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

          {history.length > 0 && (
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
                <label className="btn cursor-pointer">
                  {cast.length ? "Add another" : "Add a face"}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      setCast((s) => [...s, { file: f, preview: URL.createObjectURL(f), who: "" }]);
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
              <p className="text-faint text-[12px] leading-relaxed">
                One photo per person, or paste with ⌘V. Say who each one replaces by look and position.
              </p>
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
              {missing ?? `${sendLen.toFixed(1)}s · ${model.name}${mode === "trim" ? " · cuts first" : ""}`}
            </p>
          </div>
        </aside>
      </main>
    </div>
  );
}

function FrameSaver({
  onSave,
  first,
  current,
  last,
}: {
  onSave: (t: number) => void;
  first: number;
  current: number;
  last: number;
}) {
  return (
    <div className="seg glass" aria-label="Save a frame as PNG">
      <span className="px-2 text-faint text-[12px]">Frame</span>
      <button onClick={() => onSave(first)}>First</button>
      <button onClick={() => onSave(current)}>Now</button>
      <button onClick={() => onSave(last)}>Last</button>
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
