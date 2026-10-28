"use client";

import { useRef, useState } from "react";

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
// in), then → asks the visitor to sign in. Photos, who to replace and the exact credit
// count come after.
export function Recast({ file, onFile }: { file: File | null; onFile: (f: File | null) => void }) {
  const [link, setLink] = useState("");
  const [tried, setTried] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const source = file ? "Video file" : sourceOf(link);

  const next = () => {
    setTried(true);
    if (source) dialog.current?.showModal();
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
              : "YouTube, TikTok, Instagram, or a file. You see the exact credits before anything renders."}
      </p>

      <SignIn ref={dialog} source={source ?? ""} />
    </div>
  );
}

function SignIn({ ref, source }: { ref: React.RefObject<HTMLDialogElement | null>; source: string }) {
  return (
    <dialog
      ref={ref}
      className="paywall"
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      <div className="glass-panel w-[min(92vw,420px)] rounded-[28px] p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-[22px] tracking-[-0.015em]">Sign in to continue</h2>
            <p className="mt-1 text-[14px] text-[var(--muted)]">Your {source ? `${source} ` : ""}link is saved for the next step.</p>
          </div>
          <button type="button" aria-label="Close" onClick={() => ref.current?.close()} className="close-quiet">
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="mt-6 space-y-2.5">
          <button type="button" className="auth-btn" disabled>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81z" />
              <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.1A12 12 0 0 0 12 24z" />
              <path fill="#FBBC05" d="M5.29 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.28a12 12 0 0 0 0 10.78l4.01-3.1z" />
              <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.28 6.61l4.01 3.1C6.23 6.86 8.88 4.75 12 4.75z" />
            </svg>
            Continue with Google
          </button>
          <button type="button" className="auth-btn" disabled>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path
                fill="currentColor"
                d="M16.37 12.73c-.03-2.6 2.12-3.85 2.22-3.91-1.21-1.77-3.09-2.01-3.76-2.04-1.6-.16-3.12.94-3.93.94-.81 0-2.06-.92-3.39-.89-1.74.03-3.35 1.01-4.25 2.57-1.81 3.14-.46 7.79 1.3 10.34.86 1.25 1.89 2.65 3.24 2.6 1.3-.05 1.79-.84 3.36-.84 1.57 0 2.01.84 3.38.81 1.4-.02 2.29-1.27 3.14-2.53.99-1.45 1.4-2.86 1.42-2.93-.03-.01-2.72-1.04-2.73-4.12zM13.79 5.11c.72-.87 1.2-2.07 1.07-3.27-1.03.04-2.28.69-3.02 1.55-.66.76-1.24 1.99-1.09 3.16 1.15.09 2.32-.58 3.04-1.44z"
              />
            </svg>
            Continue with Apple
          </button>
        </div>
        <p className="mt-4 text-center text-[13px] leading-snug text-[var(--faint)]">
          Sign-in opens soon. After it: add photos of who goes in, and see the exact credits before anything renders.
        </p>
      </div>
    </dialog>
  );
}
