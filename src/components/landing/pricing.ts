// Prices shown on the landing page and in the paywall. One video = up to 30 s of footage.
// Checkout links are Stripe Payment Links, set as env vars once Stripe is ready; until
// then the paywall says checkout isn't open yet instead of pretending to take payment.
export const SECONDS_PER_VIDEO = 30;

export const PRICES = {
  single: 16.99,
  packs: [
    { credits: 5, price: 69 },
    { credits: 20, price: 239 },
  ],
};

export const CHECKOUT = {
  single: process.env.NEXT_PUBLIC_CHECKOUT_SINGLE ?? "",
  5: process.env.NEXT_PUBLIC_CHECKOUT_5 ?? "",
  20: process.env.NEXT_PUBLIC_CHECKOUT_20 ?? "",
} as Record<string, string>;
