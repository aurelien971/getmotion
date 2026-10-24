import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 120;

type Img = { name: string; dataUrl: string };
type Body = { targets: Img[]; faces: Img[]; notes: string; model: string };

const SYSTEM = `You are the director for an AI video "recast" tool. The user will swap a person in a
music video or film clip with a new person, using a video-to-video model (MiniMax H3 Max Recast or
Wan Animate). Those models take: the source clip, one reference photo per new person, and a single
text prompt. They cannot see the user's notes; everything must be in the prompt.

You receive:
1. TARGET SHOTS: screenshots of the source clip across its different shots. The person to replace
   appears in them, often in different clothes, lighting, framing, sometimes with other people.
2. FACES: the reference photo(s) of who goes in. "Reference image N" in the prompt refers to these,
   in order.
3. NOTES: what the user wants kept, changed, or emphasized.

Write ONE prompt the video model will execute well. Rules:
- Identify the target unambiguously in every shot by stable traits (build, hair, skin tone, the
  role they play: lead rapper, the one singing, etc.) and by per-shot cues (clothes, position,
  props). Name each shot briefly so the model can track them.
- State clearly that only the target is replaced and everyone else is unchanged.
- Say what carries over from the target (wardrobe, sunglasses, jewelry, hair under a hat...) and
  what comes from the reference (face, identity, skin tone, hairstyle unless covered), per the notes.
- Preserve performance: lip-sync, expressions, body motion, camera, lighting, color grade.
- Plain, concrete, present tense. No markdown. Under 220 words.

Respond with JSON only, no prose around it:
{
  "prompt": "<the prompt>",
  "target": "<one line: who is being replaced, stable traits>",
  "shots": ["<shot 1: what the target wears / where they are>", "..."],
  "warnings": ["<anything that may confuse the model, e.g. target absent in a shot>"]
}`;

function toImage(img: Img): Anthropic.ImageBlockParam {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(img.dataUrl);
  if (!m) throw new Error(`${img.name}: unsupported image format`);
  return {
    type: "image",
    source: { type: "base64", media_type: m[1] as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: m[2] },
  };
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }
  const body = (await req.json()) as Body;
  if (!body.targets?.length) return Response.json({ error: "Add at least one target shot" }, { status: 400 });

  const content: Anthropic.ContentBlockParam[] = [];
  content.push({ type: "text", text: `TARGET SHOTS (${body.targets.length}):` });
  body.targets.forEach((t, i) => {
    content.push({ type: "text", text: `Shot ${i + 1} — file "${t.name}"` });
    content.push(toImage(t));
  });
  content.push({ type: "text", text: `FACES (${body.faces.length}):` });
  body.faces.forEach((f, i) => {
    content.push({ type: "text", text: `Reference image ${i + 1} — file "${f.name}"` });
    content.push(toImage(f));
  });
  content.push({
    type: "text",
    text: `NOTES: ${body.notes?.trim() || "(none)"}\n\nVIDEO MODEL: ${body.model}\n\nWrite the JSON now.`,
  });

  const client = new Anthropic();
  try {
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high" },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
    if (res.stop_reason === "refusal") {
      return Response.json({ error: `Declined: ${res.stop_details?.explanation ?? "safety"}` }, { status: 422 });
    }
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    try {
      return Response.json(JSON.parse(json));
    } catch {
      return Response.json({ prompt: text.trim(), target: "", shots: [], warnings: ["Model did not return JSON; raw text used."] });
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return Response.json({ error: "Anthropic key rejected" }, { status: 401 });
    if (e instanceof Anthropic.RateLimitError) return Response.json({ error: "Anthropic rate limit, try again" }, { status: 429 });
    if (e instanceof Anthropic.APIError) return Response.json({ error: `Anthropic ${e.status}: ${e.message}` }, { status: 502 });
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
