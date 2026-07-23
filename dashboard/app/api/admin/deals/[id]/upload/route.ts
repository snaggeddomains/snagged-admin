// Upload an image attachment for a deal comment. Multipart POST (field "file"). Gated the
// same as the deal itself; returns the stored image's public URL to embed in a comment.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan, userCanAction, type AppUser } from "@/lib/permissions";
import { getDeal, type Deal } from "@/lib/deals/store";
import { uploadDealImage, attachmentsConfigured } from "@/lib/deals/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function mayTouch(me: AppUser, deal: Deal): boolean {
  if (me.is_admin || userCanAction(me, "deals.all")) return true;
  if (deal.owner_email) return deal.owner_email.toLowerCase() === me.email.toLowerCase();
  return userCanAction(me, "deals.inbox");
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "deals") && !userCanAction(me, "deals.all")) return NextResponse.json({ error: "No access" }, { status: 403 });
  if (!attachmentsConfigured()) return NextResponse.json({ error: "Storage not configured" }, { status: 503 });
  const deal = await getDeal(params.id);
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!mayTouch(me, deal)) return NextResponse.json({ error: "No access to this deal" }, { status: 403 });

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const att = await uploadDealImage(deal.id, { bytes, name: file.name, type: file.type });
    return NextResponse.json({ ok: true, attachment: att });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 400 });
  }
}
