// Public image proxy: returns the domain's listing logo (the marketplace
// og:image) with its padding trimmed, for embedding in the client activity Doc.
// Public by design (no session) — Google fetches it during Doc import; it only
// ever returns a trimmed copy of an already-public marketing image. Excluded from
// the auth middleware (see middleware.ts matcher).

import { type NextRequest } from "next/server";
import { trimPng } from "@/lib/client-report-doc";

export const runtime = "nodejs";

const slug = (d: string) => d.toLowerCase().replace(/[^a-z0-9.-]/g, "").replace(/\./g, "-");

export async function GET(req: NextRequest) {
  const domain = (req.nextUrl.searchParams.get("domain") || "").toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) {
    return new Response("bad domain", { status: 400 });
  }
  try {
    const page = await fetch(`https://www.snagged.com/domains/${slug(domain)}`, { headers: { "user-agent": "Mozilla/5.0 SnaggedReport" } });
    const html = await page.text();
    const og = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
    if (!og?.[1]) return new Response("no image", { status: 404 });
    const imgRes = await fetch(og[1]);
    if (!imgRes.ok) return new Response("fetch failed", { status: 502 });
    const ct = imgRes.headers.get("content-type") || "";
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const out = ct.includes("png") ? trimPng(buf) : buf;
    return new Response(out as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": ct.includes("png") ? "image/png" : (ct || "image/png"),
        "cache-control": "public, max-age=86400, s-maxage=86400",
      },
    });
  } catch (e) {
    return new Response(`error: ${String((e as Error)?.message || e).slice(0, 120)}`, { status: 500 });
  }
}
