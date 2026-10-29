import { NextResponse } from "next/server";
import { bucket, db, stripe, userFrom } from "@/lib/admin";
import { priceFor, renderSeconds } from "@/components/landing/pricing";

// Creates the order (files already uploaded by the visitor to their own folder) and an
// embedded Stripe Checkout session for it. The price is worked out here, from the shots.
type Body = {
  orderId: string;
  video: { path: string; name: string; size: number; duration: number; width: number; height: number };
  shots: { start: number; end: number }[];
  people: { id: string; shots: number[]; face: string; photos: string[] }[];
};

export async function POST(req: Request) {
  const user = await userFrom(req);
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const b = (await req.json()) as Body;
  const root = `users/${user.uid}/orders/${b.orderId}/`;
  const paths = [b.video?.path, ...(b.people ?? []).flatMap((p) => [p.face, ...p.photos])];
  if (!/^[\w-]{8,64}$/.test(b.orderId ?? "") || !b.people?.length || paths.some((p) => typeof p !== "string" || !p.startsWith(root)))
    return NextResponse.json({ error: "That order doesn’t look right." }, { status: 400 });
  const exists = await Promise.all(paths.map((p) => bucket().file(p).exists().then(([e]) => e)));
  if (exists.includes(false)) return NextResponse.json({ error: "Some files didn’t finish uploading. Try again." }, { status: 400 });

  const chosen = [...new Set(b.people.flatMap((p) => p.shots))].filter((s) => b.shots[s]);
  const lengths = chosen.map((s) => Math.max(0, b.shots[s].end - b.shots[s].start));
  const render = renderSeconds(lengths);
  const price = priceFor(render);
  const origin = new URL(req.url).origin;

  const session = await stripe().checkout.sessions.create({
    ui_mode: "embedded_page",
    redirect_on_completion: "never",
    mode: "payment",
    customer_email: user.email,
    client_reference_id: user.uid,
    metadata: { orderId: b.orderId },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: price * 100,
          product_data: { name: "Recast video", description: `${chosen.length} shots, ${render} s rendered · ${b.video.name}`.slice(0, 300) },
        },
      },
    ],
  });

  await db()
    .collection("orders")
    .doc(b.orderId)
    .set({
      uid: user.uid,
      email: user.email ?? null,
      status: "awaiting_payment",
      createdAt: new Date(),
      video: b.video,
      shots: b.shots,
      people: b.people,
      chosenShots: chosen,
      render,
      price,
      currency: "usd",
      sessionId: session.id,
      origin,
    });

  return NextResponse.json({ clientSecret: session.client_secret, price });
}
