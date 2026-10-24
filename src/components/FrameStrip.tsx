"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  src: string;
  fps: number;
  duration: number;
  time: number;
  range: [number, number];
  step: number; // frames per thumbnail
  onSeek: (t: number) => void;
};

const COUNT = 36;
const THUMB_H = 72;

// The clip chopped up around the playhead, one thumbnail every `step` frames.
// Click a frame to land on it exactly. In/Out show as white lines.
export function FrameStrip({ src, fps, duration, time, range, step, onSeek }: Props) {
  const cache = useRef(new Map<number, string>());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map());
  const jobRef = useRef(0);

  const total = Math.max(1, Math.round(duration * fps));
  const center = Math.round(time * fps);
  const first = Math.max(0, Math.min(total - COUNT * step, center - Math.floor(COUNT / 2) * step));
  const frames = Array.from({ length: COUNT }, (_, i) => first + i * step).filter((f) => f < total);

  useEffect(() => {
    cache.current.clear();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThumbs(new Map());
    const v = document.createElement("video");
    v.crossOrigin = "anonymous"; // remote renders (fal) allow it; needed to read frames
    v.src = src;
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    videoRef.current = v;
    return () => {
      v.src = "";
      videoRef.current = null;
    };
  }, [src]);

  // Fill missing thumbnails for the visible frames, nearest the playhead first.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const job = ++jobRef.current;
    const missing = frames
      .filter((f) => !cache.current.has(f))
      .sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    if (!missing.length) return;

    const canvas = document.createElement("canvas");
    const run = async () => {
      if (v.readyState < 1) {
        await new Promise<void>((res) => v.addEventListener("loadedmetadata", () => res(), { once: true }));
      }
      for (const f of missing) {
        if (jobRef.current !== job) return;
        await new Promise<void>((res) => {
          v.onseeked = () => res();
          v.currentTime = Math.min(v.duration - 0.001, (f + 0.5) / fps);
        });
        if (jobRef.current !== job) return;
        const w = Math.round((v.videoWidth / v.videoHeight) * THUMB_H) || 128;
        canvas.width = w;
        canvas.height = THUMB_H;
        canvas.getContext("2d")?.drawImage(v, 0, 0, w, THUMB_H);
        cache.current.set(f, canvas.toDataURL("image/jpeg", 0.65));
        setThumbs(new Map(cache.current));
      }
    };
    const t = setTimeout(run, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, step, src, fps]);

  const inF = Math.round(range[0] * fps);
  const outF = Math.round(range[1] * fps);

  // Keep the current frame centred in view.
  const nowRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    nowRef.current?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [center, step]);

  return (
    <div className="glass rounded-2xl p-2 overflow-x-auto [scrollbar-width:none]">
      <div className="flex gap-1 w-max">
        {frames.map((f) => {
          const url = thumbs.get(f);
          const isNow = f <= center && center < f + step;
          const hasIn = f <= inF && inF < f + step;
          const hasOut = f <= outF && outF < f + step;
          return (
            <button
              key={f}
              ref={isNow ? nowRef : undefined}
              onClick={() => onSeek(f / fps)}
              className={`relative w-28 shrink-0 aspect-video rounded-md overflow-hidden bg-white/[0.04] ${
                isNow ? "ring-2 ring-white" : "ring-1 ring-white/10 hover:ring-white/40"
              }`}
              title={`f${f} · ${(f / fps).toFixed(3)}s`}
            >
              {url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
              )}
              {(hasIn || hasOut) && (
                <span className="absolute inset-y-0 w-0.5 bg-white" style={{ left: hasIn ? 0 : undefined, right: hasOut ? 0 : undefined }} />
              )}
              <span className="absolute bottom-0 left-0 right-0 text-[10px] leading-4 text-center bg-black/55 tabular-nums">
                {f}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
