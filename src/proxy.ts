import { NextRequest, NextResponse } from "next/server";

// The landing page is public; the engine (studio, chapters, APIs) sits behind HTTP basic
// auth when APP_PASSWORD is set (Next 16 proxy).
const PUBLIC = (path: string) => path === "/" || path.startsWith("/brand/") || path.startsWith("/models/") || path === "/icon.png" || path === "/apple-icon.png";

export function proxy(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password || PUBLIC(req.nextUrl.pathname)) return NextResponse.next();

  const header = req.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [, pass] = atob(encoded).split(":");
    if (pass === password) return NextResponse.next();
  }
  return new NextResponse("Auth required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="getmotion"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
