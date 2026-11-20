import fs from 'fs';
import path from 'path';
import { zstdDecompressSync } from 'zlib';

/** Codex compresses a finished rollout to `<name>.jsonl.zst`; both forms are one rollout. */
export const COMPRESSED_ROLLOUT_SUFFIX = '.jsonl.zst';

/** A transcript's bytes, decompressed when the file is a compressed rollout. */
export function readTranscriptFile(filePath: string, maxBytes?: number): Buffer {
  if (maxBytes !== undefined) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Transcript exceeds read budget or is not a regular file');
  }
  const bytes = fs.readFileSync(filePath);
  if (maxBytes !== undefined && bytes.length > maxBytes) throw new Error('Transcript exceeds read budget');
  return filePath.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
    ? zstdDecompressSync(bytes, { maxOutputLength: maxBytes })
    : bytes;
}

/** A transcript's name without its extension, which is its session id, compressed or not. */
export function transcriptBaseName(filePath: string): string {
  const name = path.basename(filePath);
  return name.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
    ? name.slice(0, -COMPRESSED_ROLLOUT_SUFFIX.length)
    : path.basename(name, '.jsonl');
}
