import { revalidatePath } from "next/cache";
import { bucket, db, type OrderStatus } from "@/lib/admin";

// Private (behind APP_PASSWORD): every order, newest first, with its files to download and
// the shots to recast, so a paid order can go straight into Chapters.
export const dynamic = "force-dynamic";

const STATUSES: OrderStatus[] = ["awaiting_payment", "paid", "rendering", "delivered", "refunded"];
const url = async (path: string) => (await bucket().file(path).getSignedUrl({ action: "read", expires: Date.now() + 6 * 3600_000 }))[0];
const time = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

async function setStatus(form: FormData) {
  "use server";
  await db().collection("orders").doc(String(form.get("id"))).update({ status: String(form.get("status")), [`${form.get("status")}At`]: new Date() });
  revalidatePath("/orders");
}

type Order = {
  id: string;
  email: string;
  status: OrderStatus;
  createdAt: { toDate: () => Date };
  price: number;
  render: number;
  video: { path: string; name: string; duration: number; width: number; height: number };
  shots: { start: number; end: number }[];
  people: { id: string; shots: number[]; face: string; photos: string[] }[];
};

export default async function Orders() {
  const snap = await db().collection("orders").orderBy("createdAt", "desc").limit(50).get();
  const orders = await Promise.all(
    snap.docs.map(async (d) => {
      const o = { id: d.id, ...d.data() } as Order;
      return {
        o,
        video: await url(o.video.path),
        people: await Promise.all(o.people.map(async (p) => ({ ...p, faceUrl: await url(p.face), photoUrls: await Promise.all(p.photos.map(url)) }))),
      };
    }),
  );

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-10 text-[14px]">
      <h1 className="text-[22px] font-semibold">Orders</h1>
      <p className="mt-1 text-neutral-500">{orders.length} most recent. Paid ones need rendering.</p>
      <ul className="mt-8 space-y-6">
        {orders.map(({ o, video, people }) => (
          <li key={o.id} className="rounded-2xl border border-neutral-800 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <span className="font-mono">{o.id.slice(0, 8)}</span> · {o.email} · {o.createdAt.toDate().toLocaleString("en-GB")}
              </div>
              <form action={setStatus} className="flex items-center gap-2">
                <input type="hidden" name="id" value={o.id} />
                <select name="status" defaultValue={o.status} className="rounded-lg border border-neutral-700 bg-transparent px-2 py-1">
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s.replace("_", " ")}
                    </option>
                  ))}
                </select>
                <button className="rounded-lg border border-neutral-700 px-3 py-1">Save</button>
              </form>
            </div>
            <div className="mt-2 text-neutral-400">
              ${o.price} · {o.render} s to render · {o.video.name} ({Math.round(o.video.duration)} s, {o.video.width}×{o.video.height}) ·{" "}
              <a href={video} className="underline">
                download video
              </a>
            </div>
            {people.map((p) => (
              <div key={p.id} className="mt-4 flex flex-wrap items-start gap-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.faceUrl} alt="" className="h-16 w-16 rounded-xl object-cover" />
                <span className="self-center text-neutral-500">→</span>
                {p.photoUrls.map((u) => (
                  <a key={u} href={u}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u} alt="" className="h-16 w-16 rounded-xl object-cover" />
                  </a>
                ))}
                <div className="min-w-[240px] flex-1 text-[12px] leading-relaxed text-neutral-400">
                  {p.shots.length} shots: {p.shots.map((s) => `${time(o.shots[s].start)}–${time(o.shots[s].end)}`).join(", ")}
                </div>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </main>
  );
}
