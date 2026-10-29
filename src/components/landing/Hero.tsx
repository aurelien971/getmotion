"use client";

import { useState } from "react";
import OneGlossyLiquid from "@/components/originkit/one-glossy-liquid";
import { Flow } from "./Flow";
import { Recast } from "./Recast";

// First screen: the gradient and the glossy liquid, the headline above it and the bar below.
// Dropping or choosing a video swaps both for the flow panel, which reads it right away.
export function Hero() {
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);

  return (
    <section
      className="hero relative h-[100svh] min-h-[620px] overflow-hidden"
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("video/"));
        if (f) setFile(f);
      }}
    >
      {/* The gradient photo is the background; the liquid is drawn on black and screen-
          blended, so the black drops out and only the shape lights up over it. */}
      <div className="hero-bg absolute inset-0" aria-hidden />
      <div className={`absolute inset-0 mix-blend-screen transition-opacity duration-500 ${file ? "opacity-25" : ""}`}>
        {/* Originkit's preview look, passed explicitly: the component falls back to other
            values (size 560, glow 60) when these props are left out. */}
        <OneGlossyLiquid
          background="#000000"
          size={240}
          glow={0}
          lobes={5}
          wobble={50}
          speed={50}
          hover={100}
          advanced={{ offsetY: 5 }}
          style={{ minWidth: 0, minHeight: 0 }}
        />
      </div>

      {file ? (
        <div className="absolute inset-0 z-[1] flex items-center justify-center overflow-y-auto px-4 pt-20 pb-8">
          <div className="w-[min(680px,100%)]">
            <Flow key={`${file.name}-${file.size}-${file.lastModified}`} file={file} onClose={() => setFile(null)} />
          </div>
        </div>
      ) : (
        <>
          <div className="pointer-events-none absolute inset-x-0 z-[1] bottom-[calc(45%+var(--r)+40px)] px-5 text-center">
            <h1 className="hero-text font-display text-[34px] leading-[1.05] tracking-[-0.03em] sm:text-[52px]">Put someone new in any video.</h1>
            <p className="hero-text hero-sub mx-auto mt-3 max-w-[460px] text-[15px] leading-relaxed sm:text-[16px]">
              Same moves, same camera, same light. The sound stays exactly as it was.
            </p>
          </div>

          <div className="absolute inset-x-0 z-[1] top-[calc(55%+var(--r)+40px)] mx-auto w-[min(640px,calc(100%-32px))]">
            <Recast file={file} onFile={setFile} />
          </div>
        </>
      )}

      {over && !file && (
        <div className="pointer-events-none absolute inset-4 grid place-items-center rounded-[32px] border border-dashed border-[rgba(232,180,100,0.6)] bg-[rgba(14,13,12,0.35)]">
          <span className="text-[15px]">Drop the video</span>
        </div>
      )}
    </section>
  );
}
