/**
 * Read-only benchmark for the canonical Usage overview endpoint.
 *
 * The first request(s) are reported as warmup samples; the median is calculated
 * only from the measured runs. Pass --max-median-ms to make the command a local
 * acceptance gate.
 */

interface Options {
  baseUrl: string;
  dateFrom?: string;
  dateTo?: string;
  runs: number;
  warmups: number;
  maxMedianMs?: number;
}

interface Sample {
  elapsedMs: number;
  bytes: number;
  matchingEvents: number | null;
  usageEvents: number | null;
}

function readValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readPositiveInteger(args: string[], flag: string, fallback: number): number {
  const raw = readValue(args, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function readNonNegativeInteger(args: string[], flag: string, fallback: number): number {
  const raw = readValue(args, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return value;
}

function parseOptions(args: string[]): Options {
  const maxMedianRaw = readValue(args, '--max-median-ms');
  const maxMedianMs = maxMedianRaw === undefined ? undefined : Number(maxMedianRaw);
  if (maxMedianMs !== undefined && (!Number.isFinite(maxMedianMs) || maxMedianMs <= 0)) {
    throw new Error('--max-median-ms must be a positive number');
  }

  return {
    baseUrl: readValue(args, '--base-url')
      ?? process.env.AGENTMONITOR_BASE_URL
      ?? 'http://127.0.0.1:3141',
    dateFrom: readValue(args, '--date-from'),
    dateTo: readValue(args, '--date-to'),
    runs: readPositiveInteger(args, '--runs', 5),
    warmups: readNonNegativeInteger(args, '--warmups', 1),
    maxMedianMs,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

async function sample(url: URL): Promise<Sample> {
  const startedAt = performance.now();
  const response = await fetch(url);
  const body = await response.text();
  const elapsedMs = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(`Usage overview returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = JSON.parse(body) as {
    coverage?: { matching_events?: number; usage_events?: number };
  };

  return {
    elapsedMs,
    bytes: Buffer.byteLength(body),
    matchingEvents: payload.coverage?.matching_events ?? null,
    usageEvents: payload.coverage?.usage_events ?? null,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const url = new URL('/api/v2/usage/overview', options.baseUrl);
  if (options.dateFrom) url.searchParams.set('date_from', options.dateFrom);
  if (options.dateTo) url.searchParams.set('date_to', options.dateTo);

  const warmupSamples: Sample[] = [];
  for (let i = 0; i < options.warmups; i += 1) {
    warmupSamples.push(await sample(url));
  }

  const measuredSamples: Sample[] = [];
  for (let i = 0; i < options.runs; i += 1) {
    measuredSamples.push(await sample(url));
  }

  const medianMs = median(measuredSamples.map(entry => entry.elapsedMs));
  const representative = measuredSamples.at(-1);
  const result = {
    url: url.toString(),
    warmups_ms: warmupSamples.map(entry => roundMs(entry.elapsedMs)),
    runs_ms: measuredSamples.map(entry => roundMs(entry.elapsedMs)),
    median_ms: roundMs(medianMs),
    max_median_ms: options.maxMedianMs ?? null,
    passed: options.maxMedianMs === undefined || medianMs <= options.maxMedianMs,
    response_bytes: representative?.bytes ?? null,
    matching_events: representative?.matchingEvents ?? null,
    usage_events: representative?.usageEvents ?? null,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
