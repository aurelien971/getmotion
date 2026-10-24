import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 120;

type Frame = { id: string; start: number; end: number; dataUrl: string };

const SYSTEM = `You sort the shots of a music video or film into "looks" for an AI recast tool.
Every shot shows the same target person. Group shots where he wears the same outfit in the same
location (lighting and setting match), so each group can be rendered with one consistent
description. Different outfit or different place = different group. Keep groups few but never
mix looks.

For each group give a short name (2-4 words, e.g. "Club, white tee") and a one-sentence
description of how the target looks and where he is in that group (clothing, headwear, eyewear,
framing, who else is around). Mention eyewear, hats and side/back angles explicitly; they make
the face hard to find.

Reply with JSON only:
{"groups":[{"name":"...","description":"...","shotIds":["..."]}]}
Every shot id must appear in exactly one group.`;

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }
  const { frames } = (await req.json()) as { frames: Frame[] };
  if (!frames?.length) return Response.json({ error: "No shots" }, { status: 400 });

  const content: Anthropic.ContentBlockParam[] = [];
  for (const f of frames) {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(f.dataUrl);
    if (!m) continue;
    content.push({ type: "text", text: `Shot ${f.id} (${f.start.toFixed(2)}s to ${f.end.toFixed(2)}s)` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: m[1] as "image/png" | "image/jpeg" | "image/webp", data: m[2] },
    });
  }
  content.push({ type: "text", text: "Group these shots. JSON only." });

  const client = new Anthropic();
  try {
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
    if (res.stop_reason === "refusal") {
      return Response.json({ error: `Declined: ${res.stop_details?.explanation ?? "safety"}` }, { status: 422 });
    }
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return Response.json(json);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return Response.json({ error: "Anthropic key rejected" }, { status: 401 });
    if (e instanceof Anthropic.RateLimitError) return Response.json({ error: "Anthropic rate limit, try again" }, { status: 429 });
    if (e instanceof Anthropic.APIError) return Response.json({ error: `Anthropic ${e.status}: ${e.message}` }, { status: 502 });
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
