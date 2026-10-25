import { fal } from "@fal-ai/client";

// A render that has been submitted and paid for. Saved the moment the provider
// hands back an id, so a network blip or a reload never loses it.
export type PendingJob = {
  provider: "fal" | "sume";
  endpoint: string;
  requestId: string;
  model: string;
  at: number;
};

const KEY = "getmotion.jobs";

export function loadJobs(): PendingJob[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}
function saveJobs(jobs: PendingJob[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(jobs));
  } catch {}
}
export function addJob(job: PendingJob) {
  saveJobs([...loadJobs().filter((j) => j.requestId !== job.requestId), job]);
}
export function removeJob(requestId: string) {
  saveJobs(loadJobs().filter((j) => j.requestId !== requestId));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isNetwork = (e: unknown) =>
  e instanceof TypeError || /failed to fetch|network|load failed|timeout/i.test(String(e));

// Poll until the job finishes. Network errors are retried for up to `maxWaitMs`;
// provider errors (4xx/5xx) are thrown.
export async function waitForFal(
  job: PendingJob,
  onStatus: (s: string) => void,
  maxWaitMs = 45 * 60_000,
): Promise<string> {
  const started = Date.now();
  let delay = 1500;
  for (;;) {
    try {
      const st = await fal.queue.status(job.endpoint, { requestId: job.requestId, logs: true });
      const last = "logs" in st && st.logs?.length ? st.logs[st.logs.length - 1].message : "";
      const pos = "queue_position" in st && typeof st.queue_position === "number" ? ` · #${st.queue_position} in queue` : "";
      onStatus(`${st.status}${pos}${last ? " · " + last : ""}`);
      if (st.status === "COMPLETED") break;
      delay = 1500;
    } catch (e) {
      if (!isNetwork(e)) throw e;
      if (Date.now() - started > maxWaitMs) throw new Error("Gave up waiting: network kept failing. The job is still on fal; check the Requests page.");
      onStatus(`Connection lost, retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      delay = Math.min(15_000, delay * 1.6);
      continue;
    }
    await sleep(delay);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fal.queue.result(job.endpoint, { requestId: job.requestId });
      const url = (res.data as { video?: { url?: string } })?.video?.url;
      if (!url) throw new Error(`No video in result: ${JSON.stringify(res.data).slice(0, 200)}`);
      return url;
    } catch (e) {
      if (!isNetwork(e) || attempt > 20) throw e;
      await sleep(3000);
    }
  }
}

// The provider behind fal is sometimes briefly down (502/503/504, "downstream service
// unavailable"). Nothing is charged for those, so retry a few times before failing.
export const transientError = (e: unknown) => {
  const o = e as { status?: number; body?: unknown };
  return [502, 503, 504].includes(o?.status ?? 0) || /downstream_service_unavailable|timeout/i.test(JSON.stringify(o?.body ?? "") + String(e));
};

export async function submitFal(
  endpoint: string,
  model: string,
  input: Record<string, unknown>,
  onRetry?: (attempt: number) => void,
): Promise<PendingJob> {
  let request_id = "";
  for (let attempt = 1; ; attempt++) {
    try {
      request_id = (await fal.queue.submit(endpoint, { input })).request_id;
      break;
    } catch (e) {
      if (!transientError(e) || attempt >= 4) throw e;
      onRetry?.(attempt);
      await sleep(4000 * attempt);
    }
  }
  const job: PendingJob = { provider: "fal", endpoint, requestId: request_id, model, at: Date.now() };
  addJob(job);
  return job;
}

// Sume: submit through our server routes, poll with the same retry policy.
export async function submitSume(model: string, modelName: string, input: Record<string, unknown>): Promise<PendingJob> {
  const sub = await fetch("/api/sume/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, ...input }),
  }).then((r) => r.json());
  const id = sub.request_id ?? sub.id ?? sub.job_id;
  if (!id) throw new Error(`Sume: ${JSON.stringify(sub)}`);
  const job: PendingJob = { provider: "sume", endpoint: model, requestId: id, model: modelName, at: Date.now() };
  addJob(job);
  return job;
}

export async function waitForSume(job: PendingJob, onStatus: (s: string) => void, maxWaitMs = 45 * 60_000): Promise<string> {
  const started = Date.now();
  let delay = 4000;
  for (;;) {
    try {
      const st = await fetch(`/api/sume/job/${job.requestId}?part=status`).then((r) => r.json());
      const status = String(st.sume_status ?? st.status ?? "");
      onStatus(status);
      if (st.terminal || ["completed", "failed", "canceled"].includes(status)) {
        if (status !== "completed") throw new Error(`Sume job ${status}: ${JSON.stringify(st)}`);
        break;
      }
      delay = (st.next_poll_after_seconds ?? 4) * 1000;
    } catch (e) {
      if (!isNetwork(e)) throw e;
      if (Date.now() - started > maxWaitMs) throw new Error("Gave up waiting: network kept failing. The job is still on Sume.");
      onStatus("Connection lost, retrying");
      delay = 5000;
    }
    await sleep(delay);
  }
  const res = await fetch(`/api/sume/job/${job.requestId}?part=result`).then((r) => r.json());
  const url = (res.result ?? res).artifacts?.find((a: { url: string }) => a.url)?.url;
  if (!url) throw new Error(`Sume result: ${JSON.stringify(res)}`);
  return url as string;
}

export class Cancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

export function waitFor(job: PendingJob, onStatus: (s: string) => void, stop?: () => boolean) {
  // A cancelled part stops polling at the next status update.
  const status = (s: string) => {
    if (stop?.()) throw new Cancelled();
    onStatus(s);
  };
  return job.provider === "fal" ? waitForFal(job, status) : waitForSume(job, status);
}
