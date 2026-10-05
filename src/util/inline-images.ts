import { createHash } from 'node:crypto';

// Base64 shorter than this (under ~190 bytes of image) is not worth a descriptor.
const MIN_BASE64_CHARS = 256;

// A base64 image source (`"type":"base64"`, optional `media_type`, then `data`),
// at any JSON-escaping depth: group 2 captures the backslashes in front of each
// quote so the whole object must share them. Covers Claude image blocks, also
// when a tool result carries them inside a serialized string.
const BASE64_SOURCE = new RegExp(
  String.raw`((\\*)"type\2":\s*\2"base64\2",(?:\s*\2"media_type\2":\s*\2"[^"\\]*\2",)?\s*\2"data\2":\s*\2")`
  + String.raw`([A-Za-z0-9+/]{${MIN_BASE64_CHARS},}={0,2})`,
  'g',
);
const DATA_URI = new RegExp(String.raw`(data:image/[a-z0-9.+-]+;)base64,([A-Za-z0-9+/]{${MIN_BASE64_CHARS},}={0,2})`, 'gi');

function describe(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  return `omitted-image;sha256=${createHash('sha256').update(bytes).digest('hex')};bytes=${bytes.length}`;
}

/**
 * Replace inline base64 image data in serialized transcript JSON with a short
 * descriptor carrying the image's SHA-256 and size. Nothing renders stored
 * images, and their base64 inflates the store and the search index. The image
 * survives only in the source transcript, if that still exists. The result
 * stays valid JSON at every escaping depth, and stripping twice changes nothing.
 */
export function stripInlineImages(json: string): string {
  if (!json.includes('base64')) return json;
  return json
    .replace(BASE64_SOURCE, (_match, prefix: string, _escapes: string, data: string) => prefix + describe(data))
    .replace(DATA_URI, (_match, prefix: string, data: string) => prefix + describe(data));
}
