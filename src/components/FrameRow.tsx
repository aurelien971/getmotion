"use client";

import { useEffect, useState } from "react";

// A row of frames from the original around one moment, with a marker where a
// cut was detected (between frame `cut - 1` and frame `cut`).
export function FrameRow({ src, fps, cut, before = 6, after = 6 }: { src: string; fps: number; cut: number; before?: number; after?: number }) {
  const frames = Array.from({ length: before + after }, (_, i) => cut - before + i).filter((f) => f >= 0);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  // Where the cut really is in these frames (biggest jump between neighbours), if clear.
  const [real, setReal] = useState<number | null>(null);
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
      const luma: number[][] = [];
      for (const f of frames) {
        if (stop) return;
        await new Promise<void>((r) => {
          v.onseeked = () => r();
          v.currentTime = (f + 0.5) / fps;
        });
        c.getContext("2d")!.drawImage(v, 0, 0, w, h);
        const url = c.toDataURL("image/jpeg", 0.7);
        const px = c.getContext("2d")!.getImageData(0, 0, w, h).data;
        const y: number[] = [];
        for (let i = 0; i < px.length; i += 16) y.push(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114);
        luma.push(y);
        if (!stop) setThumbs((t) => ({ ...t, [f]: url }));
      }
      const d = luma.slice(1).map((y, i) => y.reduce((s, v, k) => s + Math.abs(v - luma[i][k]), 0) / y.length);
      const sorted = [...d].sort((x, z) => x - z);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const best = d.reduce((bi, v, i) => (v > d[bi] ? i : bi), 0);
      if (!stop && d.length && d[best] > 10 && d[best] > median * 3) setReal(frames[best + 1]);
    })();
    return () => {
      stop = true;
      v.src = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const t = setTimeout(() => setReal(null), 0);
    return () => clearTimeout(t);
  }, [key]);

  return (
    <div className="overflow-x-auto [scrollbar-width:none]">
      <div className="flex gap-1 w-max items-stretch">
        {frames.map((f) => (
          <div key={f} className="flex items-stretch gap-1">
            {f === (real ?? cut) && <div className="w-0.5 rounded bg-[#fcd34d]" title={real !== null ? "Cut, measured on these frames" : "Detected cut"} />}
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
