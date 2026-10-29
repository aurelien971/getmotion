import { NextResponse } from "next/server";
import { db, markPaid, stripe, userFrom } from "@/lib/admin";

// Called by the page when embedded Checkout completes; asks Stripe directly rather than
// trusting the browser. The webhook does the same in case the tab closes first.
export async function POST(req: Request) {
  const user = await userFrom(req);
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { orderId } = (await req.json()) as { orderId: string };
  const snap = await db().collection("orders").doc(String(orderId)).get();
  if (!snap.exists || snap.get("uid") !== user.uid) return NextResponse.json({ error: "Order not found." }, { status: 404 });
  await markPaid(await stripe().checkout.sessions.retrieve(snap.get("sessionId")));
  const fresh = await snap.ref.get();
  return NextResponse.json({ status: fresh.get("status") });
}
