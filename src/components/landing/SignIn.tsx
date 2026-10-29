"use client";

import { useEffect, useRef, useState } from "react";
import { authMessage, signIn, signOutUser, useUser, type Provider } from "@/lib/firebase";

// One sign-in dialog for the page. The header and the search bar open it with
// openSignIn(), optionally saying what the visitor brought ("YouTube link").
const EVENT = "getmotion:signin";
export const openSignIn = (source?: string) => window.dispatchEvent(new CustomEvent(EVENT, { detail: source ?? "" }));

export function SignIn() {
  const ref = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const user = useUser();

  useEffect(() => {
    const open = (e: Event) => {
      setSource((e as CustomEvent<string>).detail);
      setError(null);
      ref.current?.showModal();
    };
    window.addEventListener(EVENT, open);
    return () => window.removeEventListener(EVENT, open);
  }, []);

  const go = async (p: Provider) => {
    setBusy(p);
    setError(null);
    try {
      await signIn(p);
    } catch (e) {
      setError(authMessage(e));
    } finally {
      setBusy(null);
    }
  };

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
          <div className="min-w-0">
            <h2 className="font-display text-[22px] tracking-[-0.015em]">{user ? "You’re signed in" : "Sign in to continue"}</h2>
            <p className="mt-1 truncate text-[14px] text-[var(--muted)]">
              {user ? (user.email ?? user.displayName) : source ? `Your ${source} is saved for the next step.` : "With Google or Apple. No password."}
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={() => ref.current?.close()} className="close-quiet">
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {user ? (
          <>
            <p className="mt-6 text-[15px] leading-relaxed">
              {source ? "Next you add photos of who goes in. That step opens very soon, and we’ll keep your link for it." : "Paste a link or drop a video on the page to start."}
            </p>
            <div className="mt-5 flex items-center justify-between gap-3">
              <button type="button" className="btn-solid px-6" onClick={() => ref.current?.close()}>
                Done
              </button>
              <button type="button" className="text-[13px] text-[var(--faint)] hover:text-[var(--text)]" onClick={() => signOutUser()}>
                Sign out
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mt-6 space-y-2.5">
              <button type="button" className="auth-btn" disabled={!!busy || user === undefined} onClick={() => go("google")}>
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                  <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81z" />
                  <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.1A12 12 0 0 0 12 24z" />
                  <path fill="#FBBC05" d="M5.29 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.28a12 12 0 0 0 0 10.78l4.01-3.1z" />
                  <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.28 6.61l4.01 3.1C6.23 6.86 8.88 4.75 12 4.75z" />
                </svg>
                {busy === "google" ? "Opening Google…" : "Continue with Google"}
              </button>
              <button type="button" className="auth-btn" disabled={!!busy || user === undefined} onClick={() => go("apple")}>
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M16.37 12.73c-.03-2.6 2.12-3.85 2.22-3.91-1.21-1.77-3.09-2.01-3.76-2.04-1.6-.16-3.12.94-3.93.94-.81 0-2.06-.92-3.39-.89-1.74.03-3.35 1.01-4.25 2.57-1.81 3.14-.46 7.79 1.3 10.34.86 1.25 1.89 2.65 3.24 2.6 1.3-.05 1.79-.84 3.36-.84 1.57 0 2.01.84 3.38.81 1.4-.02 2.29-1.27 3.14-2.53.99-1.45 1.4-2.86 1.42-2.93-.03-.01-2.72-1.04-2.73-4.12zM13.79 5.11c.72-.87 1.2-2.07 1.07-3.27-1.03.04-2.28.69-3.02 1.55-.66.76-1.24 1.99-1.09 3.16 1.15.09 2.32-.58 3.04-1.44z"
                  />
                </svg>
                {busy === "apple" ? "Opening Apple…" : "Continue with Apple"}
              </button>
            </div>
            <p className={`mt-4 min-h-5 text-center text-[13px] leading-snug ${error ? "text-[var(--accent)]" : "text-[var(--faint)]"}`}>
              {error ?? "We only use your name and email to keep your videos together."}
            </p>
          </>
        )}
      </div>
    </dialog>
  );
}

// Header control: "Sign in", or the visitor's initial once they are.
export function AccountButton() {
  const user = useUser();
  if (user === undefined) return <span className="w-[68px]" aria-hidden />;
  if (!user)
    return (
      <button type="button" onClick={() => openSignIn()} className="navlink">
        Sign in
      </button>
    );
  const initial = (user.displayName ?? user.email ?? "?").trim()[0]?.toUpperCase();
  return (
    <button type="button" onClick={() => openSignIn()} aria-label="Your account" className="account-dot ml-1">
      {user.photoURL ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.photoURL} alt="" width={30} height={30} referrerPolicy="no-referrer" className="h-full w-full rounded-full object-cover" />
      ) : (
        initial
      )}
    </button>
  );
}
