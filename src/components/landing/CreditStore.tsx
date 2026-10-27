"use client";

import { useState } from "react";
import { CHECKOUT, PACKS, creditsFor, packFor } from "./pricing";

const PACES = [
  { id: "fast", label: "Quick cuts", note: "music videos", shot: 2.5 },
  { id: "normal", label: "Normal", note: "most clips", shot: 5 },
  { id: "long", label: "Long takes", note: "one camera", shot: 12 },
] as const;

const fmtLen = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`);

// Credits, explained by doing: say how much video and how it's cut, see what it uses and
// which pack covers it.
export function CreditStore() {
  const [seconds, setSeconds] = useState(15);
  const [pace, setPace] = useState<(typeof PACES)[number]["id"]>("fast");
  const shot = PACES.find((p) => p.id === pace)!.shot;
  const credits = creditsFor(seconds, shot);
  const best = packFor(credits);

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-14">
      <div>
        <label htmlFor="length" className="flex items-baseline justify-between text-[15px]">
          <span>How much video?</span>
          <span className="font-display text-[22px] tracking-[-0.02em]">{fmtLen(seconds)}</span>
        </label>
        <input
          id="length"
          type="range"
          min={5}
          max={180}
          step={5}
          value={seconds}
          onChange={(e) => setSeconds(+e.target.value)}
          className="range-quiet mt-4 w-full"
        />
        <div className="mt-6 text-[15px]">How is it cut?</div>
        <div className="mt-2 grid grid-cols-3 gap-2" role="radiogroup" aria-label="How the video is cut">
          {PACES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={pace === p.id}
              onClick={() => setPace(p.id)}
              className={`pace-quiet ${pace === p.id ? "is-on" : ""}`}
            >
              <span className="block text-[14px]">{p.label}</span>
              <span className="block text-[12px] text-[var(--faint)]">{p.note}</span>
            </button>
          ))}
        </div>
        <p className="mt-6 text-[15px] leading-relaxed text-[var(--muted)]">
          That uses about <span className="text-[var(--text)] tabular-nums">{credits} credits</span>. Every shot is rendered on its own, so
          quick cuts use more. You see the exact number before anything renders.
        </p>
      </div>

      <div>
        <ul className="space-y-2.5">
          {PACKS.map((p) => {
            const on = p.credits === best.credits;
            const href = CHECKOUT[p.credits];
            return (
              <li key={p.credits} className={`pack-quiet ${on ? "is-on" : ""}`}>
                <span className="flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-[17px] tabular-nums">{p.credits} credits</span>
                    {on && <span className="text-[12px] text-[var(--accent)]">covers it</span>}
                  </span>
                  <span className="block text-[13px] text-[var(--faint)]">
                    {p.note} · ${(p.price / p.credits).toFixed(2)} a credit
                  </span>
                </span>
                <span className="font-display text-[22px] tracking-[-0.02em]">${p.price}</span>
                {href ? (
                  <a href={href} className="pack-buy">Buy</a>
                ) : (
                  <span className="pack-buy is-off" title="Opens with sign-in">Soon</span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-[13px] leading-relaxed text-[var(--faint)]">
          1 credit is one second of rendering. A failed render gives its credits back.
        </p>
      </div>
    </div>
  );
}
