// Clears the shared dr_auth session cookie (domain-wide) and returns to /login.
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || ".snagged.com";

export async function GET(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/login", req.url));
  res.cookies.set(COOKIE, "", {
    domain: COOKIE_DOMAIN,
    path: "/",
    maxAge: 0,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  });
  return res;
}
