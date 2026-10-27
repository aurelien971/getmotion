import { ExampleVideo } from "./ExampleVideo";
import { EXAMPLES } from "./examples";

// Each example shows what went in (the original video and one photo) and what came out.
export function Portfolio() {
  return (
    <div className="space-y-20">
      {EXAMPLES.map((x) => (
        <article key={x.result} className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-1 lg:content-start">
            <a href={x.original} target="_blank" rel="noopener noreferrer" className="in-tile group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={x.originalThumb} alt="" className="aspect-video w-full rounded-2xl object-cover" />
              <span className="mt-2 flex items-center justify-between text-[13px]">
                <span className="text-[var(--muted)]">Original</span>
                <span className="text-[var(--faint)] group-hover:text-[var(--text)]">Watch ↗</span>
              </span>
            </a>
            <div className="in-tile">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={x.photo} alt="The reference photo used" className="aspect-video w-full rounded-2xl object-cover object-top" />
              <span className="mt-2 block text-[13px] text-[var(--muted)]">Photo used</span>
            </div>
          </div>
          <div>
            <ExampleVideo src={x.result} poster={x.poster} />
            <p className="mt-3 text-[14px] text-[var(--faint)]">{x.title}. Result, with the original sound.</p>
          </div>
        </article>
      ))}
    </div>
  );
}
