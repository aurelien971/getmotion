"use client";

import { useEffect, useRef, useState } from "react";
import { SoundButton, useSound } from "@/lib/sound";

type Span = { start: number; end: number };

// Plays a list of spans of one source back to back, straight from the original
// file: no encoding, so any selection can be reviewed instantly. Span edges are
// frame starts; playback hops on a per-frame callback so no frame from outside a
// span is ever shown.
export function ReelPlayer({
  src,
  spans,
  fps,
  className = "",
  onShot,
}: {
  src: string;
  spans: Span[];
  fps: number;
  className?: string;
  onShot?: (index: number) => void;
}) {
  const v = useRef<HTMLVideoElement>(null);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [local, setLocal] = useState(0);
  const idxRef = useRef(0);
  const [sound, setSound] = useSound();
  const total = spans.reduce((s, x) => s + x.end - x.start, 0);
  const key = spans.map((s) => `${s.start}-${s.end}`).join("|");
  const half = 0.5 / fps;

  // Seek to a frame by landing in its middle, so rounding never shows the one before.
  const seekTo = (el: HTMLVideoElement, t: number) => (el.currentTime = t + half);

  const select = (i: number) => {
    idxRef.current = i;
    setIdx(i);
    onShot?.(i);
  };

  useEffect(() => {
    const el = v.current;
    if (!el || !spans.length) return;
    el.pause();
    const go = () => seekTo(el, spans[0].start);
    if (el.readyState >= 1) go();
    else el.addEventListener("loadedmetadata", go, { once: true });
    const t = setTimeout(() => {
      select(0);
      setLocal(0);
      setPlaying(false);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, src]);

  useEffect(() => {
    if (!playing) return;
    const el = v.current!;
    let handle = 0;
    let stopped = false;
    const onFrame = (_: number, meta: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      const i = idxRef.current;
      const s = spans[i];
      // If the next frame would fall outside this span, hop now.
      if (meta.mediaTime + 1 / fps >= s.end - half / 2 || meta.mediaTime < s.start - 1 / fps) {
        const n = (i + 1) % spans.length;
        seekTo(el, spans[n].start);
        select(n);
      }
      const j = idxRef.current;
      const before = spans.slice(0, j).reduce((t, x) => t + x.end - x.start, 0);
      setLocal(before + Math.max(0, meta.mediaTime - spans[j].start));
      handle = el.requestVideoFrameCallback(onFrame);
    };
    handle = el.requestVideoFrameCallback(onFrame);
    return () => {
      stopped = true;
      el.cancelVideoFrameCallback(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, key, fps]);

  const toggle = () => {
    const el = v.current;
    if (!el || !spans.length) return;
    if (el.paused) {
      const s = spans[idxRef.current];
      if (el.currentTime < s.start || el.currentTime >= s.end - 1 / fps) seekTo(el, s.start);
      el.play();
      setPlaying(true);
    } else {
      el.pause();
      setPlaying(false);
    }
  };
  const jump = (d: number) => {
    const el = v.current;
    if (!el || !spans.length) return;
    const i = (idxRef.current + d + spans.length) % spans.length;
    seekTo(el, spans[i].start);
    select(i);
    setLocal(spans.slice(0, i).reduce((t, x) => t + x.end - x.start, 0));
  };

  if (!spans.length) {
    return (
      <div className={`flex items-center justify-center rounded-2xl ring-1 ring-hair bg-black text-muted text-[13px] ${className}`}>
        Nothing here yet
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className={`relative rounded-2xl overflow-hidden bg-black ring-1 ring-hair ${className}`}>
        <video ref={v} src={src} playsInline muted={!sound} className="w-full h-full object-contain cursor-pointer" onClick={toggle} />
        <span className="absolute left-3 top-3 text-[11px] tabular-nums bg-black/60 rounded-full px-2 py-0.5">
          Shot {idx + 1} / {spans.length}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button className="btn btn-icon" onClick={() => jump(-1)} aria-label="Previous shot">‹</button>
        <button className="btn btn-icon" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button className="btn btn-icon" onClick={() => jump(1)} aria-label="Next shot">›</button>
        <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden flex">
          {spans.map((s, i) => (
            <div
              key={i}
              className={`h-full border-r border-black/60 ${i < idx ? "bg-white/50" : i === idx ? "bg-white/80" : ""}`}
              style={{ width: `${((s.end - s.start) / total) * 100}%` }}
            />
          ))}
        </div>
        <span className="text-[12px] text-muted tabular-nums">
          {local.toFixed(1)}s / {total.toFixed(1)}s
        </span>
        <SoundButton on={sound} onChange={setSound} />
      </div>
    </div>
  );
}
