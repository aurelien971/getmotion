// Credits. 1 credit = 1 second of rendering. Every shot is rendered on its own and the
// video model needs at least 5.2 s per render, so quick cuts use more credits than slow ones.
//
// Cost basis (Oct 2026): fal H3 Max Recast ≈ $0.10 per rendered second, plus a $0.02
// buffer for Claude's prompts = $0.12 per credit. After Stripe fees (2.9% + $0.30) every
// pack keeps a margin above 60%, and above 50% even if we absorb 30% re-renders.
export const MIN_RENDER = 5.2;
export const TYPICAL_SHOT = 2.5; // average shot length in a fast-cut music video, seconds

export const PACKS = [
  { credits: 50, price: 17, note: "About one short music-video clip" },
  { credits: 150, price: 49, note: "Three or four clips" },
  { credits: 500, price: 159, note: "A full video, or many clips" },
];

// Credits a stretch of footage uses, for a given average shot length.
export function creditsFor(seconds: number, avgShot = TYPICAL_SHOT) {
  const shots = Math.max(1, Math.ceil(seconds / avgShot));
  return Math.ceil(shots * Math.max(MIN_RENDER, Math.min(avgShot, seconds)));
}

// The smallest pack that covers it.
export const packFor = (credits: number) => PACKS.find((p) => p.credits >= credits) ?? PACKS[PACKS.length - 1];

export const CHECKOUT: Record<string, string> = {
  50: process.env.NEXT_PUBLIC_CHECKOUT_50 ?? "",
  150: process.env.NEXT_PUBLIC_CHECKOUT_150 ?? "",
  500: process.env.NEXT_PUBLIC_CHECKOUT_500 ?? "",
};

// What one video costs: every rendered second at the smallest pack's rate, never less than
// that pack. Used by the summary and, with the same numbers, by the checkout API.
export const PER_SECOND = PACKS[0].price / PACKS[0].credits;
export const renderSeconds = (shotLengths: number[]) => Math.ceil(shotLengths.reduce((a, b) => a + Math.max(MIN_RENDER, b), 0));
export const priceFor = (render: number) => Math.max(PACKS[0].price, Math.ceil(render * PER_SECOND));
