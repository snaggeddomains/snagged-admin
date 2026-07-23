// Image attachments for deal comments — stored in a Supabase Storage bucket via the service
// key. The bucket is public (unguessable UUID paths) so an <img src> renders directly in the
// comment thread. Internal CRM only; never exposes deal data beyond the image itself.

import { randomUUID } from "crypto";
import { getDb, isDbConfigured } from "../supabase";

const BUCKET = "deal-attachments";
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic"]);

export type DealAttachment = { url: string; name: string; type: string };

export function attachmentsConfigured(): boolean {
  return isDbConfigured();
}

// Create the public bucket on first use (idempotent — a "already exists" is fine).
async function ensureBucket(): Promise<void> {
  try {
    await getDb().storage.createBucket(BUCKET, { public: true, fileSizeLimit: MAX_BYTES });
  } catch { /* already exists / racing create → ignore */ }
}

const extFor = (type: string, name: string): string => {
  const fromName = (name.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  if (fromName) return fromName.toLowerCase();
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic" } as Record<string, string>)[type] || "bin";
};

// Upload one image for a deal → its public URL. Throws on a too-large / non-image file.
export async function uploadDealImage(dealId: string, file: { bytes: Uint8Array; name: string; type: string }): Promise<DealAttachment> {
  if (!ALLOWED.has(file.type)) throw new Error("Only image files are allowed.");
  if (file.bytes.byteLength > MAX_BYTES) throw new Error("Image is too large (max 10MB).");
  await ensureBucket();
  const path = `${dealId}/${randomUUID()}.${extFor(file.type, file.name)}`;
  const up = await getDb().storage.from(BUCKET).upload(path, file.bytes, { contentType: file.type, upsert: false });
  if (up.error) {
    // Bucket might not have existed on the first race — ensure + retry once.
    await ensureBucket();
    const retry = await getDb().storage.from(BUCKET).upload(path, file.bytes, { contentType: file.type, upsert: false });
    if (retry.error) throw new Error(`upload: ${retry.error.message}`);
  }
  const { data } = getDb().storage.from(BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, name: file.name || "image", type: file.type };
}
