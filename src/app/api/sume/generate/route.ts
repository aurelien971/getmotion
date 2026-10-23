import { SUME_MODELS } from "@/lib/models";
import { sumeFetch } from "@/lib/sume";

export async function POST(req: Request) {
  const body = await req.json();
  if (!SUME_MODELS.includes(body.model)) {
    return Response.json({ error: "model not allowed" }, { status: 400 });
  }
  return sumeFetch("/video-router/generate", { method: "POST", body: JSON.stringify(body) });
}
