"use client";

import { useRef } from "react";

type Span = { start: number; end: number };

type Props = {
  duration: number;
  blocks: (Span & { color: string })[]; // shots with him, colored by look
  rendered: Span[]; // already rendered
  snapPoints: number[]; // scene cuts and marks
  snap: boolean;
  range: Span;
  onChange: (r: Span) => void;
};

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

// The whole video with a draggable span. Edges snap to scene cuts so a span never
// starts or ends mid-shot (two renders meeting inside a shot can show a seam).
export function RangePicker({ duration, blocks, rendered, snapPoints, snap, range, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = (t: number) => `${(t / (duration || 1)) * 100}%`;

  const timeAt = (x: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((x - r.left) / r.width) * duration));
  };
  const snapT = (t: number) => {
    if (!snap) return t;
    const pts = [0, duration, ...snapPoints];
    let best = t;
    let bd = (1.2 / 100) * duration + 0.4; // snap distance scales with length
    for (const p of pts) if (Math.abs(p - t) < bd) {
      bd = Math.abs(p - t);
      best = p;
    }
    return best;
  };

  function onDown(e: React.PointerEvent<HTMLDivElement>) {
    const kind = e.currentTarget.dataset.kind as "start" | "end" | "move";
    e.preventDefault();
    e.stopPropagation();
    const origin = timeAt(e.clientX);
    const r0 = { ...range };
    const len = r0.end - r0.start;
    const onMove = (ev: PointerEvent) => {
      const t = timeAt(ev.clientX);
      if (kind === "start") onChange({ start: Math.min(snapT(t), r0.end - 0.5), end: r0.end });
      else if (kind === "end") onChange({ start: r0.start, end: Math.max(snapT(t), r0.start + 0.5) });
      else {
        const s = snapT(Math.max(0, Math.min(duration - len, r0.start + (t - origin))));
        onChange({ start: s, end: Math.min(duration, s + len) });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div className="space-y-1.5 select-none">
      <div ref={ref} className="relative h-14 rounded-xl overflow-hidden bg-white/[0.03] ring-1 ring-hair touch-none">
        {blocks.map((b, i) => (
          <div
            key={i}
            className="absolute top-2 bottom-4 rounded-[2px]"
            style={{ left: pct(b.start), width: pct(b.end - b.start), background: b.color, opacity: 0.75 }}
          />
        ))}
        {rendered.map((r, i) => (
          <div
            key={`r${i}`}
            className="absolute bottom-1 h-2 rounded-full bg-white"
            style={{ left: pct(r.start), width: pct(r.end - r.start) }}
            title="Already rendered"
          />
        ))}
        <div className="absolute inset-y-0 left-0 bg-black/65" style={{ width: pct(range.start) }} />
        <div className="absolute inset-y-0 right-0 bg-black/65" style={{ width: pct(duration - range.end) }} />
        <div
          className="absolute inset-y-0 rounded-xl ring-2 ring-inset ring-white cursor-grab active:cursor-grabbing"
          style={{ left: pct(range.start), width: pct(range.end - range.start) }}
          data-kind="move"
          onPointerDown={onDown}
        >
          <div
            data-kind="start"
            onPointerDown={onDown}
            className="absolute inset-y-0 left-0 w-3 bg-white rounded-l-xl cursor-ew-resize grid place-items-center"
          >
            <span className="w-px h-5 bg-black/40" />
          </div>
          <div
            data-kind="end"
            onPointerDown={onDown}
            className="absolute inset-y-0 right-0 w-3 bg-white rounded-r-xl cursor-ew-resize grid place-items-center"
          >
            <span className="w-px h-5 bg-black/40" />
          </div>
        </div>
      </div>
      <div className="flex justify-between text-[11px] text-faint tabular-nums">
        <span>0:00</span>
        <span className="text-ink">
          {fmt(range.start)} – {fmt(range.end)} <span className="text-faint">· {(range.end - range.start).toFixed(1)}s</span>
        </span>
        <span>{fmt(duration)}</span>
      </div>
    </div>
  );
}
