"use client";

import { useEffect, useRef, useState } from "react";
import { CHECKOUT, PRICES, SECONDS_PER_VIDEO } from "./pricing";

type Photo = { id: string; file: File; url: string };

// Where a pasted link comes from, for a calm confirmation under the field.
function sourceOf(link: string): string | null {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.replace(/^www\./, "");
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(h)) return "YouTube";
  if (/(^|\.)tiktok\.com$/.test(h)) return "TikTok";
  if (/(^|\.)instagram\.com$/.test(h)) return "Instagram";
  if (/(^|\.)vimeo\.com$/.test(h)) return "Vimeo";
  if (/(^|\.)(x|twitter)\.com$/.test(h)) return "X";
  if (/\.(mp4|mov|m4v|webm)$/i.test(u.pathname)) return "Video file";
  return "Link";
}

const fmtLen = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// The tool on the landing page: a video, photos of who goes in, who to replace.
// Generate opens the paywall; nothing is uploaded before checkout.
export function Recast() {
  const [mode, setMode] = useState<"link" | "file">("link");
  const [link, setLink] = useState("");
  const [file, setFile] = useState<{ file: File; seconds: number | null } | null>(null);
  const [who, setWho] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [dragging, setDragging] = useState<"video" | "photos" | null>(null);
  const [tried, setTried] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);

  const source = sourceOf(link);
  const hasVideo = mode === "link" ? !!source : !!file;
  const ready = hasVideo && photos.length > 0 && who.trim().length > 1;
  const videos = mode === "file" && file?.seconds ? Math.max(1, Math.ceil(file.seconds / SECONDS_PER_VIDEO)) : 1;

  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.url)), [photos]);

  const addPhotos = (files: FileList | File[]) => {
    const next = [...files].filter((f) => f.type.startsWith("image/")).slice(0, 4 - photos.length);
    setPhotos((cur) => [...cur, ...next.map((f) => ({ id: `${f.name}-${f.size}-${Math.random()}`, file: f, url: URL.createObjectURL(f) }))]);
  };
  const pickVideo = (f: File | undefined) => {
    if (!f || !f.type.startsWith("video/")) return;
    const v = document.createElement("video");
    const u = URL.createObjectURL(f);
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      setFile({ file: f, seconds: isFinite(v.duration) ? v.duration : null });
      URL.revokeObjectURL(u);
    };
    v.onerror = () => {
      setFile({ file: f, seconds: null });
      URL.revokeObjectURL(u);
    };
    v.src = u;
  };

  // Paste a photo anywhere on the page while the tool is in view.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.target.type === "text") return;
      const imgs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (imgs.length) addPhotos(imgs);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const generate = () => {
    setTried(true);
    if (ready) dialog.current?.showModal();
  };

  return (
    <div className="glass-panel rounded-[28px] p-5 sm:p-7">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-[20px] tracking-[-0.015em]">Your video</h2>
        <div className="seg-quiet" role="tablist" aria-label="Video source">
          <button role="tab" aria-selected={mode === "link"} className={mode === "link" ? "on" : ""} onClick={() => setMode("link")}>
            Link
          </button>
          <button role="tab" aria-selected={mode === "file"} className={mode === "file" ? "on" : ""} onClick={() => setMode("file")}>
            File
          </button>
        </div>
      </div>

      {mode === "link" ? (
        <div className="mt-4">
          <label className="sr-only" htmlFor="video-link">Video link</label>
          <input
            id="video-link"
            type="url"
            inputMode="url"
            placeholder="Paste a video link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            className="field-quiet"
          />
          <p className="mt-2 h-5 text-[13px] text-[var(--faint)]">
            {link && !source ? "That doesn’t look like a link yet." : source ? `${source} · length is checked before rendering` : ""}
          </p>
        </div>
      ) : (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => videoInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging("video");
            }}
            onDragLeave={() => setDragging(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(null);
              pickVideo(e.dataTransfer.files[0]);
            }}
            className={`drop-quiet w-full ${dragging === "video" ? "is-over" : ""}`}
          >
            {file ? (
              <span className="flex w-full items-center justify-between gap-4">
                <span className="truncate">{file.file.name}</span>
                <span className="shrink-0 tabular-nums text-[var(--faint)]">{file.seconds ? fmtLen(file.seconds) : ""}</span>
              </span>
            ) : (
              <span className="text-[var(--muted)]">Drop a video here, or choose one</span>
            )}
          </button>
          <input ref={videoInput} type="file" accept="video/*" className="hidden" onChange={(e) => pickVideo(e.target.files?.[0])} />
          <p className="mt-2 h-5 text-[13px] text-[var(--faint)]">
            {file?.seconds ? (videos > 1 ? `${fmtLen(file.seconds)} · counts as ${videos} videos` : `${fmtLen(file.seconds)} · one video`) : ""}
          </p>
        </div>
      )}

      <div className="mt-5">
        <label htmlFor="who" className="text-[14px]">Who should be replaced?</label>
        <input
          id="who"
          type="text"
          placeholder="The man in the white cap, center"
          value={who}
          onChange={(e) => setWho(e.target.value)}
          className="field-quiet mt-2"
        />
      </div>

      <div className="mt-6">
        <div className="flex items-baseline justify-between">
          <span className="text-[14px]">Who goes in</span>
          <span className="text-[13px] tabular-nums text-[var(--faint)]">{photos.length}/4 photos</span>
        </div>
        <div
          className={`mt-2 grid grid-cols-4 gap-2 ${dragging === "photos" ? "photos-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging("photos");
          }}
          onDragLeave={() => setDragging(null)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(null);
            addPhotos(e.dataTransfer.files);
          }}
        >
          {photos.map((p) => (
            <div key={p.id} className="photo-tile group relative aspect-square overflow-hidden rounded-2xl">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                aria-label="Remove photo"
                onClick={() => setPhotos((cur) => cur.filter((x) => x.id !== p.id))}
                className="photo-remove"
              >
                <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden>
                  <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
          {photos.length < 4 && (
            <button type="button" onClick={() => photoInput.current?.click()} className="photo-add aspect-square rounded-2xl" aria-label="Add photos">
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <path d="M8 2.5v11M2.5 8h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        <input ref={photoInput} type="file" accept="image/*" multiple className="hidden" onChange={(e) => e.target.files && addPhotos(e.target.files)} />
        <p className="mt-2 text-[13px] leading-snug text-[var(--faint)]">Clear, front-facing photos of one person. Drop, paste or choose.</p>
      </div>

      <button type="button" onClick={generate} className="btn-solid mt-7 w-full" aria-disabled={!ready}>
        Generate
      </button>
      <p className="mt-3 min-h-5 text-center text-[13px] text-[var(--faint)]">
        {tried && !ready
          ? !hasVideo
            ? "Add a video first."
            : !who.trim()
              ? "Say who should be replaced."
              : "Add at least one photo."
          : `$${PRICES.single.toFixed(2)} per video, or use credits`}
      </p>

      <Paywall ref={dialog} videos={videos} summary={mode === "link" ? source ?? "" : file?.file.name ?? ""} photos={photos} who={who} />
    </div>
  );
}

function Paywall({
  ref,
  videos,
  summary,
  photos,
  who,
}: {
  ref: React.RefObject<HTMLDialogElement | null>;
  videos: number;
  summary: string;
  photos: Photo[];
  who: string;
}) {
  const options = [
    { id: "single", label: videos > 1 ? `${videos} videos` : "This video", price: PRICES.single * videos, note: "One-time" },
    ...PRICES.packs
      .filter((p) => p.credits >= videos)
      .map((p) => ({ id: String(p.credits), label: `${p.credits} credits`, price: p.price, note: `$${(p.price / p.credits).toFixed(2)} a video, uses ${videos}` })),
  ];
  const [pick, setPick] = useState("single");
  const href = CHECKOUT[pick];

  return (
    <dialog
      ref={ref}
      className="paywall"
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      <div className="glass-panel w-[min(92vw,460px)] rounded-[28px] p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <h2 className="font-display text-[22px] tracking-[-0.015em]">Ready to generate</h2>
          <button type="button" aria-label="Close" onClick={() => ref.current?.close()} className="close-quiet">
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <div className="flex -space-x-2">
            {photos.slice(0, 4).map((p) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={p.id} src={p.url} alt="" className="h-9 w-9 rounded-full object-cover ring-2 ring-[var(--bg)]" />
            ))}
          </div>
          <p className="min-w-0 text-[14px] leading-snug text-[var(--muted)]">
            <span className="block truncate text-[var(--text)]">{summary}</span>
            <span className="block truncate">Replacing {who.trim().charAt(0).toLowerCase() + who.trim().slice(1)}</span>
          </p>
        </div>

        <fieldset className="mt-6 space-y-2">
          <legend className="sr-only">Choose how to pay</legend>
          {options.map((o) => (
            <label key={o.id} className={`option-quiet ${pick === o.id ? "is-on" : ""}`}>
              <input type="radio" name="plan" value={o.id} checked={pick === o.id} onChange={() => setPick(o.id)} className="sr-only" />
              <span className="flex-1">
                <span className="block text-[15px]">{o.label}</span>
                <span className="block text-[13px] text-[var(--faint)]">{o.note}</span>
              </span>
              <span className="text-[16px] tabular-nums">${o.price.toFixed(2)}</span>
            </label>
          ))}
        </fieldset>

        {href ? (
          <a href={href} className="btn-solid mt-6 block w-full text-center">
            Continue to payment
          </a>
        ) : (
          <>
            <button type="button" className="btn-solid mt-6 w-full" aria-disabled disabled>
              Checkout opens soon
            </button>
            <p className="mt-3 text-center text-[13px] leading-snug text-[var(--faint)]">
              Payments aren’t switched on yet.
            </p>
          </>
        )}
      </div>
    </dialog>
  );
}
