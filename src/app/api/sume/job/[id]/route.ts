import { sumeFetch } from "@/lib/sume";

// ?part=status | result
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const part = new URL(req.url).searchParams.get("part") === "result" ? "result" : "status";
  return sumeFetch(`/jobs/${encodeURIComponent(id)}/${part}`);
}
