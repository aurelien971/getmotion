"use client";

import { useEffect, useRef, useState } from "react";

type Piece = { start: number; end: number; offset: number };

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;

// Every frame of the exact file that will be uploaded, grouped by piece, each
// labelled with the source frame it came from. Plus a frame-step player of the file.
export function ClipInspector({
  file,
  fps,
  sourceFps,
  pieces,
  padFrom,
  title,
  onClose,
  onDrop,
}: {
  file: Blob;
  fps: number; // the clip's frame rate
  sourceFps: number;
  pieces: Piece[];
  padFrom: number; // clip time where loop filler starts
  title: string;
  onClose: () => void;
  onDrop?: (drops: { piece: number; start: number; end: number }[]) => void; // frames to cut off each piece's start / end
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    const t = setTimeout(() => setUrl(u), 0);
    return () => {
      clearTimeout(t);
      URL.revokeObjectURL(u);
    };
  }, [file]);
  const [count, setCount] = useState(0);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const toggleMark = (f: number) =>
    setMarked((m) => {
      const n = new Set(m);
      if (n.has(f)) n.delete(f);
      else n.add(f);
      return n;
    });
  const player = useRef<HTMLVideoElement>(null);

  // Decode every frame once into a small thumbnail.
  useEffect(() => {
    if (!url) return;
    let stop = false;
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    v.preload = "auto";
    const c = document.createElement("canvas");
    (async () => {
      await new Promise<void>((r) => (v.onloadedmetadata = () => r()));
      const n = Math.round(v.duration * fps);
      setCount(n);
      const h = 64;
      const w = Math.round((v.videoWidth / v.videoHeight) * h);
      c.width = w;
      c.height = h;
      const out: string[] = [];
      for (let f = 0; f < n; f++) {
        if (stop) return;
        await new Promise<void>((r) => {
          v.onseeked = () => r();
          v.currentTime = (f + 0.5) / fps;
        });
        c.getContext("2d")!.drawImage(v, 0, 0, w, h);
        out.push(c.toDataURL("image/jpeg", 0.6));
        if (f % 12 === 11 || f === n - 1) setThumbs([...out]);
      }
    })();
    return () => {
      stop = true;
      v.src = "";
    };
  }, [url, fps]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setSel((s) => Math.min(count - 1, s + 1));
      if (e.key === "ArrowLeft") setSel((s) => Math.max(0, s - 1));
      if (e.key === "d" || e.key === "D") toggleMark(sel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, count, sel]);

  useEffect(() => {
    const v = player.current;
    if (v && v.paused) v.currentTime = (sel + 0.5) / fps;
  }, [sel, fps]);

  // Which piece a clip frame belongs to, and the source frame it shows.
  const info = (f: number) => {
    const t = (f + 0.5) / fps;
    if (t >= padFrom) return { piece: -1, src: null as number | null };
    const j = pieces.findIndex((p) => t >= p.offset && t < p.offset + (p.end - p.start));
    if (j < 0) return { piece: -1, src: null };
    return { piece: j, src: Math.floor((pieces[j].start + (t - pieces[j].offset)) * sourceFps + 1e-3) };
  };
  const cur = info(sel);
  const groups: { piece: number; frames: number[] }[] = [];
  for (let f = 0; f < count; f++) {
    const p = info(f).piece;
    const last = groups[groups.length - 1];
    if (last && last.piece === p) last.frames.push(f);
    else groups.push({ piece: p, frames: [f] });
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xl overflow-y-auto">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-5">
        <header className="flex items-center gap-4">
          <div className="flex-1">
            <h2 className="text-[20px] tracking-tight">Inspect · {title}</h2>
            <p className="text-muted text-[13px]">
              This is the exact file that gets uploaded: {count || "…"} frames. Click a frame (or ← →), press D to mark it for
              drop, then drop them all at once.
            </p>
          </div>
          <button className="btn" onClick={onClose}>Close</button>
        </header>

        <div className="grid md:grid-cols-[minmax(0,1fr)_280px] gap-5 items-start">
          <video ref={player} src={url ?? undefined} controls playsInline className="w-full aspect-video rounded-2xl bg-black ring-1 ring-hair" />
          <div className="glass rounded-2xl p-4 space-y-2 text-[13px] tabular-nums">
            <div className="flex justify-between"><span className="text-muted">Clip frame</span><span>{sel} / {Math.max(0, count - 1)}</span></div>
            <div className="flex justify-between">
              <span className="text-muted">Piece</span>
              <span>{cur.piece >= 0 ? cur.piece + 1 : "loop filler"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Source frame</span>
              <span>{cur.src !== null ? `f${cur.src} · ${fmt(cur.src / sourceFps)}` : "—"}</span>
            </div>
            <div className="flex gap-2 pt-2">
              <button className="btn flex-1" onClick={() => setSel((s) => Math.max(0, s - 1))}>‹ Frame</button>
              <button className="btn flex-1" onClick={() => setSel((s) => Math.min(count - 1, s + 1))}>Frame ›</button>
            </div>
            {onDrop && cur.piece >= 0 && (
              <button className={`btn w-full ${marked.has(sel) ? "btn-on" : ""}`} onClick={() => toggleMark(sel)}>
                {marked.has(sel) ? "Unmark (D)" : "Mark for drop (D)"}
              </button>
            )}
            {onDrop && marked.size > 0 && (() => {
              // Marked frames must run from a piece's first frame in, or from its last frame back.
              const drops: { piece: number; start: number; end: number }[] = [];
              let stray = 0;
              pieces.forEach((pc, j) => {
                const first = Math.round(pc.offset * fps);
                const last = Math.round((pc.offset + (pc.end - pc.start)) * fps) - 1;
                let a = 0;
                while (marked.has(first + a) && first + a <= last) a++;
                let b = 0;
                while (marked.has(last - b) && last - b >= first + a) b++;
                for (let f = first + a; f <= last - b; f++) if (marked.has(f)) stray++;
                if (a || b) drops.push({ piece: j, start: a, end: b });
              });
              const total = drops.reduce((n, d) => n + d.start + d.end, 0);
              return (
                <div className="space-y-1.5 pt-1">
                  {stray > 0 && (
                    <p className="text-[11px] text-[#fcd34d]">
                      {stray} marked frame{stray === 1 ? " is" : "s are"} in the middle of a piece. Only frames at a piece&apos;s start or end can be dropped here.
                    </p>
                  )}
                  <button className="btn btn-on w-full" disabled={!total} onClick={() => onDrop(drops)}>
                    Drop {total} frame{total === 1 ? "" : "s"} and rebuild
                  </button>
                  <button className="btn w-full" onClick={() => setMarked(new Set())}>Clear marks</button>
                </div>
              );
            })()}
            {thumbs.length < count && <p className="text-faint text-[11px]">Reading frames… {thumbs.length}/{count}</p>}
          </div>
        </div>

        <div className="space-y-4">
          {groups.map((gp, k) => (
            <section key={k} className="space-y-1.5">
              <h3 className="text-[12px] text-muted tabular-nums">
                {gp.piece >= 0
                  ? `Piece ${gp.piece + 1} · source ${fmt(pieces[gp.piece].start)} – ${fmt(pieces[gp.piece].end)} · ${gp.frames.length} frames`
                  : `Loop filler (thrown away) · ${gp.frames.length} frames`}
              </h3>
              <div className={`flex flex-wrap gap-1 ${gp.piece < 0 ? "opacity-40" : ""}`}>
                {gp.frames.map((f) => (
                  <button
                    key={f}
                    onClick={() => setSel(f)}
                    className={`relative w-[88px] aspect-video rounded overflow-hidden bg-white/[0.04] ${f === sel ? "ring-2 ring-white" : "ring-1 ring-white/10 hover:ring-white/40"}`}
                    title={`Clip frame ${f}`}
                  >
                    {thumbs[f] && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumbs[f]} alt="" className="absolute inset-0 w-full h-full object-cover" />
                    )}
                    {marked.has(f) && (
                      <span className="absolute inset-0 grid place-items-center bg-[rgba(220,38,38,0.45)] text-white text-[18px]">✕</span>
                    )}
                    <span className="absolute bottom-0 inset-x-0 text-[9px] leading-[13px] text-center bg-black/60 tabular-nums">{f}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
