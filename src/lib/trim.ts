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
  off(ev: "progress", cb: (p: Progress) => void): void;
};
declare global {
  interface Window {
    FFmpegWASM?: { FFmpeg: new () => FFmpegLike };
  }
}

let instance: Promise<FFmpegLike> | null = null;

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
): Promise<File> {
  const ff = await load();
  const handler = ({ progress }: Progress) => onProgress?.(Math.max(0, Math.min(1, progress)));
  ff.on("progress", handler);
  try {
    await ff.writeFile("in", await fetchFile(file));
    await ff.exec([
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
    const data = (await ff.readFile("out.mp4")) as Uint8Array;
    const name = file.name.replace(/\.[^.]+$/, "") + `-${start.toFixed(1)}-${end.toFixed(1)}.mp4`;
    return new File([data.slice().buffer as ArrayBuffer], name, { type: "video/mp4" });
  } finally {
    ff.off("progress", handler);
    await ff.deleteFile("in").catch(() => {});
    await ff.deleteFile("out.mp4").catch(() => {});
  }
}
