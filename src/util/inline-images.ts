import { createHash } from 'node:crypto';

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// An image data URI, media type parameters (`;charset=utf-8`) included.
const DATA_URI = /(data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,"'\s\\]*)*;)base64,([A-Za-z0-9+/]+={0,2})/gi;

function describe(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  return `omitted-image;sha256=${createHash('sha256').update(bytes).digest('hex')};bytes=${bytes.length}`;
}

// Fallback for serialized JSON that no longer parses (truncated, or embedded in
// prose): an image source written `type`, `media_type: image/*`, `data`, at any
// escaping depth (group 2 holds the backslashes before each quote).
const SERIALIZED_IMAGE_SOURCE = new RegExp(
  String.raw`((\\*)"type\2":\s*\2"base64\2",\s*\2"media_type\2":\s*\2"image/[^"\\]*\2",\s*\2"data\2":\s*\2")`
  + String.raw`([A-Za-z0-9+/]+={0,2})`,
  'gi',
);

/** Describe images found textually: data URIs, and serialized sources that no longer parse. */
function describeTextualImages(text: string): string {
  return text
    .replace(DATA_URI, (_match, prefix: string, data: string) => prefix + describe(data))
    .replace(SERIALIZED_IMAGE_SOURCE, (_match, prefix: string, _escapes: string, data: string) => prefix + describe(data));
}

/**
 * A base64 source holding an image: its `media_type` says `image/*`, or it has
 * none and sits in an `image` block. Other base64 (PDF documents, files) stays.
 */
function isImageSource(value: Record<string, unknown>, parentType: unknown): value is Record<string, unknown> & { data: string } {
  if (value['type'] !== 'base64') return false;
  const data = value['data'];
  if (typeof data !== 'string' || !BASE64.test(data)) return false;
  const mediaType = value['media_type'];
  return typeof mediaType === 'string' ? mediaType.toLowerCase().startsWith('image/') : parentType === 'image';
}

const UNCHANGED = Symbol('unchanged');

/** The value with its images described, or UNCHANGED when it holds none. */
function strip(value: unknown, parentType: unknown): unknown {
  if (typeof value === 'string') {
    if (!value.includes('base64')) return UNCHANGED;
    // A tool result can carry its content blocks as serialized JSON.
    let nested: unknown = UNCHANGED;
    const trimmed = value.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        nested = JSON.parse(value);
      } catch {
        // Not JSON after all: handled textually below.
      }
    }
    let text: string;
    if (nested === UNCHANGED) {
      text = describeTextualImages(value);
    } else {
      const inner = strip(nested, null);
      text = inner === UNCHANGED ? value : JSON.stringify(inner);
    }
    return text === value ? UNCHANGED : text;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(item => {
      const next = strip(item, parentType);
      if (next === UNCHANGED) return item;
      changed = true;
      return next;
    });
    return changed ? out : UNCHANGED;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (isImageSource(record, parentType)) return { ...record, data: describe(record.data) };
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      const next = strip(item, record['type']);
      out[key] = next === UNCHANGED ? item : next;
      if (next !== UNCHANGED) changed = true;
    }
    return changed ? out : UNCHANGED;
  }
  return UNCHANGED;
}

/**
 * Replace inline base64 image data in serialized transcript JSON with a short
 * descriptor carrying the image's SHA-256 and size. Nothing renders stored
 * images, and their base64 inflates the store and the search index. The image
 * survives only in the source transcript, if that still exists.
 *
 * Image sources are matched structurally, whatever their property order and at
 * any depth, including JSON serialized inside a string (re-serialized compactly
 * when an image in it is described). Input without an image comes back
 * byte-identical, and stripping twice changes nothing.
 */
export function stripInlineImages(json: string): string {
  if (!json.includes('base64')) return json;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return describeTextualImages(json);
  }
  const out = strip(value, null);
  return out === UNCHANGED ? json : JSON.stringify(out);
}
