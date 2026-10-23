"use client";

import { fal } from "@fal-ai/client";
import { useEffect, useRef, useState } from "react";
import { MODELS, SAM2_VIDEO } from "@/lib/models";

fal.config({ proxyUrl: "/api/fal/proxy" });

type Point = { x: number; y: number; label: 0 | 1 };
type Result = { url: string; model: string; at: number };
type CastSlot = { file: File; preview: string; who: string };

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

const HISTORY_KEY = "getmotion.history";

function loadHistory(): Result[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const maskRef = useRef<HTMLVideoElement>(null);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null); // fal CDN
  const [localVideo, setLocalVideo] = useState<string | null>(null);
  const [fps, setFps] = useState(30);
  const [frameIndex, setFrameIndex] = useState(0);
  const [points, setPoints] = useState<Point[]>([]);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [maskOk, setMaskOk] = useState(false);

  const [cast, setCast] = useState<CastSlot[]>([]);
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState(MODELS[0].id);

  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Result[]>([]);

  useEffect(() => setHistory(loadHistory()), []);

  const model = MODELS.find((m) => m.id === modelId)!;
  const duration = videoRef.current?.duration ?? 0;
  const cost = (model.usdPerSec * duration).toFixed(2);

  async function onVideo(file: File) {
    setVideoFile(file);
    setLocalVideo(URL.createObjectURL(file));
    setVideoUrl(null);
    setPoints([]);
    setMaskUrl(null);
    setMaskOk(false);
    setError(null);
  }

  // Estimate fps from consecutive decoded frames so frame_index is accurate.
  function detectFps() {
    const v = videoRef.current;
    if (!v || !("requestVideoFrameCallback" in v)) return;
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
    if (points.length && f !== frameIndex) setPoints([]);
    setFrameIndex(f);
    const label: 0 | 1 = e.shiftKey || e.altKey ? 0 : 1;
    setPoints((p) => [...(f !== frameIndex ? [] : p), { x, y, label }]);
    setMaskOk(false);
  }

  async function ensureUploaded() {
    if (videoUrl) return videoUrl;
    setBusy("Uploading clip…");
    const url = await fal.storage.upload(videoFile!);
    setVideoUrl(url);
    return url;
  }

  async function runMask() {
    setError(null);
    try {
      const url = await ensureUploaded();
      setBusy("Tracking person through every frame (SAM 2)…");
      const res = await fal.subscribe(SAM2_VIDEO, {
        input: {
          video_url: url,
          prompts: points.map((p) => ({ ...p, label: String(p.label) as "0" | "1", frame_index: frameIndex })),
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
      setBusy("Uploading faces…");
      const slots = cast.slice(0, model.maxCast);
      const castUrls = await Promise.all(
        slots.map(async (c) => ({ url: await fal.storage.upload(c.file), who: c.who })),
      );
      setBusy(`Generating with ${model.name}… (minutes)`);
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
    const v = videoRef.current, m = maskRef.current;
    if (!v || !m) return;
    m.currentTime = v.currentTime;
    if (v.paused) m.pause();
    else m.play().catch(() => {});
  }

  const v = videoRef.current;
  const canGenerate =
    !!videoFile &&
    !busy &&
    (model.maxCast === 0 ? !!prompt.trim() : cast.length > 0) &&
    (!model.usesMask || (maskUrl && maskOk));

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 space-y-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold tracking-tight">getmotion</h1>
        <span className="text-sm text-neutral-500">private engine</span>
      </header>

      {/* 1. Clip */}
      <section className="space-y-3">
        <h2 className="font-semibold">1. Clip</h2>
        <input
          type="file"
          accept="video/*"
          onChange={(e) => e.target.files?.[0] && onVideo(e.target.files[0])}
        />
        {localVideo && (
          <>
            <p className="text-sm text-neutral-400">
              Scrub to a frame, click the person to swap. Shift-click = exclude. Frame {frameIndex} @
              {" "}
              <input
                type="number"
                value={fps}
                onChange={(e) => setFps(Number(e.target.value) || 30)}
                className="w-14 bg-neutral-900 border border-neutral-700 rounded px-1"
              />{" "}
              fps · {points.length} point(s)
            </p>
            <div className="relative inline-block max-w-full" onClick={onClickFrame}>
              <video
                ref={videoRef}
                src={localVideo}
                className="max-h-[60vh] max-w-full block"
                controls={false}
                playsInline
                onLoadedMetadata={detectFps}
                onPlay={sync}
                onPause={sync}
                onSeeked={sync}
              />
              {maskUrl && (
                <video
                  ref={maskRef}
                  src={maskUrl}
                  muted
                  playsInline
                  className="absolute inset-0 w-full h-full pointer-events-none opacity-60 mix-blend-screen"
                  style={{ filter: "sepia(1) saturate(8) hue-rotate(-50deg)" }}
                />
              )}
              {v &&
                points.map((p, i) => (
                  <span
                    key={i}
                    className={`absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white ${
                      p.label ? "bg-green-500" : "bg-red-500"
                    }`}
                    style={{
                      left: `${(p.x / v.videoWidth) * 100}%`,
                      top: `${(p.y / v.videoHeight) * 100}%`,
                    }}
                  />
                ))}
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <input
                type="range"
                min={0}
                max={v?.duration || 0}
                step={1 / fps}
                onChange={(e) => {
                  if (videoRef.current) videoRef.current.currentTime = Number(e.target.value);
                }}
                className="w-64"
              />
              <button className="btn" onClick={() => (v?.paused ? v.play() : v?.pause())}>
                Play / pause
              </button>
              <button className="btn" onClick={() => setPoints([])}>
                Clear points
              </button>
              <button className="btn-primary" disabled={!points.length || !!busy} onClick={runMask}>
                Build mask
              </button>
              {maskUrl && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={maskOk} onChange={(e) => setMaskOk(e.target.checked)} />
                  Mask looks right
                </label>
              )}
            </div>
          </>
        )}
      </section>

      {/* 2. Face */}
      <section className="space-y-3">
        <h2 className="font-semibold">2. Who goes in</h2>
        <p className="text-sm text-neutral-400">
          One photo per person (H3 takes up to 4). Say who each one replaces by look + position,
          e.g. &quot;the man in the striped shirt on the left&quot;.
        </p>
        <div className="space-y-2">
          {cast.map((c, n) => (
            <div key={c.preview} className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.preview} alt="" className="h-16 w-16 object-cover rounded" />
              <span className="text-xs text-neutral-500">#{n + 1} replaces</span>
              <input
                value={c.who}
                onChange={(e) =>
                  setCast((s) => s.map((x, i) => (i === n ? { ...x, who: e.target.value } : x)))
                }
                placeholder="the man in the striped shirt on the left"
                className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
              />
              <button className="btn" onClick={() => setCast((s) => s.filter((_, i) => i !== n))}>
                ✕
              </button>
            </div>
          ))}
        </div>
        {cast.length < 4 && (
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setCast((s) => [...s, { file: f, preview: URL.createObjectURL(f), who: "" }]);
              e.target.value = "";
            }}
          />
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Twist (optional; required for Regen): wearing a gold crown, pouring rain…"
          className="w-full bg-neutral-900 border border-neutral-700 rounded p-2 text-sm"
          rows={2}
        />
      </section>

      {/* 3. Model */}
      <section className="space-y-3">
        <h2 className="font-semibold">3. Model</h2>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {MODELS.map((m) => (
            <button
              key={m.id}
              onClick={() => setModelId(m.id)}
              className={`text-left rounded border p-3 text-sm ${
                m.id === modelId ? "border-white" : "border-neutral-700 text-neutral-400"
              }`}
            >
              <div className="font-medium">{m.name}</div>
              <div className="text-xs uppercase text-neutral-500">{m.provider}</div>
              <div>{m.note}</div>
              <div className="mt-1 text-xs">~${m.usdPerSec}/s</div>
            </button>
          ))}
        </div>
        <button className="btn-primary" disabled={!canGenerate} onClick={generate}>
          Generate {duration ? `(~$${cost})` : ""}
        </button>
        {model.usesMask && !maskOk && (
          <p className="text-xs text-neutral-500">This model needs a validated mask.</p>
        )}
      </section>

      {(busy || error) && (
        <div className="rounded border border-neutral-700 p-3 text-sm">
          {busy && <p>{busy} <span className="text-neutral-500">{log}</span></p>}
          {error && <p className="text-red-400 break-all">{error}</p>}
        </div>
      )}

      {/* Results */}
      {history.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold">Results</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {history.map((r) => (
              <figure key={r.at} className="space-y-1">
                <video src={r.url} controls playsInline className="w-full rounded" />
                <figcaption className="text-xs text-neutral-500 flex justify-between">
                  <span>{r.model} · {new Date(r.at).toLocaleString()}</span>
                  <a href={r.url} target="_blank" className="underline">download</a>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
