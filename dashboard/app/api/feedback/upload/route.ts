// Upload a screenshot for a feature request → its public URL. Any logged-in user. Reuses the
// deal-attachments public bucket (image-only, ≤10MB). multipart form field `file`.
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { uploadDealImage } from "@/lib/deals/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const att = await uploadDealImage("feedback", { bytes, name: file.name, type: file.type });
    return NextResponse.json({ ok: true, attachment: att });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 400 });
  }
}
