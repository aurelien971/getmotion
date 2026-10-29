"use client";

import { useRef, useState } from "react";
import { openSignIn } from "./SignIn";

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

// The search-bar step on the hero: paste a link or drop a video (the hero passes drops
// in), then → asks the visitor to sign in. Photos and who to replace come after.
export function Recast({ file, onFile }: { file: File | null; onFile: (f: File | null) => void }) {
  const [link, setLink] = useState("");
  const [tried, setTried] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const source = file ? "Video file" : sourceOf(link);

  const next = () => {
    setTried(true);
    if (source) openSignIn(file ? "video" : `${source} link`);
  };

  return (
    <div>
      <form
        className="search-bar flex items-center gap-1.5 rounded-[26px] p-2 pl-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          next();
        }}
      >
        <button type="button" onClick={() => picker.current?.click()} className="bar-icon" aria-label="Choose a video file">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path d="M8 2.5v11M2.5 8h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <input ref={picker} type="file" accept="video/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
        <label htmlFor="video-link" className="sr-only">
          Video link
        </label>
        {file ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-[15px]">
            <span className="truncate">{file.name}</span>
            <button type="button" onClick={() => onFile(null)} className="shrink-0 text-[13px] text-[var(--faint)] hover:text-[var(--text)]">
              Remove
            </button>
          </span>
        ) : (
          <input
            id="video-link"
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="Paste a link or drop a video"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            className="bar-input min-w-0 flex-1"
          />
        )}
        <button type="submit" className={`bar-go ${source ? "is-ready" : ""}`} aria-label="Next" aria-disabled={!source}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </button>
      </form>
      <p className="hero-text mt-3 min-h-5 text-center text-[13px]">
        {!file && link && !source
          ? "That doesn’t look like a link yet."
          : source
            ? `${source} · next, you’ll add photos of who goes in`
            : tried
              ? "Paste a link or drop a video first."
              : "YouTube, TikTok, Instagram, or a video file."}
      </p>
    </div>
  );
}
