import Link from "next/link";
import { CreditStore } from "@/components/landing/CreditStore";
import { Portfolio } from "@/components/landing/Portfolio";
import { ExampleVideo } from "@/components/landing/ExampleVideo";
import { EXAMPLES } from "@/components/landing/examples";
import { Recast } from "@/components/landing/Recast";
import { PACKS } from "@/components/landing/pricing";

// Public landing page. One quiet surface: the chrome M, a few honest sentences, and the
// tool itself. Everything else is plain type on warm stone.

const STAYS = [
  "Every lip movement, glance and gesture",
  "The camera moves, framing and cuts",
  "Lighting, haze, lens flares and the color grade",
  "Everyone else in the scene",
  "The original sound, untouched",
];
const CHANGES = [
  "The face, identity and hair of who you choose",
  "Their outfit, piece by piece, or keep the original",
  "Up to three other people in the same scene, if you like",
];

const STEPS = [
  {
    title: "We read the video",
    body: "Scene cuts are found frame by frame, and every shot with your person in it is grouped by outfit and place.",
  },
  {
    title: "Each shot is recast on its own",
    body: "A shot is rendered as one continuous piece, so the new face never jumps at a cut. Lip-sync and motion come from the original.",
  },
  {
    title: "It goes back on the original timeline",
    body: "Rendered shots are laid back over the source, frame for frame, under the original audio. You get one finished video.",
  },
];

const FAQ = [
  {
    q: "How long can the video be?",
    a: "Any length. Every second we render uses one credit, and quick cuts use more because each shot is rendered on its own. You see the exact count before anything renders.",
  },
  {
    q: "Which links work?",
    a: "YouTube, TikTok, Instagram, Vimeo, X, or a direct link to an MP4 or MOV file. You can also upload the file itself.",
  },
  {
    q: "What photos work best?",
    a: "One to four clear photos of the same person: face toward the camera, even light, nothing covering the face. A full-body photo helps if you want their outfit too.",
  },
  {
    q: "Can I use anyone’s face?",
    a: "Only with their permission, or your own. Don’t use getmotion to deceive, harass or impersonate anyone.",
  },
  {
    q: "What if a render fails?",
    a: "A failed render gives its credits back.",
  },
];

export default function Landing() {
  return (
    <div className="landing min-h-screen">
      <div className="mx-auto max-w-[1180px] px-5 sm:px-8">
        <header className="flex items-center justify-between pt-7 pb-4">
          <Link href="/" className="flex items-center gap-2.5" aria-label="getmotion home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/m.jpg" alt="" width={34} height={34} className="mark h-[34px] w-[34px]" />
            <span className="font-display text-[17px] tracking-[-0.01em]">getmotion</span>
          </Link>
          <nav className="flex items-center gap-1 text-[14px]">
            <a href="#examples" className="navlink">Examples</a>
            <a href="#how" className="navlink">How it works</a>
            <a href="#pricing" className="navlink">Pricing</a>
          </nav>
        </header>

        <main>
          <section className="grid items-center gap-10 pt-4 pb-20 sm:pt-8 sm:pb-24 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14 lg:pt-10">
            <div className="max-w-[540px]">
              <div className="sheen -ml-4 h-[120px] w-[120px] sm:-ml-5 sm:h-[180px] sm:w-[180px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/m.jpg" alt="getmotion" width={300} height={300} className="mark h-full w-full" />
              </div>
              <h1 className="font-display mt-1 text-[40px] leading-[1.03] tracking-[-0.035em] sm:text-[56px]">
                Put someone new in any video.
              </h1>
              <p className="mt-5 max-w-[470px] text-[17px] leading-[1.6] text-[var(--muted)]">
                Paste a link, add a few photos of who goes in, and get the same scene back with them in it. Same moves,
                same camera, same light, and the sound exactly as it was.
              </p>
              <div className="mt-8">
                <Recast />
              </div>
              <p className="mt-4 text-[14px] text-[var(--faint)]">
                Credits from <span className="text-[var(--text)]">${PACKS[0].price}</span>. Sign in with Google or Apple.
              </p>
            </div>

            <div>
              <ExampleVideo src={EXAMPLES[0].result} poster={EXAMPLES[0].poster} />
              <p className="mt-3 text-[13px] text-[var(--faint)]">A result. Every shot recast, the original sound kept.</p>
            </div>
          </section>

          <section id="examples" className="border-t border-[var(--hair)] py-20">
            <div className="mb-10 flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="font-display text-[26px] leading-tight tracking-[-0.02em]">Examples</h2>
              <p className="text-[14px] text-[var(--faint)]">What went in, and what came out.</p>
            </div>
            <Portfolio />
          </section>

          <section className="grid gap-12 border-t border-[var(--hair)] py-20 md:grid-cols-[220px_minmax(0,1fr)] md:gap-16">
            <h2 className="font-display text-[26px] leading-tight tracking-[-0.02em]">What stays, what changes</h2>
            <div className="grid gap-10 sm:grid-cols-2">
              <div>
                <h3 className="text-[13px] text-[var(--faint)]">Stays exactly as filmed</h3>
                <ul className="mt-4 space-y-3 text-[16px] leading-snug">
                  {STAYS.map((x) => (
                    <li key={x} className="flex gap-3">
                      <span aria-hidden className="mt-[9px] h-px w-4 shrink-0 bg-[var(--muted)]" />
                      {x}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-[13px] text-[var(--faint)]">Changes to who you choose</h3>
                <ul className="mt-4 space-y-3 text-[16px] leading-snug">
                  {CHANGES.map((x) => (
                    <li key={x} className="flex gap-3">
                      <span aria-hidden className="mt-[9px] h-px w-4 shrink-0 bg-[var(--text)]" />
                      {x}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          <section id="how" className="grid gap-12 border-t border-[var(--hair)] py-24 md:grid-cols-[220px_minmax(0,1fr)] md:gap-16">
            <h2 className="font-display text-[26px] leading-tight tracking-[-0.02em]">How it works</h2>
            <ol className="space-y-12">
              {STEPS.map((s, i) => (
                <li key={s.title} className="grid grid-cols-[44px_minmax(0,1fr)] gap-4">
                  <span className="font-display text-[22px] tabular-nums text-[var(--faint)]">{i + 1}</span>
                  <div className="max-w-[560px]">
                    <h3 className="text-[19px] tracking-[-0.01em]">{s.title}</h3>
                    <p className="mt-2 text-[16px] leading-[1.6] text-[var(--muted)]">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section id="pricing" className="grid gap-12 border-t border-[var(--hair)] py-24 md:grid-cols-[220px_minmax(0,1fr)] md:gap-16">
            <div>
              <h2 className="font-display text-[26px] leading-tight tracking-[-0.02em]">Credits</h2>
              <p className="mt-3 text-[14px] leading-relaxed text-[var(--muted)]">Buy once, use them whenever. No subscription.</p>
            </div>
            <CreditStore />
          </section>

          <section className="grid gap-12 border-t border-[var(--hair)] py-24 md:grid-cols-[220px_minmax(0,1fr)] md:gap-16">
            <h2 className="font-display text-[26px] leading-tight tracking-[-0.02em]">Questions</h2>
            <div className="max-w-[680px] divide-y divide-[var(--hair)]">
              {FAQ.map((f) => (
                <details key={f.q} className="faq group py-5 first:pt-0">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-[17px]">
                    {f.q}
                    <span aria-hidden className="faq-mark relative h-3 w-3 shrink-0" />
                  </summary>
                  <p className="mt-3 max-w-[600px] text-[16px] leading-[1.6] text-[var(--muted)]">{f.a}</p>
                </details>
              ))}
            </div>
          </section>
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--hair)] py-10 text-[13px] text-[var(--faint)]">
          <span>© {new Date().getFullYear()} getmotion</span>
          <a href="mailto:hello@getmotion.art" className="hover:text-[var(--text)]">hello@getmotion.art</a>
        </footer>
      </div>
    </div>
  );
}
