import { unavailable } from './errors.js';
import { writeStdout } from './output.js';
import type { CliContext } from './output.js';

/** Stream SSE data fields as one NDJSON-compatible stdout line each. */
export async function streamSseData(
  ctx: CliContext,
  url: URL,
  shouldWrite: (data: string) => boolean = () => true,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw unavailable(`Cannot reach ${url.toString()}`);
  }
  if (!res.ok || !res.body) {
    throw unavailable(`${url.toString()} returned ${res.status}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  function processLine(line: string): void {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!normalized.startsWith('data: ')) return;
    const data = normalized.slice('data: '.length);
    if (shouldWrite(data)) writeStdout(ctx, data);
  }

  const reader = res.body.getReader();
  try {
    while (true) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch {
        throw unavailable(`Stream from ${url.toString()} failed`);
      }
      if (read.done) break;

      buffer += decoder.decode(read.value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        processLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  buffer += decoder.decode();
  if (buffer) processLine(buffer);
}
