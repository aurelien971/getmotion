"use client";

import { useEffect, useState } from "react";

// A row of frames from the original around one moment, with a marker where a
// cut was detected (between frame `cut - 1` and frame `cut`).
export function FrameRow({ src, fps, cut, before = 6, after = 6 }: { src: string; fps: number; cut: number; before?: number; after?: number }) {
  const frames = Array.from({ length: before + after }, (_, i) => cut - before + i).filter((f) => f >= 0);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const key = `${src}|${cut}|${fps}`;

  useEffect(() => {
    let stop = false;
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.src = src;
    v.muted = true;
    v.preload = "auto";
    const c = document.createElement("canvas");
    (async () => {
      await new Promise<void>((r) => (v.onloadedmetadata = () => r()));
      const h = 72;
      const w = Math.round((v.videoWidth / v.videoHeight) * h);
      c.width = w;
      c.height = h;
      for (const f of frames) {
        if (stop) return;
        await new Promise<void>((r) => {
          v.onseeked = () => r();
          v.currentTime = (f + 0.5) / fps;
        });
        c.getContext("2d")!.drawImage(v, 0, 0, w, h);
        const url = c.toDataURL("image/jpeg", 0.7);
        if (!stop) setThumbs((t) => ({ ...t, [f]: url }));
      }
    })();
    return () => {
      stop = true;
      v.src = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className="overflow-x-auto [scrollbar-width:none]">
      <div className="flex gap-1 w-max items-stretch">
        {frames.map((f) => (
          <div key={f} className="flex items-stretch gap-1">
            {f === cut && <div className="w-0.5 rounded bg-[#fcd34d]" title="Detected cut" />}
            <div className="relative w-24 aspect-video rounded-md overflow-hidden bg-white/[0.04] ring-1 ring-hair">
              {thumbs[f] && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumbs[f]} alt="" className="absolute inset-0 w-full h-full object-cover" />
              )}
              <span className="absolute bottom-0 inset-x-0 text-[9px] leading-[14px] text-center bg-black/60 tabular-nums">f{f}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
