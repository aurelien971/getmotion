import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { markPaid, stripe } from "@/lib/admin";

// Stripe → us. Signed with STRIPE_WEBHOOK_SECRET; marks the order paid.
export async function POST(req: Request) {
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(await req.text(), req.headers.get("stripe-signature") ?? "", process.env.STRIPE_WEBHOOK_SECRET ?? "");
  } catch {
    return NextResponse.json({ error: "Bad signature" }, { status: 400 });
  }
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded")
    await markPaid(event.data.object as Stripe.Checkout.Session);
  return NextResponse.json({ received: true });
}
