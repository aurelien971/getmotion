"use client";

import { useEffect, useRef, useState } from "react";
import { SoundButton, useSound } from "@/lib/sound";

export type RenderPiece = { start: number; end: number; url: string; offset: number; head?: number; tail?: number }; // head/tail: junk frames held over
export type Chapter = { start: number; end: number; color: string; name: string };

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

// Plays a span of the original with finished renders laid over the exact source
// times they replace. Audio always comes from the original.
export function CompositePlayer({
  src,
  fps,
  span,
  renders,
  chapters = [],
  className = "",
}: {
  src: string;
  fps: number;
  span: { start: number; end: number };
  renders: RenderPiece[];
  chapters?: Chapter[];
  className?: string;
}) {
  const [sound, setSound] = useSound();
  const base = useRef<HTMLVideoElement>(null);
  // One preloaded player per render, so switching renders never shows a blank frame.
  const pool = useRef(new Map<string, HTMLVideoElement>());
  const [shown, setShown] = useState<string | null>(null);
  const urls = [...new Set(renders.map((r) => r.url))];
  const [withRenders, setWithRenders] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(span.start);
  const [active, setActive] = useState<RenderPiece | null>(null);
  const len = span.end - span.start;
  const coveredLen = renders.reduce(
    (s, r) => s + Math.max(0, Math.min(r.end, span.end) - Math.max(r.start, span.start)),
    0,
  );

  // Keep the overlay on the render that covers the current source time. A render
  // only takes over once its frame is decoded; until then the last picture stays.
  const syncOverlay = (t: number) => {
    const b = base.current;
    const f = 1 / fps;
    const r = withRenders ? renders.find((x) => t >= x.start - 0.5 * f && t < x.end - 0.5 * f) : undefined;
    setActive(r ?? null);
    const want = (x: RenderPiece, at: number) =>
      Math.max(x.offset + (x.head ?? 0) * f + 0.5 * f, Math.min(x.offset + (x.end - x.start) - ((x.tail ?? 0) + 0.5) * f, x.offset + (at - x.start)));
    // Park the next render on its first frame so it is ready when we get there.
    const next = withRenders ? renders.find((x) => x !== r && x.start > t && x.start - t < 2) : undefined;
    pool.current.forEach((o, url) => {
      if (r && url === r.url) return;
      if (!o.paused) o.pause();
      if (next && url === next.url && Math.abs(o.currentTime - want(next, next.start)) > 0.03) o.currentTime = want(next, next.start);
    });
    if (!r) {
      setShown(null);
      return;
    }
    const o = pool.current.get(r.url);
    if (!o) return;
    const w = want(r, t);
    const playing = !!b && !b.paused;
    if (Math.abs(o.currentTime - w) > (playing ? 0.08 : 0.02)) o.currentTime = w;
    if (playing && o.paused) o.play().catch(() => {});
    if (!playing && !o.paused) o.pause();
    if (o.readyState >= 2 && !o.seeking) setShown(r.url);
  };

  useEffect(() => {
    const b = base.current;
    if (!b) return;
    const go = () => {
      b.currentTime = span.start + 0.5 / fps;
      syncOverlay(span.start);
    };
    if (b.readyState >= 1) go();
    else b.addEventListener("loadedmetadata", go, { once: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [span.start, span.end, src]);

  useEffect(() => {
    const b = base.current;
    if (!b) return;
    let h = 0;
    let stop = false;
    const tick = (_: number, m: VideoFrameCallbackMetadata) => {
      if (stop) return;
      if (m.mediaTime >= span.end - 1 / fps) {
        b.pause();
        b.currentTime = span.start + 0.5 / fps;
        setPlaying(false);
      }
      setTime(m.mediaTime);
      syncOverlay(m.mediaTime);
      h = b.requestVideoFrameCallback(tick);
    };
    h = b.requestVideoFrameCallback(tick);
    return () => {
      stop = true;
      b.cancelVideoFrameCallback(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [span.start, span.end, renders, withRenders, fps]);

  const toggle = () => {
    const b = base.current;
    if (!b) return;
    if (b.paused) {
      if (b.currentTime < span.start || b.currentTime >= span.end - 1 / fps) b.currentTime = span.start + 0.5 / fps;
      b.play();
      setPlaying(true);
      syncOverlay(b.currentTime);
    } else {
      b.pause();
      pool.current.forEach((o) => o.pause());
      setPlaying(false);
    }
  };
  const seek = (t: number) => {
    const b = base.current;
    if (!b) return;
    b.currentTime = Math.max(span.start, Math.min(span.end - 1 / fps, t));
    setTime(b.currentTime);
    syncOverlay(b.currentTime);
  };
  const pct = (t: number) => `${((t - span.start) / (len || 1)) * 100}%`;

  return (
    <div className="space-y-2">
      <div className={`relative rounded-2xl overflow-hidden bg-black ring-1 ring-hair ${className}`}>
        <video
          ref={base}
          src={src}
          playsInline
          muted={!sound}
          className="w-full h-full object-contain cursor-pointer"
          onClick={toggle}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            setTime(t);
            syncOverlay(t);
          }}
          onSeeked={(e) => syncOverlay(e.currentTarget.currentTime)}
          onPlay={(e) => {
            setPlaying(true);
            syncOverlay(e.currentTarget.currentTime);
          }}
          onPause={(e) => {
            setPlaying(false);
            pool.current.forEach((o) => o.pause());
            syncOverlay(e.currentTarget.currentTime);
          }}
        />
        {urls.map((url) => (
          <video
            key={url}
            ref={(el) => {
              if (el) pool.current.set(url, el);
              else pool.current.delete(url);
            }}
            src={url}
            muted
            playsInline
            preload="auto"
            onSeeked={() => base.current && syncOverlay(base.current.currentTime)}
            onLoadedData={() => base.current && syncOverlay(base.current.currentTime)}
            className={`absolute inset-0 w-full h-full object-contain bg-black pointer-events-none ${active && shown === url ? "" : "invisible"}`}
          />
        ))}
        <span className="absolute left-3 top-3 flex gap-1.5">
          <span className="text-[11px] bg-black/60 rounded-full px-2 py-0.5">{active ? "Rendered" : "Original"}</span>
          {(() => {
            const ch = chapters.find((c) => time >= c.start && time < c.end);
            return ch ? (
              <span className="text-[11px] bg-black/60 rounded-full px-2 py-0.5 inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: ch.color }} />
                {ch.name}
              </span>
            ) : (
              <span className="text-[11px] bg-black/60 rounded-full px-2 py-0.5 text-muted">Not him</span>
            );
          })()}
        </span>
        <div className="absolute right-3 top-3 seg glass">
          <button className={!withRenders ? "on" : ""} onClick={() => setWithRenders(false)}>Original</button>
          <button className={withRenders ? "on" : ""} onClick={() => setWithRenders(true)}>
            With renders
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button className="btn btn-icon" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <div
          className="relative flex-1 h-6 cursor-pointer"
          onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seek(span.start + ((e.clientX - r.left) / r.width) * len);
          }}
        >
          <div className="absolute inset-x-0 top-2 h-1 rounded-full bg-white/10" />
          {chapters.map((c, i) => (
            <div
              key={`c${i}`}
              className="absolute bottom-0 h-1 rounded-full"
              style={{ left: pct(Math.max(c.start, span.start)), width: pct(span.start + Math.max(0, Math.min(c.end, span.end) - Math.max(c.start, span.start))), background: c.color }}
              title={c.name}
            />
          ))}
          {renders.map((r, i) => (
            <div
              key={i}
              className="absolute top-2 h-1 rounded-full bg-white/70"
              style={{ left: pct(Math.max(r.start, span.start)), width: pct(span.start + Math.max(0, Math.min(r.end, span.end) - Math.max(r.start, span.start))) }}
            />
          ))}
          <div className="absolute top-0.5 h-4 w-0.5 bg-white" style={{ left: pct(time) }} />
        </div>
        <span className="text-[12px] text-muted tabular-nums">
          {fmt(time)} · {Math.round((coveredLen / (len || 1)) * 100)}% rendered
        </span>
        <SoundButton on={sound} onChange={setSound} />
      </div>
    </div>
  );
}
