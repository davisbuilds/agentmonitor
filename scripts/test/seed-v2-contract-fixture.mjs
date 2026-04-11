import fs from 'node:fs';
import path from 'node:path';

const homeDir = process.env.HOME;

if (!homeDir) {
  throw new Error('HOME is required for seed-v2-contract-fixture');
}

const sessionId = 'parity-v2-canonical-session';
const project = 'parity-v2-canonical-project';
const searchNeedle = 'NeedleCanonicalV2';

function isoOffset(msOffset) {
  return new Date(Date.now() + msOffset).toISOString();
}

function sampleJsonl(lines) {
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

const sessionDir = path.join(
  homeDir,
  '.claude',
  'projects',
  `-Users-parity-Dev-${project}`,
  'nested',
  'sessions',
);

fs.mkdirSync(sessionDir, { recursive: true });

const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
const contents = sampleJsonl([
  {
    type: 'user',
    sessionId,
    cwd: `/Users/parity/Dev/${project}`,
    timestamp: isoOffset(-120_000),
    message: {
      role: 'user',
      content: [{ type: 'text', text: `Investigate ${searchNeedle} in the release notes` }],
    },
  },
  {
    type: 'assistant',
    sessionId,
    cwd: `/Users/parity/Dev/${project}`,
    timestamp: isoOffset(-90_000),
    message: {
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [
        { type: 'thinking', thinking: 'I should inspect the documentation before changing anything.' },
        { type: 'text', text: `Reviewing the ${searchNeedle} references now.` },
        {
          type: 'tool_use',
          id: `toolu_${sessionId}_read`,
          name: 'Read',
          input: { file_path: `/Users/parity/Dev/${project}/README.md` },
        },
      ],
    },
  },
  {
    type: 'user',
    sessionId,
    cwd: `/Users/parity/Dev/${project}`,
    timestamp: isoOffset(-60_000),
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Summarize the findings and call out any risk.' }],
    },
  },
  {
    type: 'assistant',
    sessionId,
    cwd: `/Users/parity/Dev/${project}`,
    timestamp: isoOffset(-30_000),
    message: {
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: `Summary complete for ${searchNeedle}.` }],
    },
  },
]);

fs.writeFileSync(filePath, contents, 'utf8');
