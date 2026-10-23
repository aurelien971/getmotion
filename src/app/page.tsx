"use client";

import { fal } from "@fal-ai/client";
import { useEffect, useRef, useState } from "react";
import { MODELS, SAM2_VIDEO } from "@/lib/models";

fal.config({ proxyUrl: "/api/fal/proxy" });

type Point = { x: number; y: number; label: 0 | 1 };
type Result = { url: string; model: string; at: number };
type CastSlot = { file: File; preview: string; who: string };

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

  const [cast, setCast] = useState<CastSlot[]>([]);
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState(MODELS[0].id);

  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Result[]>([]);

  useEffect(() => {
    // Hydrate saved takes after mount so server and client markup match.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistory(loadHistory());
  }, []);

  const model = MODELS.find((m) => m.id === modelId)!;
  const cost = (model.usdPerSec * duration).toFixed(2);

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
  }

  // Estimate fps from consecutive decoded frames so frame_index is accurate.
  function detectFps() {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration);
    setDims({ w: v.videoWidth, h: v.videoHeight });
    if (!("requestVideoFrameCallback" in v)) return;
    const times: number[] = [];
    const tick = (_: number, meta: VideoFrameCallbackMetadata) => {
      times.push(meta.mediaTime);
      if (times.length < 12) v.requestVideoFrameCallback(tick);
      else {
        v.pause();
        v.currentTime = 0;
        const deltas = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0);
        const min = Math.min(...deltas);
        if (isFinite(min)) setFps(Math.round(1 / min));
      }
    };
    v.muted = true;
    v.requestVideoFrameCallback(tick);
    v.play().catch(() => {});
  }

  function onClickFrame(e: React.MouseEvent<HTMLDivElement>) {
    const v = videoRef.current;
    if (!v) return;
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

  async function ensureUploaded() {
    if (videoUrl) return videoUrl;
    setBusy("Uploading clip");
    const url = await fal.storage.upload(videoFile!);
    setVideoUrl(url);
    return url;
  }

  async function runMask() {
    setError(null);
    try {
      const url = await ensureUploaded();
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
    const v = videoRef.current;
    const pos = points.filter((p) => p.label === 1);
    if (!v || !pos.length) return "center";
    const avg = pos.reduce((s, p) => s + p.x, 0) / pos.length / v.videoWidth;
    return avg < 0.4 ? "left" : avg > 0.6 ? "right" : "center";
  }

  async function generate() {
    setError(null);
    try {
      const url = await ensureUploaded();
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
        duration,
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
      const next = [{ url: out, model: model.name, at: Date.now() }, ...history];
      setHistory(next);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {}
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      setLog("");
    }
  }

  // Keep mask overlay in sync with the source clip.
  function sync() {
    const v = videoRef.current;
    const m = maskRef.current;
    if (!v) return;
    setTime(v.currentTime);
    setPlaying(!v.paused);
    if (!m) return;
    m.currentTime = v.currentTime;
    if (v.paused) m.pause();
    else m.play().catch(() => {});
  }

  function seek(t: number) {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = Math.max(0, Math.min(duration, t));
  }

  const needsFaces = model.maxCast > 0;
  const missing = !videoFile
    ? "Add a clip to start"
    : model.usesMask && !(maskUrl && maskOk)
      ? "Build and approve a mask first"
      : needsFaces && cast.length === 0
        ? "Add at least one face"
        : !needsFaces && !prompt.trim()
          ? "Describe the restyle"
          : null;
  const canGenerate = !busy && !missing;

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="flex items-center justify-between px-5 h-14 border-b border-line">
        <h1 className="text-[17px]">getmotion</h1>
        <p className="text-muted text-sm">
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-tally animate-pulse" />
              {busy}
              {log && <span className="opacity-60">{log}</span>}
            </span>
          ) : (
            "Nothing runs until you press Generate."
          )}
        </p>
      </header>

      <main className="flex-1 grid lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* Stage */}
        <section className="p-5 lg:p-8 flex flex-col gap-4 min-w-0">
          <div
            className={`relative rounded-[var(--radius)] overflow-hidden bg-black aspect-video ring-1 transition-shadow ${
              dragging ? "ring-tally shadow-[0_0_0_6px_var(--tally-soft)]" : "ring-line"
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
            {busy && (
              <div className="sweep absolute top-0 left-0 right-0 h-[2px] z-20 overflow-hidden" />
            )}

            {!localVideo ? (
              <button
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center"
                onClick={() => fileRef.current?.click()}
              >
                <span className="text-2xl">Drop a clip here</span>
                <span className="text-muted">or click to choose one. Up to 30 seconds.</span>
              </button>
            ) : (
              <div className="absolute inset-0 cursor-crosshair" onClick={onClickFrame}>
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
                    className="settle absolute inset-0 w-full h-full object-contain pointer-events-none opacity-70 mix-blend-screen"
                    style={{ filter: "sepia(1) saturate(10) hue-rotate(-30deg)" }}
                  />
                )}
                {points.map((p, i) => (
                    <span
                      key={i}
                      className={`absolute w-3.5 h-3.5 -ml-[7px] -mt-[7px] rounded-full ring-2 ring-white ${
                        p.label ? "bg-tally" : "bg-black"
                      }`}
                      style={{
                        left: `${(p.x / dims.w) * 100}%`,
                        top: `${(p.y / dims.h) * 100}%`,
                      }}
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

          {localVideo && (
            <>
              <div className="flex items-center gap-3">
                <button
                  className="btn w-9 px-0 justify-center"
                  aria-label={playing ? "Pause" : "Play"}
                  onClick={() => {
                    const el = videoRef.current;
                    if (!el) return;
                    if (el.paused) el.play();
                    else el.pause();
                  }}
                >
                  {playing ? "❚❚" : "▶"}
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
                <span className="text-muted text-sm tabular-nums w-24 text-right">
                  {fmtTime(time)} / {fmtTime(duration)}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button className="btn" onClick={() => seek(time - 1 / fps)}>
                  ‹ Frame
                </button>
                <button className="btn" onClick={() => seek(time + 1 / fps)}>
                  Frame ›
                </button>
                <span className="text-muted text-sm px-1">
                  {points.length === 0
                    ? "Click the person you want to replace. Shift-click to exclude."
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
                  <button
                    className={`btn ${maskOk ? "border-tally text-tally" : ""}`}
                    onClick={() => setMaskOk(!maskOk)}
                  >
                    {maskOk ? "Mask approved" : "Approve mask"}
                  </button>
                )}
                <button className="btn" onClick={() => fileRef.current?.click()}>
                  Replace clip
                </button>
              </div>
            </>
          )}

          {error && (
            <p className="text-sm text-tally break-all rounded-lg bg-tally-soft px-3 py-2">
              {error}
            </p>
          )}

          {history.length > 0 && (
            <div className="pt-6 space-y-3">
              <h2 className="text-[17px]">Takes</h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {history.map((r) => (
                  <figure key={r.at} className="space-y-1.5">
                    <video
                      src={r.url}
                      controls
                      playsInline
                      className="w-full rounded-xl bg-black ring-1 ring-line"
                    />
                    <figcaption className="text-xs text-muted flex justify-between">
                      <span>
                        {r.model}, {new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <a href={r.url} target="_blank" className="hover:text-ink">
                        Download
                      </a>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Side panel */}
        <aside className="bg-panel border-t lg:border-t-0 lg:border-l border-line flex flex-col">
          <div className="flex-1 p-5 space-y-8 overflow-y-auto">
            <div className="space-y-3">
              <h2 className="text-[17px]">Cast</h2>
              {cast.map((c, n) => (
                <div key={c.preview} className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={c.preview} alt="" className="h-12 w-12 object-cover rounded-lg" />
                  <input
                    value={c.who}
                    onChange={(e) =>
                      setCast((s) => s.map((x, i) => (i === n ? { ...x, who: e.target.value } : x)))
                    }
                    placeholder="replaces the man in the striped shirt"
                    className="field text-sm"
                  />
                  <button
                    className="btn w-9 px-0 justify-center text-muted"
                    aria-label="Remove"
                    onClick={() => setCast((s) => s.filter((_, i) => i !== n))}
                  >
                    ×
                  </button>
                </div>
              ))}
              {cast.length < 4 && (
                <label className="btn cursor-pointer">
                  {cast.length ? "Add another face" : "Add a face"}
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
              <p className="text-muted text-sm">
                One photo per person. Say who each one replaces by look and position so the model
                picks the right one.
              </p>
            </div>

            <div className="space-y-3">
              <h2 className="text-[17px]">Twist</h2>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Optional. Wearing a gold crown, pouring rain…"
                className="field text-sm resize-none"
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <h2 className="text-[17px]">Model</h2>
              <div role="radiogroup" className="rounded-xl border border-line divide-y divide-line overflow-hidden">
                {MODELS.map((m) => {
                  const on = m.id === modelId;
                  return (
                    <button
                      key={m.id}
                      role="radio"
                      aria-checked={on}
                      onClick={() => setModelId(m.id)}
                      className={`w-full text-left px-4 py-3 flex gap-3 items-start transition-colors ${
                        on ? "bg-raise" : "hover:bg-raise/60"
                      }`}
                    >
                      <span
                        className={`mt-[7px] w-2 h-2 rounded-full shrink-0 ${
                          on ? "bg-tally" : "bg-line-strong"
                        }`}
                      />
                      <span className="flex-1 min-w-0">
                        <span className="flex justify-between gap-2">
                          <span className="font-medium">{m.name}</span>
                          <span className="text-muted text-sm tabular-nums">${m.usdPerSec}/s</span>
                        </span>
                        <span className="block text-muted text-sm">{m.note}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="p-5 border-t border-line space-y-2">
            <button className="btn-tally" disabled={!canGenerate} onClick={generate}>
              Generate
              {duration > 0 && <span className="opacity-80 font-medium">about ${cost}</span>}
            </button>
            <p className="text-muted text-sm text-center h-5">
              {missing ?? `${model.name}, ${duration.toFixed(1)}s`}
            </p>
          </div>
        </aside>
      </main>
    </div>
  );
}
