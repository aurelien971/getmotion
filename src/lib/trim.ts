import { fetchFile, toBlobURL } from "@ffmpeg/util";

// ffmpeg.wasm's npm build uses a worker pattern Turbopack can't bundle, so its
// prebuilt UMD script (and the worker it spawns next to itself) is served from
// public/ffmpeg and loaded at runtime. The 30 MB core still comes from the CDN.
const FFMPEG = "/ffmpeg";
const CORE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

type Progress = { progress: number };
type FFmpegLike = {
  load(o: { coreURL: string; wasmURL: string }): Promise<boolean>;
  exec(args: string[]): Promise<number>;
  writeFile(path: string, data: Uint8Array): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array | string>;
  deleteFile(path: string): Promise<boolean>;
  on(ev: "progress", cb: (p: Progress) => void): void;
  on(ev: "log", cb: (l: { message: string }) => void): void;
  off(ev: "progress", cb: (p: Progress) => void): void;
  off(ev: "log", cb: (l: { message: string }) => void): void;
};
declare global {
  interface Window {
    FFmpegWASM?: { FFmpeg: new () => FFmpegLike };
  }
}

let instance: Promise<FFmpegLike> | null = null;

// Start fetching the engine early (e.g. as soon as a clip is dropped).
export function warmUp() {
  load().catch(() => {});
}

function script(src: string) {
  return new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(el);
  });
}

// Single-threaded core: works without COOP/COEP headers, loads once (~30 MB, cached).
function load() {
  if (!instance) {
    instance = (async () => {
      if (!window.FFmpegWASM) await script(`${FFMPEG}/ffmpeg.js`);
      const ff = new window.FFmpegWASM!.FFmpeg();
      await ff.load({
        coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ff;
    })().catch((e) => {
      instance = null;
      throw e;
    });
  }
  return instance;
}

export class NoDecoderError extends Error {
  constructor() {
    super("No decoder for this codec in the browser engine");
    this.name = "NoDecoderError";
  }
}

// Cut [start, end] out of a video. Re-encodes video for frame-accurate edges,
// keeps the audio. Returns an MP4 file.
export async function trimVideo(
  file: File,
  start: number,
  end: number,
  onProgress?: (ratio: number) => void,
  onStage?: (stage: "engine" | "cut") => void,
): Promise<File> {
  onStage?.("engine");
  const ff = await load();
  const handler = ({ progress }: Progress) => onProgress?.(Math.max(0, Math.min(1, progress)));
  ff.on("progress", handler);
  try {
    await ff.writeFile("in", await fetchFile(file));
    onStage?.("cut");
    const code = await ff.exec([
      "-ss", start.toFixed(3),
      "-to", end.toFixed(3),
      "-i", "in",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-movflags", "+faststart",
      "-y", "out.mp4",
    ]);
    if (code !== 0) {
      // The wasm build has no HEVC or AV1 decoder (iPhone footage, YouTube rips).
      // The caller re-records the window through the browser's decoder instead.
      throw new NoDecoderError();
    }
    const data = (await ff.readFile("out.mp4")) as Uint8Array;
    const name = file.name.replace(/\.[^.]+$/, "") + `-${start.toFixed(1)}-${end.toFixed(1)}.mp4`;
    return new File([data.slice().buffer as ArrayBuffer], name, { type: "video/mp4" });
  } finally {
    ff.off("progress", handler);
    await ff.deleteFile("in").catch(() => {});
    await ff.deleteFile("out.mp4").catch(() => {});
  }
}

// Put the source clip's audio under a silent generated video (Wan models drop audio).
export async function muxAudio(video: Blob, source: File): Promise<File> {
  const ff = await load();
  try {
    await ff.writeFile("v.mp4", await fetchFile(video));
    await ff.writeFile("src", await fetchFile(source));
    await ff.exec([
      "-i", "v.mp4",
      "-i", "src",
      "-map", "0:v:0",
      "-map", "1:a:0?",
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      "-movflags", "+faststart",
      "-y", "muxed.mp4",
    ]);
    const data = (await ff.readFile("muxed.mp4")) as Uint8Array;
    return new File([data.slice().buffer as ArrayBuffer], "take.mp4", { type: "video/mp4" });
  } finally {
    for (const f of ["v.mp4", "src", "muxed.mp4"]) await ff.deleteFile(f).catch(() => {});
  }
}

// Does this file carry an audio stream? Parsed from ffmpeg's own probe output.
async function hasAudio(ff: FFmpegLike, path: string) {
  let found = false;
  const onLog = ({ message }: { message: string }) => {
    if (/Stream #\d+:\d+.*Audio:/.test(message)) found = true;
  };
  ff.on("log", onLog);
  try {
    await ff.exec(["-i", path, "-f", "null", "-t", "0.1", "-"]).catch(() => {});
  } finally {
    ff.off("log", onLog);
  }
  return found;
}

// Join clips back to back. Every input is conformed to the first clip's frame size at
// 30fps with stereo AAC (silence where a clip has none), then concatenated.
export async function stitchVideos(
  files: Blob[],
  size: { w: number; h: number },
  onProgress?: (ratio: number) => void,
): Promise<File> {
  const ff = await load();
  const w = size.w - (size.w % 2);
  const h = size.h - (size.h % 2);
  const names: string[] = [];
  try {
    for (let i = 0; i < files.length; i++) {
      onProgress?.(i / (files.length + 1));
      const input = `in${i}`;
      const seg = `seg${i}.mp4`;
      await ff.writeFile(input, await fetchFile(files[i]));
      const audio = await hasAudio(ff, input);
      const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`;
      const args = audio
        ? ["-i", input, "-vf", vf, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
           "-c:a", "aac", "-ar", "48000", "-ac", "2", "-y", seg]
        : ["-i", input, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
           "-vf", vf, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
           "-c:a", "aac", "-shortest", "-map", "0:v:0", "-map", "1:a:0", "-y", seg];
      await ff.exec(args);
      await ff.deleteFile(input).catch(() => {});
      names.push(seg);
    }
    await ff.writeFile("list.txt", new TextEncoder().encode(names.map((n) => `file '${n}'`).join("\n")));
    await ff.exec(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", "-y", "stitched.mp4"]);
    onProgress?.(1);
    const data = (await ff.readFile("stitched.mp4")) as Uint8Array;
    return new File([data.slice().buffer as ArrayBuffer], "stitched.mp4", { type: "video/mp4" });
  } finally {
    for (const n of [...names, "list.txt", "stitched.mp4"]) await ff.deleteFile(n).catch(() => {});
  }
}

// Video codec name as ffmpeg reports it ("h264", "hevc", "vp9", ...), or null if unknown.
export async function probeVideoCodec(file: Blob): Promise<string | null> {
  const ff = await load();
  let codec: string | null = null;
  const onLog = ({ message }: { message: string }) => {
    const m = /Stream #\d+:\d+.*Video: ([a-z0-9_]+)/i.exec(message);
    if (m && !codec) codec = m[1].toLowerCase();
  };
  ff.on("log", onLog);
  try {
    await ff.writeFile("probe", await fetchFile(file));
    await ff.exec(["-i", "probe", "-f", "null", "-t", "0.1", "-"]).catch(() => {});
  } finally {
    ff.off("log", onLog);
    await ff.deleteFile("probe").catch(() => {});
  }
  return codec;
}

// ---------------------------------------------------------------------------
// Chapters engine. One ffmpeg instance is shared, so long jobs (scene detection
// in the background, clip builds, assembly) run one at a time through a lock.

let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

let seq = 0;
const tmp = (ext: string) => `t${++seq}.${ext}`;

// Run ffmpeg and report progress from its "time=" log lines against an expected length.
async function execTimed(ff: FFmpegLike, args: string[], total: number, onProgress?: (r: number) => void) {
  const onLog = ({ message }: { message: string }) => {
    const m = /time=(\d+):(\d+):([\d.]+)/.exec(message);
    if (m && total > 0) onProgress?.(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / total));
  };
  ff.on("log", onLog);
  try {
    return await ff.exec(args);
  } finally {
    ff.off("log", onLog);
  }
}

export async function fileHasAudio(blob: Blob): Promise<boolean> {
  return exclusive(async () => {
    const ff = await load();
    const name = tmp("bin");
    await ff.writeFile(name, await fetchFile(blob));
    try {
      return await hasAudio(ff, name);
    } finally {
      await ff.deleteFile(name).catch(() => {});
    }
  });
}

// Scene cuts (seconds) via ffmpeg's scene score on a downscaled decode.
export async function detectCuts(
  blob: Blob,
  duration: number,
  onProgress?: (r: number) => void,
  threshold = 0.3,
): Promise<number[]> {
  return exclusive(async () => {
    const ff = await load();
    const name = tmp("mp4");
    await ff.writeFile(name, await fetchFile(blob));
    const cuts: number[] = [];
    const onLog = ({ message }: { message: string }) => {
      const m = /pts_time:([\d.]+)/.exec(message);
      if (m) cuts.push(+m[1]);
    };
    ff.on("log", onLog);
    try {
      await execTimed(
        ff,
        ["-i", name, "-an", "-vf", `scale=160:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"],
        duration,
        onProgress,
      );
    } finally {
      ff.off("log", onLog);
      await ff.deleteFile(name).catch(() => {});
    }
    return [...new Set(cuts.map((c) => Math.round(c * 1000) / 1000))].sort((a, b) => a - b);
  });
}

type Span = { start: number; end: number };

// Build one clip from several spans of the same source, back to back, conformed
// to w x h. Spans are cut with input seeking so late spans don't decode the whole file.
export async function buildClip(
  source: Blob,
  spans: Span[],
  size: { w: number; h: number },
  withAudio: boolean,
  onProgress?: (r: number) => void,
): Promise<File> {
  return exclusive(async () => {
    const ff = await load();
    const src = tmp("mp4");
    const out = tmp("mp4");
    await ff.writeFile(src, await fetchFile(source));
    const w = size.w - (size.w % 2);
    const h = size.h - (size.h % 2);
    const args: string[] = [];
    spans.forEach((s) => args.push("-ss", s.start.toFixed(3), "-t", (s.end - s.start).toFixed(3), "-i", src));
    const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p`;
    let graph = "";
    let ins = "";
    spans.forEach((_, i) => {
      graph += `[${i}:v]setpts=PTS-STARTPTS,${vf}[v${i}];`;
      if (withAudio) graph += `[${i}:a]asetpts=PTS-STARTPTS,aresample=48000[a${i}];`;
      ins += withAudio ? `[v${i}][a${i}]` : `[v${i}]`;
    });
    graph += `${ins}concat=n=${spans.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? "[a]" : ""}`;
    const total = spans.reduce((t, s) => t + s.end - s.start, 0);
    const code = await execTimed(
      ff,
      [
        ...args,
        "-filter_complex", graph,
        "-map", "[v]",
        ...(withAudio ? ["-map", "[a]", "-c:a", "aac", "-ac", "2"] : []),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-movflags", "+faststart", "-y", out,
      ],
      total,
      onProgress,
    );
    try {
      if (code !== 0) throw new Error("Building the clip failed (ffmpeg exit " + code + ")");
      const data = (await ff.readFile(out)) as Uint8Array;
      return new File([data.slice().buffer as ArrayBuffer], "group-clip.mp4", { type: "video/mp4" });
    } finally {
      await ff.deleteFile(src).catch(() => {});
      await ff.deleteFile(out).catch(() => {});
    }
  });
}

export type TimelinePiece = { file: number; start: number; end: number }; // file 0 = source

// Lay pieces end to end, conform every piece to w x h, and put the source's own
// audio for [audioStart, audioEnd] underneath.
export async function assembleTimeline(
  files: Blob[],
  pieces: TimelinePiece[],
  audio: { start: number; end: number } | null,
  size: { w: number; h: number },
  onProgress?: (r: number) => void,
): Promise<File> {
  return exclusive(async () => {
    const ff = await load();
    const names = files.map(() => tmp("mp4"));
    for (let i = 0; i < files.length; i++) await ff.writeFile(names[i], await fetchFile(files[i]));
    const out = tmp("mp4");
    const w = size.w - (size.w % 2);
    const h = size.h - (size.h % 2);
    const args: string[] = [];
    pieces.forEach((p) => args.push("-ss", p.start.toFixed(3), "-t", (p.end - p.start).toFixed(3), "-i", names[p.file]));
    if (audio) args.push("-ss", audio.start.toFixed(3), "-t", (audio.end - audio.start).toFixed(3), "-i", names[0]);
    const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p`;
    let graph = "";
    pieces.forEach((_, i) => (graph += `[${i}:v]setpts=PTS-STARTPTS,${vf}[v${i}];`));
    graph += pieces.map((_, i) => `[v${i}]`).join("") + `concat=n=${pieces.length}:v=1:a=0[v]`;
    const total = pieces.reduce((t, p) => t + p.end - p.start, 0);
    const code = await execTimed(
      ff,
      [
        ...args,
        "-filter_complex", graph,
        "-map", "[v]",
        ...(audio ? ["-map", `${pieces.length}:a:0?`, "-c:a", "aac", "-b:a", "192k", "-shortest"] : []),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-movflags", "+faststart", "-y", out,
      ],
      total,
      onProgress,
    );
    try {
      if (code !== 0) throw new Error("Assembly failed (ffmpeg exit " + code + ")");
      const data = (await ff.readFile(out)) as Uint8Array;
      return new File([data.slice().buffer as ArrayBuffer], "assembled.mp4", { type: "video/mp4" });
    } finally {
      for (const n of [...names, out]) await ff.deleteFile(n).catch(() => {});
    }
  });
}

// Codec and frame rate from the container, as ffmpeg reports them.
export async function probeVideo(file: Blob): Promise<{ codec: string | null; fps: number | null }> {
  return exclusive(async () => {
    const ff = await load();
    let codec: string | null = null;
    let fps: number | null = null;
    const onLog = ({ message }: { message: string }) => {
      if (!/Stream #\d+:\d+.*Video:/.test(message)) return;
      const c = /Video: ([a-z0-9_]+)/i.exec(message);
      if (c && !codec) codec = c[1].toLowerCase();
      const f = /([\d.]+) fps/.exec(message) ?? /([\d.]+) tbr/.exec(message);
      if (f && !fps) fps = parseFloat(f[1]);
    };
    ff.on("log", onLog);
    const name = tmp("bin");
    try {
      await ff.writeFile(name, await fetchFile(file));
      await ff.exec(["-i", name, "-f", "null", "-t", "0.01", "-"]).catch(() => {});
    } finally {
      ff.off("log", onLog);
      await ff.deleteFile(name).catch(() => {});
    }
    // 23.98 -> 23.976, 29.97 stays.
    if (fps && Math.abs(fps - 23.98) < 0.01) fps = 24000 / 1001;
    if (fps && Math.abs(fps - 29.97) < 0.01) fps = 30000 / 1001;
    if (fps && Math.abs(fps - 59.94) < 0.01) fps = 60000 / 1001;
    return { codec, fps };
  });
}
