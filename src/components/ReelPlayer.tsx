"use client";

import { useEffect, useRef, useState } from "react";

type Span = { start: number; end: number };

// Plays a list of spans of one source back to back, straight from the original
// file: no encoding, so any selection can be reviewed instantly.
export function ReelPlayer({ src, spans, className = "" }: { src: string; spans: Span[]; className?: string }) {
  const v = useRef<HTMLVideoElement>(null);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [local, setLocal] = useState(0); // seconds into the reel
  const total = spans.reduce((s, x) => s + x.end - x.start, 0);
  const key = spans.map((s) => `${s.start}-${s.end}`).join("|");

  // Jump to the first span whenever the selection changes.
  useEffect(() => {
    const el = v.current;
    if (!el || !spans.length) return;
    el.pause();
    const go = () => (el.currentTime = spans[0].start);
    if (el.readyState >= 1) go();
    else el.addEventListener("loadedmetadata", go, { once: true });
    const t = setTimeout(() => {
      setIdx(0);
      setLocal(0);
      setPlaying(false);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, src]);

  // While playing, hop from one span to the next at its exact end.
  useEffect(() => {
    if (!playing) return;
    const el = v.current!;
    let i = idx;
    const tick = setInterval(() => {
      const s = spans[i];
      if (!s) return;
      if (el.currentTime >= s.end - 0.01 || el.currentTime < s.start - 0.25) {
        i = (i + 1) % spans.length;
        el.currentTime = spans[i].start;
        setIdx(i);
      }
      const before = spans.slice(0, i).reduce((t, x) => t + x.end - x.start, 0);
      setLocal(before + Math.max(0, el.currentTime - spans[i].start));
    }, 25);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, key]);

  const toggle = () => {
    const el = v.current;
    if (!el || !spans.length) return;
    if (el.paused) {
      const s = spans[idx];
      if (el.currentTime < s.start || el.currentTime >= s.end) el.currentTime = s.start;
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
    const i = (idx + d + spans.length) % spans.length;
    el.currentTime = spans[i].start;
    setIdx(i);
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
        <video ref={v} src={src} playsInline className="w-full h-full object-contain cursor-pointer" onClick={toggle} />
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
      </div>
    </div>
  );
}
