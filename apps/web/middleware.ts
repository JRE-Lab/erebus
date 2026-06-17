// ============================================================================
// Basic-auth gate for the whole app. No-op when EREBUS_PASS is unset (local
// dev / open deploy). Static assets and favicon are always skipped so the
// browser can paint the login challenge cleanly.
// ============================================================================
import { NextResponse, type NextRequest } from "next/server";

export const config = {
  // Run on everything except Next internals + favicon. The function below
  // double-guards in case the matcher and runtime ever drift.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="EREBUS", charset="UTF-8"' },
  });
}

export function middleware(req: NextRequest): NextResponse {
  const pass = process.env.EREBUS_PASS;
  // Auth disabled unless a password is configured.
  if (!pass) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (
    pathname.startsWith("/_next/static") ||
    pathname.startsWith("/_next/image") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const user = process.env.EREBUS_USER || "erebus";
  const header = req.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    const decoded = decodeBase64(header.slice(6));
    const idx = decoded.indexOf(":");
    const u = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const p = idx >= 0 ? decoded.slice(idx + 1) : "";
    if (u === user && p === pass) return NextResponse.next();
  }

  return unauthorized();
}

// Edge-runtime-safe base64 decode (atob exists on the edge; Buffer fallback).
function decodeBase64(b64: string): string {
  try {
    if (typeof atob === "function") return atob(b64);
  } catch {
    /* fall through */
  }
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}
