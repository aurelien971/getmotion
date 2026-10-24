import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 120;

type Img = { name: string; dataUrl: string };

const SYSTEM = `You list wardrobe for an AI video recast. The user replaces a man in a video
("the target") with another man ("the reference").

TARGET SHOTS show the target in one look (same outfit and place). List what the target wears or
carries that is visible: headwear, eyewear, tops, outer layers, jewelry, accessories, props held,
distinctive hair or facial hair. Be specific about color and type ("white backwards snapback",
"black wraparound sunglasses", "gold rope chain"). One item per thing.

REFERENCE IMAGES show the reference man. List the face first as "Face", then hair, then every
visible piece of clothing and accessory, same level of detail ("navy two-piece suit",
"white dress shirt", "red silk tie", "American flag lapel pin").

Also judge the target shots:
- "alone": true if he is the only person in every target shot.
- "faceHidden": true if in some frames his face is hard to see (looking down, cap brim, turned away, motion blur).
- "eyewear": true if he wears sunglasses or glasses in any target shot.
- "performance": a few words on what he does, e.g. "raps to camera with hand gestures, leans in".
- "others": every other clearly visible person who appears in several target shots (not a blurred
  crowd). For each: "label" describing them so a video model can find them (clothing, headwear,
  position relative to the target, e.g. "man in yellow cap and black NEW tee, behind him on the
  right"), "shot" = the 0-based index of the target shot where they are seen best, "box" = their
  head and upper body in that shot as [x, y, width, height], fractions of the image (0 to 1), and
  "wears" = their visible clothing and accessories, one item each. Empty list if none.

Reply with JSON only:
{"target":["..."],"reference":["Face","..."],"alone":true,"faceHidden":false,"eyewear":false,"performance":"...",
 "others":[{"label":"...","shot":0,"box":[0.6,0.1,0.25,0.5],"wears":["..."]}]}`;

function toImage(img: Img): Anthropic.ImageBlockParam | null {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(img.dataUrl);
  if (!m) return null;
  return { type: "image", source: { type: "base64", media_type: m[1] as "image/png" | "image/jpeg" | "image/webp", data: m[2] } };
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  const { targets, refs } = (await req.json()) as { targets: Img[]; refs: Img[] };
  if (!targets?.length) return Response.json({ error: "No target shots" }, { status: 400 });

  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: `TARGET SHOTS (${targets.length}):` }];
  for (const t of targets) {
    const im = toImage(t);
    if (im) content.push(im);
  }
  content.push({ type: "text", text: `REFERENCE IMAGES (${refs?.length ?? 0}):` });
  for (const r of refs ?? []) {
    const im = toImage(r);
    if (im) content.push(im);
  }
  content.push({ type: "text", text: "List the wardrobe. JSON only." });

  const client = new Anthropic();
  try {
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
    if (res.stop_reason === "refusal") {
      return Response.json({ error: `Declined: ${res.stop_details?.explanation ?? "safety"}` }, { status: 422 });
    }
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return Response.json(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return Response.json({ error: "Anthropic key rejected" }, { status: 401 });
    if (e instanceof Anthropic.RateLimitError) return Response.json({ error: "Anthropic rate limit, try again" }, { status: 429 });
    if (e instanceof Anthropic.APIError) return Response.json({ error: `Anthropic ${e.status}: ${e.message}` }, { status: 502 });
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
