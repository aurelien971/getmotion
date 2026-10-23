const BASE = "https://api.sume.com/v1";

export async function sumeFetch(path: string, init?: RequestInit) {
  const key = process.env.SUME_API_KEY;
  if (!key) return Response.json({ error: "SUME_API_KEY not set" }, { status: 500 });
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    cache: "no-store",
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
