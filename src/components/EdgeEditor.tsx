"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ReelPlayer } from "@/components/ReelPlayer";

const SPAN = 9; // frames shown either side of an edge

type Props = {
  src: string;
  fps: number;
  duration: number;
  start: number;
  end: number;
  title: string;
  onSave: (start: number, end: number) => void;
  onClose: () => void;
};

// Frame-accurate trim for one shot: pick the exact first and last frame, with the
// frames from the neighbouring scenes visible on either side.
export function EdgeEditor({ src, fps, duration, start, end, title, onSave, onClose }: Props) {
  const totalFrames = Math.floor(duration * fps);
  const [first, setFirst] = useState(Math.round(start * fps));
  const [last, setLast] = useState(Math.max(Math.round(start * fps), Math.round(end * fps) - 1));
  const [firstCenter, setFirstCenter] = useState(first);
  const [lastCenter, setLastCenter] = useState(last);
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map());
  const cache = useRef(new Map<number, string>());
  const vid = useRef<HTMLVideoElement | null>(null);
  const job = useRef(0);

  const range = (c: number) =>
    Array.from({ length: SPAN * 2 + 1 }, (_, i) => c - SPAN + i).filter((f) => f >= 0 && f < totalFrames);
  const wanted = [...range(firstCenter), ...range(lastCenter)];
  const wantKey = wanted.join(",");

  useEffect(() => {
    const v = document.createElement("video");
    v.src = src;
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    vid.current = v;
    return () => {
      v.src = "";
      vid.current = null;
    };
  }, [src]);

  useEffect(() => {
    const v = vid.current;
    if (!v) return;
    const id = ++job.current;
    const todo = wanted.filter((f) => !cache.current.has(f));
    if (!todo.length) return;
    const c = document.createElement("canvas");
    (async () => {
      if (v.readyState < 1) await new Promise<void>((r) => v.addEventListener("loadedmetadata", () => r(), { once: true }));
      const h = 108;
      const w = Math.round((v.videoWidth / v.videoHeight) * h);
      c.width = w;
      c.height = h;
      for (const f of todo) {
        if (job.current !== id) return;
        await new Promise<void>((r) => {
          v.onseeked = () => r();
          v.currentTime = (f + 0.5) / fps;
        });
        c.getContext("2d")!.drawImage(v, 0, 0, w, h);
        cache.current.set(f, c.toDataURL("image/jpeg", 0.75));
        setThumbs(new Map(cache.current));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantKey, fps]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const changed = first !== Math.round(start * fps) || last + 1 !== Math.round(end * fps);
  const len = (last + 1 - first) / fps;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xl overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <header className="flex items-center gap-4">
          <div className="flex-1">
            <h2 className="text-[20px] tracking-tight">Trim · {title}</h2>
            <p className="text-muted text-[13px]">
              Click the exact first and last frame of this shot. Dimmed frames are outside it. Moving an edge moves the
              neighbouring shot&apos;s edge too.
            </p>
          </div>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-on" disabled={!changed} onClick={() => onSave(first / fps, (last + 1) / fps)}>
            Save edges
          </button>
        </header>

        <div className="grid md:grid-cols-[minmax(0,1fr)_260px] gap-6 items-start">
          <ReelPlayer src={src} fps={fps} spans={[{ start: first / fps, end: (last + 1) / fps }]} className="aspect-video" />
          <div className="glass rounded-2xl p-4 space-y-2 text-[13px] tabular-nums">
            <Row k="First frame" v={`f${first} · ${(first / fps).toFixed(3)}s`} />
            <Row k="Last frame" v={`f${last} · ${(last / fps).toFixed(3)}s`} />
            <Row k="Length" v={`${last + 1 - first} frames · ${len.toFixed(2)}s`} />
            <Row k="Frame rate" v={`${fps} fps`} />
          </div>
        </div>

        <Strip
          label="First frame"
          hint="Frames before the shot start are from the previous scene"
          frames={range(firstCenter)}
          thumbs={thumbs}
          inside={(f) => f >= first && f <= last}
          edge={first}
          tag="First"
          onPick={(f) => f <= last && setFirst(f)}
          onShift={(d) => setFirstCenter((c) => Math.max(0, Math.min(totalFrames - 1, c + d)))}
        />
        <Strip
          label="Last frame"
          hint="Frames after the shot end are from the next scene"
          frames={range(lastCenter)}
          thumbs={thumbs}
          inside={(f) => f >= first && f <= last}
          edge={last}
          tag="Last"
          onPick={(f) => f >= first && setLast(f)}
          onShift={(d) => setLastCenter((c) => Math.max(0, Math.min(totalFrames - 1, c + d)))}
        />
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{k}</span>
      <span>{v}</span>
    </div>
  );
}

function Strip({
  label,
  hint,
  frames,
  thumbs,
  inside,
  edge,
  tag,
  onPick,
  onShift,
}: {
  label: string;
  hint: string;
  frames: number[];
  thumbs: Map<number, string>;
  inside: (f: number) => boolean;
  edge: number;
  tag: string;
  onPick: (f: number) => void;
  onShift: (d: number) => void;
}) {
  const edgeRef = useRef<HTMLButtonElement | null>(null);
  const center = frames[Math.floor(frames.length / 2)];
  useLayoutEffect(() => {
    edgeRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [edge, center]);
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-3">
        <h3 className="text-[14px]">{label}</h3>
        <span className="text-faint text-[12px] flex-1">{hint}</span>
        <div className="seg glass">
          <button onClick={() => onShift(-SPAN)} aria-label="Earlier">‹‹</button>
          <button onClick={() => onShift(SPAN)} aria-label="Later">››</button>
        </div>
      </div>
      <div className="glass rounded-2xl p-2 overflow-x-auto">
        <div className="flex gap-1.5 w-max">
          {frames.map((f) => {
            const inS = inside(f);
            const isEdge = f === edge;
            const url = thumbs.get(f);
            return (
              <button
                key={f}
                ref={isEdge ? edgeRef : undefined}
                onClick={() => onPick(f)}
                className={`relative w-28 shrink-0 aspect-video rounded-lg overflow-hidden transition ${
                  isEdge ? "ring-2 ring-white" : "ring-1 ring-white/10 hover:ring-white/50"
                }`}
                title={`Frame ${f}`}
              >
                {url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={url} alt="" className={`absolute inset-0 w-full h-full object-cover ${inS ? "" : "opacity-35 grayscale"}`} />
                )}
                {isEdge && (
                  <span className="absolute top-1 left-1 text-[10px] bg-white text-black rounded px-1.5 font-medium">{tag}</span>
                )}
                <span className="absolute bottom-0 inset-x-0 text-[10px] leading-4 text-center bg-black/60 tabular-nums">
                  f{f}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
