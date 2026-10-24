"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  src: string;
  duration: number;
  time: number;
  maxLen: number;
  range: [number, number];
  onRange: (r: [number, number]) => void;
  onSeek: (t: number) => void;
};

const THUMBS = 16;
const MIN_LEN = 1;

// iOS Photos-style trimmer: a thumbnail strip, a bracket with two handles,
// dimmed footage outside the selection, and a playhead.
export function Trimmer({ src, duration, time, maxLen, range, onRange, onSeek }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [start, end] = range;

  // Pull evenly spaced frames from a hidden video element.
  useEffect(() => {
    let cancelled = false;
    const v = document.createElement("video");
    v.src = src;
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    const canvas = document.createElement("canvas");
    const out: string[] = [];

    const grab = (t: number) =>
      new Promise<void>((resolve) => {
        v.onseeked = () => {
          const h = 96;
          const w = Math.round((v.videoWidth / v.videoHeight) * h) || 54;
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d")?.drawImage(v, 0, 0, w, h);
          out.push(canvas.toDataURL("image/jpeg", 0.6));
          resolve();
        };
        v.currentTime = t;
      });

    v.onloadedmetadata = async () => {
      for (let i = 0; i < THUMBS && !cancelled; i++) {
        await grab(((i + 0.5) / THUMBS) * v.duration);
        setThumbs([...out]);
      }
    };
    return () => {
      cancelled = true;
      v.src = "";
    };
  }, [src]);

  const px = (t: number) => `${(t / duration) * 100}%`;

  function timeAt(clientX: number) {
    const el = stripRef.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  }

  function onDown(e: React.PointerEvent<HTMLDivElement>) {
    const kind = e.currentTarget.dataset.kind as "start" | "end" | "move";
    {
      e.preventDefault();
      e.stopPropagation();
      const origin = timeAt(e.clientX);
      const [s0, e0] = range;
      const len = e0 - s0;
      const onMove = (ev: PointerEvent) => {
        const t = timeAt(ev.clientX);
        if (kind === "start") {
          const s = Math.min(t, e0 - MIN_LEN);
          const en = Math.min(e0, s + maxLen);
          onRange([Math.max(0, s), en]);
          onSeek(Math.max(0, s));
        } else if (kind === "end") {
          const en = Math.max(t, s0 + MIN_LEN);
          const s = Math.max(s0, en - maxLen);
          onRange([s, Math.min(duration, en)]);
          onSeek(Math.min(duration, en));
        } else {
          let s = s0 + (t - origin);
          s = Math.max(0, Math.min(duration - len, s));
          onRange([s, s + len]);
          onSeek(s);
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    }
  }

  return (
    <div className="select-none">
      <div
        ref={stripRef}
        className="relative h-14 rounded-lg overflow-hidden bg-raise touch-none"
        onPointerDown={(e) => onSeek(timeAt(e.clientX))}
      >
        <div className="absolute inset-0 flex">
          {Array.from({ length: THUMBS }).map((_, i) =>
            thumbs[i] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={thumbs[i]} alt="" className="h-full flex-1 object-cover min-w-0" draggable={false} />
            ) : (
              <div key={i} className="h-full flex-1 bg-raise" />
            ),
          )}
        </div>

        {/* dim outside the selection */}
        <div className="absolute inset-y-0 left-0 bg-stage/70" style={{ width: px(start) }} />
        <div className="absolute inset-y-0 right-0 bg-stage/70" style={{ width: px(duration - end) }} />

        {/* bracket */}
        <div
          className="absolute inset-y-0 border-y-[3px] border-tally cursor-grab active:cursor-grabbing"
          style={{ left: px(start), width: px(end - start) }}
          data-kind="move"
          onPointerDown={onDown}
        >
          <Handle side="left" onPointerDown={onDown} />
          <Handle side="right" onPointerDown={onDown} />
        </div>

        {/* playhead */}
        <div
          className="absolute inset-y-0 w-[2px] bg-white pointer-events-none shadow-[0_0_0_1px_rgba(0,0,0,.5)]"
          style={{ left: `calc(${px(time)} - 1px)` }}
        />
      </div>
    </div>
  );
}

function Handle({ side, onPointerDown }: { side: "left" | "right"; onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void }) {
  return (
    <div
      data-kind={side === "left" ? "start" : "end"}
      onPointerDown={onPointerDown}
      className={`absolute inset-y-[-3px] w-5 bg-tally flex items-center justify-center cursor-ew-resize touch-none ${
        side === "left" ? "left-0 rounded-l-lg" : "right-0 rounded-r-lg"
      }`}
      aria-label={side === "left" ? "Start" : "End"}
    >
      <span className="w-[2px] h-5 rounded bg-black/50" />
    </div>
  );
}
