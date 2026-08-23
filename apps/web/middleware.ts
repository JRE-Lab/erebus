// ============================================================================
// Basic-auth gate for the whole app. Deep-review hardening:
//  - FAIL CLOSED: a missing EREBUS_PASS returns 503 instead of silently
//    disabling auth on a public deploy (set EREBUS_ALLOW_NO_AUTH=1 for local dev).
//  - Constant-time credential comparison (no timing side channel).
//  - Cross-site write requests are rejected (CSRF: browsers replay cached
//    Basic credentials on cross-site form POSTs, and every POST here can spend).
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

// Constant-time string comparison (edge-safe; no node:crypto dependency).
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function middleware(req: NextRequest): NextResponse {
  const pass = process.env.EREBUS_PASS;
  if (!pass) {
    // Fail closed — an unset password must never mean an open dashboard.
    if (process.env.EREBUS_ALLOW_NO_AUTH === "1") return NextResponse.next();
    return new NextResponse("Server misconfigured: EREBUS_PASS is not set.", { status: 503 });
  }

  const { pathname } = req.nextUrl;
  if (
    pathname.startsWith("/_next/static") ||
    pathname.startsWith("/_next/image") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  // CSRF: reject cross-site non-GET requests outright. Same-origin fetches and
  // direct tools (curl sends no Sec-Fetch-Site) are unaffected.
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const site = req.headers.get("sec-fetch-site");
    if (site === "cross-site") {
      return new NextResponse("Cross-site requests are not allowed.", { status: 403 });
    }
  }

  const user = process.env.EREBUS_USER || "erebus";
  const header = req.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    const decoded = decodeBase64(header.slice(6));
    const idx = decoded.indexOf(":");
    const u = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const p = idx >= 0 ? decoded.slice(idx + 1) : "";
    // Bitwise & (not &&) so both comparisons always run — constant time.
    if ((safeEqual(u, user) ? 1 : 0) & (safeEqual(p, pass) ? 1 : 0)) {
      return NextResponse.next();
    }
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
