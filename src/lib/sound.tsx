"use client";

import { useSyncExternalStore } from "react";

// One sound switch shared by every preview player, remembered across reloads.
const KEY = "getmotion.sound";
const subs = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSound(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {}
  subs.forEach((f) => f());
}

export function useSound(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    read,
    () => true,
  );
  return [on, setSound];
}

export function SoundButton({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button className="btn btn-icon" onClick={() => onChange(!on)} aria-label={on ? "Mute" : "Unmute"} title={on ? "Sound on" : "Sound off"}>
      {on ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M2 6h3l4-3v10l-4-3H2z" />
          <path d="M11 5.5a3.5 3.5 0 0 1 0 5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          <path d="M12.8 3.5a6 6 0 0 1 0 9" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M2 6h3l4-3v10l-4-3H2z" />
          <path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
