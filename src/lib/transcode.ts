// Re-record a clip through the browser's own decoder (handles HEVC from iPhones,
// which ffmpeg.wasm can't decode) into H.264 MP4 or WebM, both of which fal reads.
// Runs in real time: a 15 s clip takes 15 s.

const MIME_PREFS = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  "video/mp4",
  'video/webm;codecs="h264,opus"',
  'video/webm;codecs="vp9,opus"',
  "video/webm",
];

export function canTranscode() {
  return typeof MediaRecorder !== "undefined" && MIME_PREFS.some((m) => MediaRecorder.isTypeSupported(m));
}

export async function transcodeInBrowser(
  file: Blob,
  onProgress?: (ratio: number) => void,
  window?: { start: number; end: number },
): Promise<File> {
  const mime = MIME_PREFS.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error("This browser can't re-encode video. Export the clip as H.264 MP4.");

  const v = document.createElement("video");
  v.src = URL.createObjectURL(file);
  v.muted = true; // element volume; the captured stream still carries audio
  v.playsInline = true;
  await new Promise<void>((res, rej) => {
    v.onloadedmetadata = () => res();
    v.onerror = () => rej(new Error("Browser can't play this clip either."));
  });

  type Capturable = HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
  const el = v as Capturable;
  const stream = (el.captureStream ?? el.mozCaptureStream)?.call(v);
  if (!stream) throw new Error("captureStream unsupported in this browser.");

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((res) => (rec.onstop = () => res()));

  const start = window?.start ?? 0;
  const end = Math.min(window?.end ?? v.duration, v.duration);
  const stop = () => {
    if (rec.state !== "inactive") rec.stop();
    v.pause();
  };
  const tick = () => {
    onProgress?.(Math.max(0, Math.min(1, (v.currentTime - start) / (end - start || 1))));
    if (v.currentTime >= end - 0.02) stop();
  };
  // Poll faster than timeupdate so the end lands within a frame or two.
  const poll = setInterval(tick, 16);
  v.onended = stop;

  if (start > 0) {
    await new Promise<void>((res) => {
      v.onseeked = () => res();
      v.currentTime = start;
    });
  }
  rec.start(500);
  await v.play();
  await done;
  clearInterval(poll);
  URL.revokeObjectURL(v.src);

  const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
  const base = (file instanceof File ? file.name : "clip").replace(/\.[^.]+$/, "");
  return new File(chunks, `${base}-h264.${ext}`, { type: mime.split(";")[0] });
}
