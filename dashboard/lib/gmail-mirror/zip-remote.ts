// Dependency-free random-access ZIP reader over HTTP Range requests. Purpose: pull the single
// large .mbox entry straight out of a Google Takeout .zip in Drive WITHOUT downloading the whole
// archive or ever unzipping it to disk. We read the ZIP's End-Of-Central-Directory + central
// directory (a few KB at the tail), locate the .mbox entry, then stream ONLY that entry's
// compressed bytes and inflate them on the fly.
//
// Scope/assumptions (fine for a Takeout Mail zip): the archive is < 4 GB, so the central-directory
// offset and each entry's COMPRESSED size + local-header offset fit in 32 bits (no ZIP64 for those
// fields — an entry's uncompressed size may exceed 4 GB and live in a ZIP64 extra, but we never need
// it since we stream-inflate). Only stored (0) and deflate (8) methods are supported (what Takeout uses).

import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

export type RangeReader = (start: number, endInclusive: number) => Promise<Buffer>;
export type RangeStreamer = (start: number, endInclusive: number) => Promise<Readable>;
export type ZipEntry = { name: string; method: number; compSize: number; localOffset: number };

const EOCD_SIG = 0x06054b50; // PK\x05\x06
const CEN_SIG = 0x02014b50;  // PK\x01\x02
const LOC_SIG = 0x04034b50;  // PK\x03\x04

// Parse the central directory → every entry's name, method, compressed size, and local offset.
export async function listZipEntries(size: number, readRange: RangeReader): Promise<ZipEntry[]> {
  const tailLen = Math.min(size, 65557); // 22-byte EOCD + up to 65535-byte comment
  const tail = await readRange(size - tailLen, size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) { if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; } }
  if (eocd < 0) throw new Error("ZIP: End-Of-Central-Directory not found (not a zip, or truncated)");
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error("ZIP: ZIP64 central directory not supported");

  const cd = await readRange(cdOffset, cdOffset + cdSize - 1);
  const entries: ZipEntry[] = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CEN_SIG) {
    const method = cd.readUInt16LE(p + 10);
    const compSize = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Stream one entry's DECOMPRESSED bytes. Reads the entry's local header first (its name/extra
// lengths can differ from the central directory's) to find the true data start.
export async function openZipEntryStream(entry: ZipEntry, readRange: RangeReader, streamRange: RangeStreamer): Promise<Readable> {
  const loc = await readRange(entry.localOffset, entry.localOffset + 29);
  if (loc.readUInt32LE(0) !== LOC_SIG) throw new Error("ZIP: local file header signature mismatch");
  const nameLen = loc.readUInt16LE(26);
  const extraLen = loc.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const raw = await streamRange(dataStart, dataStart + entry.compSize - 1);
  if (entry.method === 0) return raw;                    // stored (no compression)
  if (entry.method === 8) return raw.pipe(createInflateRaw()); // deflate (ZIP uses raw deflate)
  throw new Error(`ZIP: unsupported compression method ${entry.method}`);
}

// Pick the mailbox .mbox entry — the largest .mbox (Takeout's "All mail…" file is the big one).
export function pickMboxEntry(entries: ZipEntry[]): ZipEntry | null {
  const mboxes = entries.filter((e) => /\.mbox$/i.test(e.name)).sort((a, b) => b.compSize - a.compSize);
  return mboxes[0] || null;
}
