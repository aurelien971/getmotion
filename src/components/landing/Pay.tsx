"use client";

import { useEffect, useMemo, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import type { Person, Reading } from "@/lib/cast";
import { authHeader, upload, useUser } from "@/lib/firebase";

// Last step: upload the video and photos into the visitor's own folder, create the order,
// then pay with Stripe Checkout embedded in the panel, so nothing on the page is lost.

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "");
type Photo = { file: File; check?: { ok: boolean } };

const ext = (f: File, fallback: string) => (f.name.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? fallback).toLowerCase();
const dataUrlBlob = (u: string) => fetch(u).then((r) => r.blob());

export function Pay({
  file,
  reading,
  people,
  photos,
  onBack,
}: {
  file: File;
  reading: Reading;
  people: Person[];
  photos: Record<string, Photo[]>;
  onBack: () => void;
}) {
  const user = useUser();
  const orderId = useMemo(() => crypto.randomUUID(), []);
  const [sent, setSent] = useState(0);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);

  // Everything to upload, with its size, so progress is one honest bar.
  const items = useMemo(() => {
    if (!user) return [];
    const root = `users/${user.uid}/orders/${orderId}`;
    return [
      { path: `${root}/video${ext(file, ".mp4")}`, data: file as Blob },
      ...people.flatMap((p) =>
        (photos[p.id] ?? [])
          .filter((x) => x.check?.ok)
          .map((x, i) => ({ path: `${root}/photos/${p.id}-${i + 1}${ext(x.file, ".jpg")}`, data: x.file as Blob })),
      ),
    ];
  }, [user, orderId, file, people, photos]);
  const total = items.reduce((t, x) => t + x.data.size, 0);

  useEffect(() => {
    if (!user || !items.length) return;
    let stop = false;
    (async () => {
      try {
        const done = new Map<string, number>();
        const tick = () => !stop && setSent([...done.values()].reduce((a, b) => a + b, 0));
        await Promise.all(items.map((x) => upload(x.path, x.data, (n) => (done.set(x.path, n), tick()))));
        const root = `users/${user.uid}/orders/${orderId}`;
        const faces = await Promise.all(people.map(async (p) => upload(`${root}/faces/${p.id}.jpg`, await dataUrlBlob(p.face), () => {})));
        if (stop) return;
        const res = await fetch("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await authHeader()) },
          body: JSON.stringify({
            orderId,
            video: { path: items[0].path, name: file.name, size: file.size, duration: reading.duration, width: reading.width, height: reading.height },
            shots: reading.shots,
            people: people.map((p, i) => ({
              id: p.id,
              shots: p.shots,
              face: faces[i],
              photos: items.filter((x) => x.path.includes(`/photos/${p.id}-`)).map((x) => x.path),
            })),
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Checkout didn’t open.");
        if (!stop) setSecret(json.clientSecret);
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : "Upload failed. Check your connection and try again.");
      }
    })();
    return () => {
      stop = true;
    };
  }, [user, items, orderId, file, people, reading]);

  const complete = async () => {
    const res = await fetch("/api/order/confirm", { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeader()) }, body: JSON.stringify({ orderId }) });
    const json = await res.json().catch(() => ({}));
    setPaid(json.status === "paid");
    if (json.status !== "paid") setError("Payment went through, but we couldn’t confirm it yet. It will show up in a minute, nothing more to do.");
  };

  if (paid)
    return (
      <div className="py-4">
        <h2 className="font-display text-[24px] tracking-[-0.02em]">Your order is in</h2>
        <p className="mt-2 max-w-[480px] text-[15px] leading-relaxed text-[var(--muted)]">
          Thank you. We’re recasting it now and will email <span className="text-[var(--text)]">{user?.email}</span> when it’s ready. Order{" "}
          <span className="tabular-nums">{orderId.slice(0, 8)}</span>.
        </p>
      </div>
    );

  if (error)
    return (
      <div className="py-4">
        <h2 className="font-display text-[22px] tracking-[-0.02em]">Something got in the way</h2>
        <p className="mt-2 max-w-[480px] text-[15px] leading-relaxed text-[var(--muted)]">{error}</p>
        <button type="button" onClick={onBack} className="btn-solid mt-6 px-6">
          Back
        </button>
      </div>
    );

  if (!secret)
    return (
      <div className="py-6">
        <h2 className="font-display text-[24px] tracking-[-0.02em]">Uploading</h2>
        <p className="mt-1.5 text-[14px] text-[var(--muted)]">Your video and photos go to your private folder. Payment opens right after.</p>
        <div className="flow-track mt-6" aria-hidden>
          <div className="flow-fill" style={{ width: `${total ? (sent / total) * 100 : 0}%` }} />
        </div>
        <p className="mt-3 text-[13px] tabular-nums text-[var(--faint)]" aria-live="polite">
          {total ? `${(sent / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB` : "Starting"}
          {sent >= total && total ? " · opening payment" : ""}
        </p>
      </div>
    );

  return (
    <div>
      <div className="checkout-frame overflow-hidden rounded-[18px]">
        <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret: secret, onComplete: complete }}>
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </div>
      <button type="button" onClick={onBack} className="navlink -ml-3 mt-4 text-[14px]">
        Back
      </button>
    </div>
  );
}
