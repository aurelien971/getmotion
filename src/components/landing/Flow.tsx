"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { checkPhoto, readVideo, type Person, type PhotoCheck, type Progress, type Reading } from "@/lib/cast";
import { useUser } from "@/lib/firebase";
import { MIN_RENDER, priceFor, renderSeconds } from "./pricing";
import { Pay } from "./Pay";
import { openSignIn } from "./SignIn";

// After a video is dropped: read it in the browser, let the visitor pick who to replace,
// add photos of who goes in, and see exactly what it takes. Sign-in only at the end.

type Photo = { id: string; file: File; url: string; check?: PhotoCheck };

export function Flow({ file, onClose }: { file: File; onClose: () => void }) {
  const [progress, setProgress] = useState<Progress>({ stage: "cuts", ratio: 0, label: "Opening the video" });
  const [reading, setReading] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"read" | "pick" | "photos" | "summary" | "pay">("read");
  const [chosen, setChosen] = useState<string[]>([]);
  const [photos, setPhotos] = useState<Record<string, Photo[]>>({});
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    readVideo(file, setProgress, ctrl.signal)
      .then((r) => {
        setReading(r);
        setStep("pick");
        if (r.people.length === 1) setChosen([r.people[0].id]);
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setError(e instanceof Error ? e.message : "Couldn’t read this video.");
      });
    return () => ctrl.abort();
  }, [file]);

  const people = reading?.people ?? [];
  const picked = people.filter((p) => chosen.includes(p.id));
  const ready = picked.length > 0 && picked.every((p) => (photos[p.id] ?? []).some((x) => x.check?.ok));

  return (
    <div className="glass-panel flow-panel w-full rounded-[28px] p-5 sm:p-7">
      <div className="mb-5 flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3 text-[13px] text-[var(--muted)]">
          <span className="truncate">{file.name}</span>
          {reading && <span className="shrink-0 tabular-nums">{Math.round(reading.duration)} s · {reading.shots.length} shots</span>}
        </div>
        <button type="button" onClick={onClose} className="close-quiet shrink-0" aria-label="Start over">
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {error ? (
        <Message title="We couldn’t read this video" body={error} action="Choose another video" onAction={onClose} />
      ) : step === "read" ? (
        <div className="py-6">
          <h2 className="font-display text-[24px] tracking-[-0.02em]">Reading your video</h2>
          <p className="mt-1.5 text-[14px] text-[var(--muted)]">It stays on your device. Nothing is uploaded.</p>
          <div className="flow-track mt-6" aria-hidden>
            <div className="flow-fill" style={{ width: `${(progress.stage === "cuts" ? progress.ratio * 0.35 : 0.35 + progress.ratio * 0.65) * 100}%` }} />
          </div>
          <p className="mt-3 text-[13px] tabular-nums text-[var(--faint)]" aria-live="polite">{progress.label}</p>
        </div>
      ) : step === "pick" ? (
        people.length === 0 ? (
          <Message
            title="No clear faces in this video"
            body="We look for faces big enough to recast. A video where the person faces the camera for a few shots works best."
            action="Choose another video"
            onAction={onClose}
          />
        ) : (
          <>
            <h2 className="font-display text-[24px] tracking-[-0.02em]">Who do you want to replace?</h2>
            <p className="mt-1.5 text-[14px] text-[var(--muted)]">
              {people.length === 1 ? "We found one person." : `We found ${people.length} people.`} Pick one or more.
            </p>
            <ul className="mt-5 grid grid-cols-3 gap-3 sm:grid-cols-4">
              {people.map((p) => {
                const on = chosen.includes(p.id);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setChosen((c) => (on ? c.filter((x) => x !== p.id) : [...c, p.id]))}
                      className={`face-card ${on ? "is-on" : ""}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.face} alt="" className="aspect-square w-full rounded-[14px] object-cover" />
                      <span className="mt-2 block text-[12px] leading-tight tabular-nums text-[var(--muted)]">
                        {p.shots.length} {p.shots.length === 1 ? "shot" : "shots"} · {Math.round(p.seconds)} s
                      </span>
                      {on && <span className="face-check" aria-hidden>✓</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            <Footer
              back="Start over"
              onBack={onClose}
              next="Next"
              disabled={!chosen.length}
              onNext={() => {
                setCurrent(chosen[0]);
                setStep("photos");
              }}
            />
          </>
        )
      ) : step === "photos" ? (
        <Photos
          people={picked}
          current={current ?? picked[0].id}
          setCurrent={setCurrent}
          photos={photos}
          setPhotos={setPhotos}
          footer={<Footer back="Back" onBack={() => setStep("pick")} next="Next" disabled={!ready} onNext={() => setStep("summary")} />}
        />
      ) : step === "summary" ? (
        <Summary reading={reading!} people={picked} photos={photos} onBack={() => setStep("photos")} onPay={() => setStep("pay")} />
      ) : (
        <Pay file={file} reading={reading!} people={picked} photos={photos} onBack={() => setStep("summary")} />
      )}
    </div>
  );
}

function Photos({
  people,
  current,
  setCurrent,
  photos,
  setPhotos,
  footer,
}: {
  people: Person[];
  current: string;
  setCurrent: (id: string) => void;
  photos: Record<string, Photo[]>;
  setPhotos: React.Dispatch<React.SetStateAction<Record<string, Photo[]>>>;
  footer: React.ReactNode;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const list = photos[current] ?? [];
  const person = people.find((p) => p.id === current) ?? people[0];

  const add = async (files: File[]) => {
    const who = person.id;
    const room = 4 - (photos[who]?.length ?? 0);
    const fresh = files.filter((f) => f.type.startsWith("image/")).slice(0, room).map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }));
    if (!fresh.length) return;
    setPhotos((p) => ({ ...p, [who]: [...(p[who] ?? []), ...fresh] }));
    // Check in order, so each new photo is compared with the first good one.
    let first = (photos[who] ?? []).find((x) => x.check?.ok)?.check?.descriptor;
    for (const ph of fresh) {
      const check: PhotoCheck = await checkPhoto(ph.file, first).catch(() => ({ ok: false, note: "Couldn’t open this image" }));
      first ??= check.ok ? check.descriptor : undefined;
      setPhotos((p) => ({ ...p, [who]: (p[who] ?? []).map((x) => (x.id === ph.id ? { ...x, check } : x)) }));
    }
  };

  return (
    <>
      <h2 className="font-display text-[24px] tracking-[-0.02em]">Who goes in?</h2>
      <p className="mt-1.5 text-[14px] text-[var(--muted)]">1 to 4 photos of the same person. Face toward the camera, even light.</p>

      {people.length > 1 && (
        <div className="mt-5 flex gap-2">
          {people.map((p) => {
            const done = (photos[p.id] ?? []).some((x) => x.check?.ok);
            return (
              <button key={p.id} type="button" onClick={() => setCurrent(p.id)} className={`person-tab ${p.id === current ? "is-on" : ""}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.face} alt="" className="h-8 w-8 rounded-full object-cover" />
                <span className="text-[13px]">{done ? "Photos added" : "Needs photos"}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-5 grid grid-cols-[72px_minmax(0,1fr)] items-start gap-4">
        <div className="text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={person.face} alt="" className="aspect-square w-full rounded-[14px] object-cover opacity-80" />
          <span className="mt-1.5 block text-[11px] text-[var(--faint)]">replacing</span>
        </div>
        <div
          className={`photo-drop ${over ? "is-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            add([...e.dataTransfer.files]);
          }}
        >
          <input ref={picker} type="file" accept="image/*" multiple className="hidden" onChange={(e) => (add([...(e.target.files ?? [])]), (e.target.value = ""))} />
          <ul className="grid grid-cols-4 gap-2.5">
            {list.map((ph) => (
              <li key={ph.id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={ph.url} alt="" className={`aspect-square w-full rounded-[12px] object-cover ${ph.check && !ph.check.ok ? "opacity-40" : ""}`} />
                <button
                  type="button"
                  aria-label="Remove photo"
                  onClick={() => setPhotos((p) => ({ ...p, [person.id]: (p[person.id] ?? []).filter((x) => x.id !== ph.id) }))}
                  className="photo-remove"
                >
                  ×
                </button>
                <span className={`mt-1 block truncate text-[11px] ${!ph.check ? "text-[var(--faint)]" : ph.check.ok ? "text-[var(--muted)]" : "text-[var(--accent)]"}`} title={ph.check?.note}>
                  {ph.check?.note ?? "Checking…"}
                </span>
              </li>
            ))}
            {list.length < 4 && (
              <li>
                <button type="button" onClick={() => picker.current?.click()} className="photo-add aspect-square w-full" aria-label="Add photos">
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                    <path d="M8 2.5v11M2.5 8h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
                {!list.length && <span className="mt-1 block text-[11px] text-[var(--faint)]">or drop here</span>}
              </li>
            )}
          </ul>
        </div>
      </div>
      {footer}
    </>
  );
}

function Summary({ reading, people, photos, onBack, onPay }: { reading: Reading; people: Person[]; photos: Record<string, Photo[]>; onBack: () => void; onPay: () => void }) {
  const user = useUser();
  const { shots, onScreen, render } = useMemo(() => {
    const set = [...new Set(people.flatMap((p) => p.shots))].sort((a, b) => a - b);
    const lens = set.map((s) => reading.shots[s].end - reading.shots[s].start);
    return { shots: set.length, onScreen: lens.reduce((a, b) => a + b, 0), render: renderSeconds(lens) };
  }, [reading, people]);
  const price = priceFor(render);
  const rows: [string, string][] = [
    ["Shots to recast", `${shots} of ${reading.shots.length}`],
    ["On screen", `${Math.round(onScreen)} s`],
    ["Rendered", `${render} s`],
  ];

  return (
    <>
      <h2 className="font-display text-[24px] tracking-[-0.02em]">Ready to recast</h2>
      <div className="mt-4 flex items-center gap-2">
        {people.map((p) => (
          <span key={p.id} className="flex items-center gap-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.face} alt="" className="h-9 w-9 rounded-full object-cover" />
            <span className="text-[var(--faint)]" aria-hidden>→</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={(photos[p.id] ?? []).find((x) => x.check?.ok)?.url} alt="" className="h-9 w-9 rounded-full object-cover ring-1 ring-[var(--accent)]" />
          </span>
        ))}
      </div>
      <dl className="mt-5 divide-y divide-[var(--hair)] text-[15px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between py-2.5">
            <dt className="text-[var(--muted)]">{k}</dt>
            <dd className="tabular-nums">{v}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between py-3">
          <dt>Price</dt>
          <dd className="font-display text-[26px] tabular-nums">${price}</dd>
        </div>
      </dl>
      <p className="mt-1 text-[13px] leading-snug text-[var(--faint)]">
        Each shot is rendered on its own, at least {MIN_RENDER} s, so the face never jumps at a cut. The sound stays as it was. A failed render is
        redone or refunded.
      </p>
      <Footer
        back="Back"
        onBack={onBack}
        next={user ? `Pay $${price}` : "Sign in to continue"}
        disabled={user === undefined}
        onNext={() => (user ? onPay() : openSignIn())}
      />
    </>
  );
}

function Footer({ back, onBack, next, onNext, disabled }: { back: string; onBack: () => void; next: string; onNext: () => void; disabled?: boolean }) {
  return (
    <div className="mt-6 flex items-center justify-between gap-3">
      <button type="button" onClick={onBack} className="navlink -ml-3 text-[14px]">
        {back}
      </button>
      <button type="button" onClick={onNext} disabled={disabled} className="btn-solid px-6">
        {!disabled && <span className="ready-dot" aria-hidden />}
        {next}
      </button>
    </div>
  );
}

function Message({ title, body, action, onAction }: { title: string; body: string; action: string; onAction: () => void }) {
  return (
    <div className="py-4">
      <h2 className="font-display text-[22px] tracking-[-0.02em]">{title}</h2>
      <p className="mt-2 max-w-[480px] text-[15px] leading-relaxed text-[var(--muted)]">{body}</p>
      <button type="button" onClick={onAction} className="btn-solid mt-6 px-6">
        {action}
      </button>
    </div>
  );
}
