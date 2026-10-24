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

// Cut [start, end] out of a video. Re-encodes video for frame-accurate edges,
// keeps the audio. Returns an MP4 file.
export async function trimVideo(
  file: File,
  start: number,
  end: number,
  onProgress?: (ratio: number) => void,
  onStage?: (stage: "engine" | "cut" | "copy") => void,
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
      // The wasm build has no HEVC decoder (iPhone footage). Fall back to a stream
      // copy, which needs no decoding; edges land on the nearest keyframes.
      onStage?.("copy");
      const copy = await ff.exec([
        "-ss", start.toFixed(3),
        "-to", end.toFixed(3),
        "-i", "in",
        "-c", "copy",
        "-movflags", "+faststart",
        "-y", "out.mp4",
      ]);
      if (copy !== 0) throw new Error("This clip's codec can't be cut in the browser. Export it as H.264 MP4 and try again.");
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
