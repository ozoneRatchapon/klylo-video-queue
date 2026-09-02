import { ALLOWED_IMAGE_TYPES } from "@/lib/types";

type allowed_image_type = (typeof ALLOWED_IMAGE_TYPES)[number];

/** Longest signature below, so this is all we ever need to read. */
const SIGNATURE_BYTES = 8;

const SIGNATURES: ReadonlyArray<{ type: allowed_image_type; bytes: readonly number[] }> = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
];

/**
 * Identifies a file by its leading bytes rather than the `type` the browser
 * reports, which is derived from the extension and is trivially forged.
 *
 * This is defence in depth, not enforcement: the upload goes straight from the
 * browser to Storage, so anyone driving the anon key by hand skips it entirely.
 * What actually contains a mislabelled file is that the bucket is private, its
 * objects are only ever handed out as signed URLs, and the CSP does not allow
 * the Supabase origin as a script source.
 *
 * Returns `null` when the bytes match no allowed format.
 */
export async function sniff_image_type(file: File): Promise<allowed_image_type | null> {
  const header = new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer());

  const match = SIGNATURES.find(
    ({ bytes }) =>
      header.length >= bytes.length && bytes.every((byte, index) => header[index] === byte),
  );

  return match?.type ?? null;
}
