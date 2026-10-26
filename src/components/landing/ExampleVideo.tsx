"use client";

import { useEffect, useRef, useState } from "react";

// The example render: plays muted on a loop (the only way browsers allow autoplay),
// pauses when it scrolls out of view, and has one control, sound on/off.
// People who ask for reduced motion get the poster and a play button instead.
export function ExampleVideo({ src, poster }: { src: string; poster: string }) {
  const v = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(true);

  useEffect(() => {
    const el = v.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && !still) el.play().catch(() => {});
        else el.pause();
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const toggleSound = () => {
    const el = v.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
    if (!el.muted && el.paused) el.play().catch(() => {});
  };

  return (
    <div className="example relative overflow-hidden rounded-[28px]">
      <video
        ref={v}
        src={src}
        poster={poster}
        muted
        loop
        playsInline
        preload="metadata"
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        className="block aspect-video w-full bg-black object-cover"
      />
      {paused && (
        <button type="button" onClick={() => v.current?.play()} className="example-play" aria-label="Play the example">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path d="M5 3.2v9.6L12.8 8z" fill="currentColor" />
          </svg>
        </button>
      )}
      <button type="button" onClick={toggleSound} className="example-sound" aria-label={muted ? "Turn sound on" : "Turn sound off"} aria-pressed={!muted}>
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
          <path d="M3.5 7.5h3l4-3.5v12l-4-3.5h-3z" fill="currentColor" />
          {muted ? (
            <path d="M13.5 7.5l4 5M17.5 7.5l-4 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          ) : (
            <path d="M13.5 7a4 4 0 010 6M15.8 5a7 7 0 010 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          )}
        </svg>
      </button>
    </div>
  );
}
