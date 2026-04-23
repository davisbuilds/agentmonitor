import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';

class FakeClassList {
  private readonly classes = new Set<string>(['hidden']);

  add(name: string) {
    this.classes.add(name);
  }

  remove(name: string) {
    this.classes.delete(name);
  }

  contains(name: string) {
    return this.classes.has(name);
  }
}

class FakeContainer {
  classList = new FakeClassList();
  innerHTML = '';

  querySelectorAll(_selector: string) {
    return [];
  }
}

test('legacy usage monitor renders native provider quota snapshots', () => {
  const script = readFileSync(
    path.join(process.cwd(), 'public/js/components/usage-monitor.js'),
    'utf8'
  );

  const container = new FakeContainer();
  const context = {
    console,
    fetch: async () => ({ json: async () => [] }),
    setInterval: () => 1,
    clearInterval: () => {},
    Date,
    document: {
      getElementById(id: string) {
        return id === 'usage-monitor' ? container : null;
      },
    },
  };

  vm.runInNewContext(`${script}\nglobalThis.__usageMonitor = UsageMonitor;`, context);

  const usageMonitor = (context as typeof context & { __usageMonitor: { container: FakeContainer | null; update(data: unknown[]): void } }).__usageMonitor;
  usageMonitor.container = container;

  usageMonitor.update([
    {
      provider: 'claude',
      agent_type: 'claude_code',
      status: 'available',
      primary: {
        used_percent: 5,
        remaining_percent: 95,
        resets_at: '2099-01-01T00:00:00.000Z',
        window_minutes: 300,
      },
      secondary: {
        used_percent: 24,
        remaining_percent: 76,
        resets_at: '2099-01-07T00:00:00.000Z',
        window_minutes: 10080,
      },
    },
    {
      provider: 'codex',
      agent_type: 'codex',
      status: 'unavailable',
      primary: null,
      secondary: null,
    },
  ]);

  assert.equal(container.classList.contains('hidden'), false);
  assert.match(container.innerHTML, /Claude/);
  assert.match(container.innerHTML, /5h/);
  assert.match(container.innerHTML, /95% left/);
  assert.match(container.innerHTML, /1w/);
  assert.match(container.innerHTML, /Codex/);
  assert.match(container.innerHTML, /native quota unavailable/);
});
