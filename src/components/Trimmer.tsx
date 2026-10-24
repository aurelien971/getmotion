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

const THUMBS = 20;
const MIN_LEN = 1;

// A thumbnail strip with a white bracket: drag the edges to set in/out, drag the
// middle to slide the window, tap anywhere to scrub.
export function Trimmer({ src, duration, time, maxLen, range, onRange, onSeek }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [start, end] = range;

  useEffect(() => {
    let cancelled = false;
    const v = document.createElement("video");
    v.crossOrigin = "anonymous"; // remote renders (fal) allow it; needed to read frames
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
    const r = stripRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  }

  function onDown(e: React.PointerEvent<HTMLDivElement>) {
    const kind = e.currentTarget.dataset.kind as "start" | "end" | "move";
    e.preventDefault();
    e.stopPropagation();
    const origin = timeAt(e.clientX);
    const [s0, e0] = range;
    const len = e0 - s0;
    const onMove = (ev: PointerEvent) => {
      const t = timeAt(ev.clientX);
      if (kind === "start") {
        const s = Math.max(0, Math.min(t, e0 - MIN_LEN));
        onRange([s, Math.min(e0, s + maxLen)]);
        onSeek(s);
      } else if (kind === "end") {
        const en = Math.min(duration, Math.max(t, s0 + MIN_LEN));
        onRange([Math.max(s0, en - maxLen), en]);
        onSeek(en);
      } else {
        const s = Math.max(0, Math.min(duration - len, s0 + (t - origin)));
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

  return (
    <div
      ref={stripRef}
      className="relative h-12 rounded-xl overflow-hidden select-none touch-none bg-white/[0.04]"
      onPointerDown={(e) => onSeek(timeAt(e.clientX))}
    >
      <div className="absolute inset-0 flex">
        {Array.from({ length: THUMBS }).map((_, i) =>
          thumbs[i] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={thumbs[i]} alt="" className="h-full flex-1 object-cover min-w-0" draggable={false} />
          ) : (
            <div key={i} className="h-full flex-1" />
          ),
        )}
      </div>

      <div className="absolute inset-y-0 left-0 bg-black/70" style={{ width: px(start) }} />
      <div className="absolute inset-y-0 right-0 bg-black/70" style={{ width: px(duration - end) }} />

      <div
        data-kind="move"
        onPointerDown={onDown}
        className="absolute inset-y-0 rounded-xl ring-2 ring-inset ring-white cursor-grab active:cursor-grabbing"
        style={{ left: px(start), width: px(end - start) }}
      >
        <Handle side="left" onPointerDown={onDown} />
        <Handle side="right" onPointerDown={onDown} />
      </div>

      <div
        className="absolute inset-y-0 w-px bg-white pointer-events-none shadow-[0_0_0_1px_rgba(0,0,0,.6)]"
        style={{ left: px(time) }}
      />
    </div>
  );
}

function Handle({
  side,
  onPointerDown,
}: {
  side: "left" | "right";
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      data-kind={side === "left" ? "start" : "end"}
      onPointerDown={onPointerDown}
      aria-label={side === "left" ? "Start" : "End"}
      className={`absolute inset-y-0 w-3.5 bg-white flex items-center justify-center cursor-ew-resize touch-none ${
        side === "left" ? "left-0 rounded-l-xl" : "right-0 rounded-r-xl"
      }`}
    >
      <span className="w-px h-4 rounded bg-black/40" />
    </div>
  );
}
