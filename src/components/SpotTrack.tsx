"use client";

import { useRef } from "react";
import type { Boundary } from "@/lib/project";

type Props = {
  duration: number;
  boundaries: Boundary[];
  cuts: number[] | null;
  time: number;
  watched: number;
  onSeek: (t: number) => void;
  groups?: { start: number; end: number; color: string }[];
};

// The whole video as one bar: green where the target is in frame, dark where he
// isn't, hatched where nothing has been marked. Ticks are detected scene cuts.
export function SpotTrack({ duration, boundaries, cuts, time, watched, onSeek, groups }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = (t: number) => `${(Math.max(0, Math.min(duration, t)) / (duration || 1)) * 100}%`;

  const spans: { start: number; end: number; present: boolean | null }[] = [];
  let t = 0;
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    if (b.t > t) spans.push({ start: t, end: b.t, present: i === 0 ? null : boundaries[i - 1].present });
    t = b.t;
  }
  spans.push({ start: t, end: duration, present: boundaries.length ? boundaries[boundaries.length - 1].present : null });

  const seekAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    onSeek(((clientX - r.left) / r.width) * duration);
  };

  return (
    <div className="space-y-1.5 select-none">
      <div
        ref={ref}
        className="relative h-10 rounded-xl overflow-hidden bg-white/[0.03] ring-1 ring-hair cursor-pointer touch-none"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          seekAt(e.clientX);
        }}
        onPointerMove={(e) => e.buttons === 1 && seekAt(e.clientX)}
      >
        {spans.map((s, i) => (
          <div
            key={i}
            className="absolute inset-y-0"
            style={{
              left: pct(s.start),
              width: pct(s.end - s.start),
              background:
                s.present === true
                  ? "rgba(74, 222, 128, 0.55)"
                  : s.present === false
                    ? "rgba(255, 255, 255, 0.06)"
                    : "repeating-linear-gradient(135deg, rgba(255,255,255,0.05) 0 6px, transparent 6px 12px)",
            }}
          />
        ))}
        {groups?.map((g, i) => (
          <div
            key={`g${i}`}
            className="absolute bottom-0 h-1.5"
            style={{ left: pct(g.start), width: pct(g.end - g.start), background: g.color }}
          />
        ))}
        {cuts?.map((c) => (
          <div key={c} className="absolute top-0 h-2.5 w-px bg-white/40" style={{ left: pct(c) }} />
        ))}
        {boundaries.map((b) => (
          <div key={`b${b.t}`} className="absolute inset-y-0 w-0.5 bg-white" style={{ left: pct(b.t) }} />
        ))}
        {watched < duration && (
          <div className="absolute inset-y-0 right-0 bg-black/35" style={{ left: pct(watched) }} />
        )}
        <div
          className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-white shadow-[0_0_0_2px_rgba(0,0,0,0.6)] pointer-events-none"
          style={{ left: pct(time) }}
        />
      </div>
      <div className="flex justify-between text-[11px] text-faint tabular-nums">
        <span>0:00</span>
        <span className="flex gap-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "rgba(74,222,128,0.7)" }} /> in frame
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-white/15" /> not in frame
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-px h-2.5 bg-white/60" /> scene cut
          </span>
        </span>
        <span>{Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, "0")}</span>
      </div>
    </div>
  );
}
