import "server-only";
import { cert, getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import Stripe from "stripe";

// Server-side Firebase (service account in FIREBASE_SERVICE_ACCOUNT, base64 JSON) and Stripe.
const app = () => {
  if (getApps().length) return getApp();
  const key = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT ?? "", "base64").toString("utf8"));
  return initializeApp({ credential: cert(key), storageBucket: `${key.project_id}.firebasestorage.app` });
};
export const db = () => getFirestore(app());
export const bucket = () => getStorage(app()).bucket();
export const stripe = () => new Stripe(process.env.STRIPE_SECRET_KEY!);

// The signed-in visitor behind a request, from the Firebase ID token in Authorization.
export async function userFrom(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return null;
  try {
    return await getAuth(app()).verifyIdToken(token);
  } catch {
    return null;
  }
}

export type OrderStatus = "awaiting_payment" | "paid" | "rendering" | "delivered" | "refunded";

// Marks an order paid once Stripe says the session is paid. Safe to call twice (confirm + webhook).
export async function markPaid(session: Stripe.Checkout.Session) {
  const id = session.metadata?.orderId;
  if (!id || session.payment_status !== "paid") return null;
  const ref = db().collection("orders").doc(id);
  await db().runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (snap.exists && snap.get("status") === "awaiting_payment")
      t.update(ref, { status: "paid", paidAt: new Date(), paymentIntent: session.payment_intent ?? null, amountPaid: session.amount_total });
  });
  return id;
}
