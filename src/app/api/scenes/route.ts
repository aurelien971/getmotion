import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 300;

type Img = { name: string; dataUrl: string };
type Scene = { from: number; to: number; frames: string[] };
type Body = {
  scenes: Scene[];
  faces: Img[];
  others?: { index: number; label: string; wardrobe: string; dataUrl: string }[]; // people who may also be swapped
  othersFixed?: boolean; // true: swap exactly these; false: swap only the ones visible in this clip
  look: string;
  rules: string; // wardrobe / swap decisions the user made, must be respected
  basePrompt: string; // the deterministic prompt built from those decisions
  notes?: string;
  model: string;
  clipLength: number;
  loopFrom: number; // from here the clip repeats earlier footage as filler
};

const SYSTEM = `You are a world-class prompt writer for video-to-video "recast" models (MiniMax H3 Max
Recast). The model receives ONE source clip, reference photos and ONE text prompt, and must replace
exactly one person through the whole clip while keeping everything else.

The source clip is a stitched sequence of hard-cut scenes from a music video. These models lose the
target at hard cuts, in crowds and when he is small, blurred or covered. Your prompt is what keeps
the model locked on him. You receive every scene of THIS clip in playback order, with its exact
time range and frames from its start, middle and end.

Work in this order:
1. Study every scene. For each: shot size (extreme close-up / close-up / medium / wide), where the
   target is in frame (left / center / right, foreground / background), what he is doing (rapping
   to camera, pointing, arm raised, dancing...), how visible he is (clear, small, motion-blurred,
   partly hidden, back turned), lighting and color, and who else is in frame, especially anyone who
   could be mistaken for him (other men with caps, white tees, sunglasses).
2. Pin down who he is with stable traits that hold across scenes (build, skin tone, hair, the
   clothes and accessories he wears in this clip, his role: the lead rapper performing to camera).
3. Write the prompt.

The prompt must:
- Open with one sentence naming the single person to replace and how to recognise him.
- Say who he becomes, following the RULES exactly (what comes from the reference photos, what stays
  from the original, what is removed). Never contradict the RULES.
- Walk through the scenes in order with their time ranges, e.g. "0.0-1.2s, close-up: he fills the
  left half of the frame, rapping toward camera." One short line per scene, concrete visual cues
  only: position, framing, action, and the decoys to leave alone. Call out hard cases explicitly
  ("even though he is tiny in the back", "even though motion blur hides his face").
- If the clip has filler (after LOOP FROM), it is the same footage played backward, then forward
  again. Say that from that time the shot replays in reverse and forward and he must be replaced
  there too, the same way.
- If the clip has only ONE scene, it is a single continuous shot: do not number scenes. Describe
  exactly where he is in the frame and how he moves through the shot (start, middle, end), the
  decoys next to him, and what covers his face if anything (flare, hand, cap). This is the
  most important case: be precise about his position.
- State that everyone else, the background, camera motion, lighting, haze, lens flares and the color
  grade stay exactly as they are, and that lip-sync, expressions and gestures are preserved.
- Be plain, literal, present tense. No markdown, no hype words, no quality adjectives
  ("cinematic", "8k", "masterpiece"). Hard limit: 1,800 characters (the model rejects more than 2,000).

OTHER PEOPLE: if any are listed, decide from the frames which of them are actually visible in
this clip (unless told to swap all). Only those go in the prompt. Their photos are sent to the video
model after the reference photos of the lead, in the order they are listed, counting only the ones
you include: with N reference photos of the lead, the first included person is reference image N+1, the
next N+2. Describe each by position and clothing so the model finds them, and say what they take
from their photo and what they keep. Anyone visible but not swapped is a decoy: leave unchanged.

Respond with JSON only:
{
  "prompt": "<the prompt>",
  "target": "<one line: how to recognise him>",
  "scenes": [{"time": "0.0-1.2s", "shot": "close-up", "where": "left, foreground", "action": "...", "visibility": "clear|small|blurred|hidden|absent", "decoys": "..."}],
  "warnings": ["<scenes where he is absent or ambiguous, decoys likely to be swapped instead, anything that may make the render fail>"],
  "present": [<Person # numbers you swapped in the prompt, e.g. 0, 2>]
}`;

function toImage(dataUrl: string): Anthropic.ImageBlockParam {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error("unsupported image format");
  return { type: "image", source: { type: "base64", media_type: m[1] as "image/jpeg", data: m[2] } };
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  const b = (await req.json()) as Body;
  if (!b.scenes?.length) return Response.json({ error: "No scenes" }, { status: 400 });

  const content: Anthropic.ContentBlockParam[] = [];
  content.push({ type: "text", text: `REFERENCE PHOTOS of who goes in (${b.faces.length}):` });
  b.faces.forEach((f, i) => {
    content.push({ type: "text", text: `Reference image ${i + 1}` });
    content.push(toImage(f.dataUrl));
  });
  if (b.others?.length) {
    content.push({
      type: "text",
      text: b.othersFixed
        ? "OTHER PEOPLE TO SWAP in this clip (all of them):"
        : "OTHER PEOPLE WHO MAY ALSO BE SWAPPED. Swap a person only if they are visible in this clip:",
    });
    b.others.forEach((o) => {
      content.push({ type: "text", text: `Person #${o.index}: ${o.label}. Their new photo below; ${o.wardrobe}.` });
      content.push(toImage(o.dataUrl));
    });
  }
  content.push({ type: "text", text: `THE CLIP, ${b.clipLength.toFixed(1)}s, ${b.scenes.length} scenes in playback order:` });
  b.scenes.forEach((s, i) => {
    content.push({ type: "text", text: `Scene ${i + 1}: ${s.from.toFixed(1)}-${s.to.toFixed(1)}s (${(s.to - s.from).toFixed(1)}s)` });
    s.frames.forEach((f) => content.push(toImage(f)));
  });
  content.push({
    type: "text",
    text: [
      `LOOK: ${b.look}`,
      b.loopFrom < b.clipLength - 0.05 ? `LOOP FROM: ${b.loopFrom.toFixed(1)}s (filler: the same footage played backward then forward until ${b.clipLength.toFixed(1)}s)` : "LOOP FROM: none",
      `RULES (the user's decisions, follow exactly): ${b.rules || "(none)"}`,
      `BASE PROMPT built from those rules, for reference: ${b.basePrompt}`,
      `NOTES: ${b.notes?.trim() || "(none)"}`,
      `VIDEO MODEL: ${b.model}`,
      "Write the JSON now.",
    ].join("\n\n"),
  });

  const client = new Anthropic();
  try {
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
    const res = await stream.finalMessage();
    if (res.stop_reason === "refusal") return Response.json({ error: "Declined by the model" }, { status: 422 });
    const text = res.content.filter((x) => x.type === "text").map((x) => x.text).join("");
    try {
      return Response.json(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
    } catch {
      return Response.json({ prompt: text.trim(), target: "", scenes: [], warnings: ["Model did not return JSON; raw text used."] });
    }
  } catch (e) {
    if (e instanceof Anthropic.APIError) return Response.json({ error: `Anthropic ${e.status}: ${e.message}` }, { status: 502 });
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
