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
  swap,
}: {
  // Frame swap: swap him into single frames with an image model, then make a take of them.
  swap?: {
    frames: Record<number, string>; // clip frame → swapped image URL
    busy: Set<number>;
    errors: Record<number, string>; // frames that failed, and why
    price: number;
    model: string;
    building: boolean;
    onSwap: (f: number) => void;
    onSwapAll: () => void;
    onSwapMany: (frames: number[]) => void;
    onRemove: (frames: number[]) => void;
    onMakeTake: () => void;
    promptFor: (f: number) => string; // what will be sent for that frame
    allPrompt: string;
    allEdited: boolean;
    frameEdited: (f: number) => boolean;
    onEditAll: (text: string | null) => void; // null resets to the built prompt
    onEditFrame: (f: number, text: string | null) => void; // null drops the frame's own prompt
    images: string[]; // what image 1, 2, 3… are
    people: { index: number; label: string; thumb?: string; on: boolean }[];
    onTogglePerson: (index: number) => void;
    region: { x: number; y: number; w: number; h: number } | null; // only this box is edited (0-1 of the frame)
    onRegion: (r: { x: number; y: number; w: number; h: number } | null) => void;
    mode: "swap" | "edit"; // edit: fix the frame only (no photos); swap: put people in
    onMode: (m: "swap" | "edit") => void;
    useAsInput: boolean; // the part renders from these frames
    onUseAsInput: (on: boolean) => void;
  };
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
  const [showSwapped, setShowSwapped] = useState(true);
  // Frames picked for a batch fix: click, shift-click for a range, cmd/ctrl-click to toggle.
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [drawing, setDrawing] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const pick = (f: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    setSel(f);
    if (e.shiftKey && anchor !== null) {
      const [a, b] = anchor < f ? [anchor, f] : [f, anchor];
      setPicked(new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k)));
    } else if (e.metaKey || e.ctrlKey) {
      setPicked((x) => {
        const n = new Set(x);
        if (n.has(f)) n.delete(f);
        else n.add(f);
        return n;
      });
      setAnchor(f);
    } else {
      setPicked(new Set());
      setAnchor(f);
    }
  };
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

        <div className="grid md:grid-cols-[minmax(0,1fr)_360px] gap-5 items-start">
          <div className="relative">
            <video ref={player} src={url ?? undefined} controls playsInline className="w-full aspect-video rounded-2xl bg-black ring-1 ring-hair" />
            {swap && showSwapped && swap.frames[sel] && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={swap.frames[sel]} alt="" className="absolute inset-0 w-full h-full object-contain rounded-2xl bg-black pointer-events-none" />
            )}
            {swap && showSwapped && swap.frames[sel] && (
              <span className="absolute left-3 top-3 text-[11px] bg-black/60 rounded-full px-2 py-0.5">Swapped frame</span>
            )}
            {swap && (drawing || swap.region) && (() => {
              const r = drag
                ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) }
                : swap.region;
              const at = (e: React.PointerEvent<HTMLDivElement>) => {
                const b = e.currentTarget.getBoundingClientRect();
                return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) };
              };
              return (
                <div
                  className={`absolute inset-0 rounded-2xl ${drawing ? "cursor-crosshair bg-black/20" : "pointer-events-none"}`}
                  onPointerDown={(e) => {
                    if (!drawing) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    const a = at(e);
                    setDrag({ x0: a.x, y0: a.y, x1: a.x, y1: a.y });
                  }}
                  onPointerMove={(e) => drag && setDrag({ ...drag, x1: at(e).x, y1: at(e).y })}
                  onPointerUp={() => {
                    if (drag) {
                      const box = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
                      if (box.w > 0.02 && box.h > 0.02) swap.onRegion(box);
                    }
                    setDrag(null);
                    setDrawing(false);
                  }}
                >
                  {r && (
                    <div
                      className="absolute ring-2 ring-[#7dd3fc] bg-[#7dd3fc]/10 rounded-sm"
                      style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
                    />
                  )}
                  {drawing && !drag && (
                    <span className="absolute left-1/2 top-3 -translate-x-1/2 text-[12px] bg-black/70 rounded-full px-3 py-1">Drag a box around the area to change</span>
                  )}
                </div>
              );
            })()}
          </div>
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
            {swap && (() => {
              const real = Array.from({ length: count }, (_, f) => f).filter((f) => info(f).piece >= 0);
              const done = real.filter((f) => swap.frames[f]).length;
              const left = real.length - done;
              const running = swap.busy.size;
              const edit = swap.mode === "edit";
              const verb = edit ? "Edit" : "Swap";
              return (
                <div className="pt-3 mt-2 border-t border-hair space-y-3">
                  <div className="flex items-center justify-between">
                    <span>Fix frames with {swap.model}</span>
                    <span className="text-faint text-[11px]">${swap.price.toFixed(2)} / frame</span>
                  </div>
                  <div className="seg glass w-full grid grid-cols-2">
                    <button className={edit ? "on" : ""} onClick={() => swap.onMode("edit")}>Edit frames, then render</button>
                    <button className={!edit ? "on" : ""} onClick={() => swap.onMode("swap")}>Swap people per frame</button>
                  </div>
                  <p className="text-faint text-[11px] leading-relaxed">
                    {edit
                      ? "Step 1: fix only what blocks the render (a gesture, a frame the model chokes on). Step 2: the part renders from your fixed frames, and the video model swaps him smoothly."
                      : "Every frame gets him swapped in by the image model, then the frames become a take. Expect some flicker."}
                  </p>

                  <div className="rounded-xl ring-1 ring-hair p-3 space-y-2">
                    <div className="flex items-center justify-between text-[12px]">
                      <span>{edit ? "1 · Fix frames" : "Frames"}</span>
                      <span className="text-muted">
                        {done}/{real.length} done{running ? ` · ${running} running` : ""}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[12px]">
                      <span className="flex-1 text-muted">
                        {swap.region ? "Only the blue box changes; the rest stays identical" : "Whole frame (or draw a box to change only an area)"}
                      </span>
                      <button className={`btn h-7 px-2.5 text-[11px] ${drawing ? "btn-on" : ""}`} onClick={() => setDrawing((d) => !d)}>
                        {drawing ? "Drawing…" : swap.region ? "Redraw box" : "Draw box"}
                      </button>
                      {swap.region && (
                        <button className="btn h-7 px-2.5 text-[11px]" onClick={() => swap.onRegion(null)}>Clear</button>
                      )}
                    </div>
                    {Object.keys(swap.errors).length > 0 && (
                      <p className="text-[11px] text-[#fca5a5]">{Object.keys(swap.errors).length} frame{Object.keys(swap.errors).length === 1 ? "" : "s"} failed (red dot). Click one to see why.</p>
                    )}
                    {swap.errors[sel] && <p className="text-[11px] text-[#fca5a5] break-words">Frame {sel}: {swap.errors[sel]}</p>}
                    {cur.piece >= 0 && (
                      <button className="btn w-full" disabled={swap.busy.has(sel)} onClick={() => swap.onSwap(sel)}>
                        {swap.busy.has(sel) ? "Working…" : swap.frames[sel] ? `Redo frame ${sel}` : `${verb} frame ${sel}`}
                      </button>
                    )}
                    {(() => {
                      const chosen = [...picked].filter((f) => info(f).piece >= 0).sort((a, b) => a - b);
                      const targets = chosen.length ? chosen : cur.piece >= 0 ? [sel] : [];
                      const fixedIn = targets.filter((f) => swap.frames[f]);
                      return (
                        <>
                          {chosen.length > 0 && (
                            <div className="flex items-center gap-2">
                              <button className="btn btn-on flex-1" disabled={running > 0} onClick={() => swap.onSwapMany(chosen)}>
                                {verb} {chosen.length} selected · ~${(chosen.length * swap.price).toFixed(2)}
                              </button>
                              <button className="btn" onClick={() => setPicked(new Set())}>Clear</button>
                            </div>
                          )}
                          {fixedIn.length > 0 && (
                            <button className="btn w-full" onClick={() => swap.onRemove(fixedIn)}>
                              Remove fix from {chosen.length ? `${fixedIn.length} selected` : `frame ${sel}`} (back to original)
                            </button>
                          )}
                          {!chosen.length && <p className="text-faint text-[11px]">Shift-click a frame to select a range, ⌘-click to add one.</p>}
                        </>
                      );
                    })()}
                    {left > 0 && (
                      <button className="btn btn-on w-full" disabled={running > 0} onClick={swap.onSwapAll}>
                        {running ? `${running} running…` : `${verb} all ${left} frame${left === 1 ? "" : "s"} · ~$${(left * swap.price).toFixed(2)}`}
                      </button>
                    )}
                    {edit && <p className="text-faint text-[11px]">Only fix the frames that need it; untouched frames stay original.</p>}
                    {done > 0 && (
                      <label className="flex items-center gap-2 text-[12px] text-muted">
                        <input type="checkbox" checked={showSwapped} onChange={(e) => setShowSwapped(e.target.checked)} /> Show fixed frames
                      </label>
                    )}
                  </div>

                  {edit ? (
                    <div className={`rounded-xl ring-1 p-3 space-y-2 ${swap.useAsInput ? "ring-[#86efac]/60" : "ring-hair"}`}>
                      <span className="text-[12px]">2 · Render from fixed frames</span>
                      <label className="flex items-center gap-2 text-[12px]">
                        <input type="checkbox" disabled={!done} checked={swap.useAsInput} onChange={(e) => swap.onUseAsInput(e.target.checked)} />
                        {swap.useAsInput ? "On: this part renders from your fixed frames" : "Use my fixed frames as this part's input"}
                      </label>
                      <p className="text-faint text-[11px]">Then close Inspect and press Render / Re-roll on the part. Padding uses the same fixed frames.</p>
                    </div>
                  ) : (
                    done > 0 && (
                      <button className="btn w-full" disabled={swap.building || running > 0} onClick={swap.onMakeTake}>
                        {swap.building ? "Building take…" : `Make take from ${done}/${real.length} frames`}
                      </button>
                    )
                  )}

                  {!edit && swap.people.length > 0 && (
                    <div className="space-y-1.5">
                      <span className="text-muted text-[12px]">Also swap in this shot</span>
                      <div className="flex flex-wrap gap-1.5">
                        {swap.people.map((x) => (
                          <button
                            key={x.index}
                            onClick={() => swap.onTogglePerson(x.index)}
                            title={x.label}
                            className={`inline-flex items-center gap-1.5 h-7 pl-1 pr-2 rounded-full ring-1 text-[11px] ${x.on ? "ring-white bg-white/10" : "ring-hair opacity-50"}`}
                          >
                            {x.thumb ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={x.thumb} alt="" className="w-5 h-5 rounded-full object-cover" />
                            ) : null}
                            <span className="max-w-32 truncate">{x.label.replace(/^(a|an|the) /i, "")}</span>
                            {x.on ? "✓" : ""}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <details className="group">
                    <summary className="cursor-pointer text-[12px] text-muted list-none flex items-center justify-between">
                      <span>Prompt{swap.allEdited ? " · edited" : ""}</span>
                      <span className="group-open:rotate-90 transition-transform">›</span>
                    </summary>
                    <div className="space-y-2 pt-2">
                      <p className="text-faint text-[11px] leading-relaxed">
                        {(edit ? ["this frame"] : swap.images).map((x, k) => `Image ${k + 1} = ${x}`).join(" · ")}
                      </p>
                      <div className="flex items-center justify-between text-[11px] text-muted">
                        <span>All frames</span>
                        {swap.allEdited && (
                          <button className="text-faint hover:text-ink" onClick={() => swap.onEditAll(null)}>Reset</button>
                        )}
                      </div>
                      <textarea
                        className="w-full min-h-32 rounded-lg bg-black/40 ring-1 ring-hair p-2 text-[12px] leading-relaxed"
                        value={swap.allPrompt}
                        onChange={(e) => swap.onEditAll(e.target.value)}
                      />
                      {cur.piece >= 0 && (
                        <>
                          <label className="flex items-center gap-2 text-[11px] text-muted">
                            <input
                              type="checkbox"
                              checked={swap.frameEdited(sel)}
                              onChange={(e) => swap.onEditFrame(sel, e.target.checked ? swap.promptFor(sel) : null)}
                            />
                            Own prompt for frame {sel}
                          </label>
                          {swap.frameEdited(sel) && (
                            <textarea
                              className="w-full min-h-24 rounded-lg bg-black/40 ring-1 ring-hair p-2 text-[12px] leading-relaxed"
                              value={swap.promptFor(sel)}
                              onChange={(e) => swap.onEditFrame(sel, e.target.value)}
                            />
                          )}
                        </>
                      )}
                    </div>
                  </details>
                </div>
              );
            })()}
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
                    onClick={(e) => pick(f, e)}
                    className={`relative w-[88px] aspect-video rounded overflow-hidden bg-white/[0.04] ${f === sel ? "ring-2 ring-white" : picked.has(f) ? "ring-2 ring-[#7dd3fc]" : "ring-1 ring-white/10 hover:ring-white/40"}`}
                    title={`Clip frame ${f}`}
                  >
                    {(swap && showSwapped && swap.frames[f] ? swap.frames[f] : thumbs[f]) && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={swap && showSwapped && swap.frames[f] ? swap.frames[f] : thumbs[f]} alt="" className="absolute inset-0 w-full h-full object-cover" />
                    )}
                    {swap?.frames[f] && <span className="absolute right-1 top-1 w-2 h-2 rounded-full bg-[#86efac]" title="Swapped" />}
                    {swap?.errors[f] && !swap.frames[f] && <span className="absolute right-1 top-1 w-2 h-2 rounded-full bg-[#fca5a5]" title={swap.errors[f]} />}
                    {swap?.busy.has(f) && <span className="absolute inset-0 grid place-items-center bg-black/50 text-[10px]">…</span>}
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
