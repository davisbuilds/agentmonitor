// Usage Monitor - Provider-native quota snapshots for Claude and Codex
const UsageMonitor = {
  container: null,
  data: null,
  countdownTimer: null,

  init() {
    this.container = document.getElementById('usage-monitor');
    if (!this.container) return;
    this.fetch();
    this.countdownTimer = setInterval(() => this.renderCountdowns(), 60_000);
  },

  async fetch() {
    try {
      const res = await fetch('/api/stats/usage-monitor');
      this.data = await res.json();
      this.render();
    } catch (err) {
      console.error('Usage monitor fetch error:', err);
    }
  },

  update(quotaMonitor) {
    if (!quotaMonitor) return;
    this.data = quotaMonitor;
    this.render();
  },

  render() {
    if (!this.container || !Array.isArray(this.data)) return;

    if (this.data.length === 0) {
      this.container.classList.add('hidden');
      return;
    }

    this.container.classList.remove('hidden');

    let html = '<div class="flex items-center gap-6 flex-wrap">';

    for (const row of this.data) {
      const label = this.providerLabel(row);
      const windows = this.windows(row);

      if (row.status === 'available' && windows.length > 0) {
        for (let index = 0; index < windows.length; index += 1) {
          const window = windows[index];
          html += this.renderWindow(label, row.provider, index, window);
        }
        continue;
      }

      html += this.renderUnavailable(label, row);
    }

    html += '</div>';
    this.container.innerHTML = html;
    this.renderCountdowns();
  },

  renderWindow(label, provider, index, window) {
    const pct = Math.max(0, Math.min(window.used_percent || 0, 100));
    const color = this.barColor(pct);
    const remaining = this.percentLabel(window);
    const windowLabel = this.windowLabel(window);
    const resetLabel = this.resetLabel(window.resets_at);

    return `
      <div class="flex items-center gap-3 min-w-0 flex-1" style="min-width:220px;max-width:440px">
        <span class="text-xs text-gray-400 shrink-0">${label}</span>
        <span class="text-xs text-gray-500 shrink-0">${windowLabel}</span>
        <div class="flex-1 min-w-0">
          <div class="h-2 bg-gray-800 rounded-full overflow-hidden">
            <div class="${color} h-full rounded-full transition-all duration-500" style="width:${pct.toFixed(1)}%"></div>
          </div>
        </div>
        <span class="text-xs text-gray-300 tabular-nums shrink-0">${remaining}</span>
        <span class="text-xs text-gray-500 shrink-0" data-reset-id="${provider}-${index}" data-reset-at="${window.resets_at || ''}">${resetLabel}</span>
      </div>`;
  },

  renderUnavailable(label, row) {
    return `
      <div class="flex items-center gap-3 min-w-0 flex-1" style="min-width:220px;max-width:440px">
        <span class="text-xs text-gray-400 shrink-0">${label}</span>
        <span class="text-xs text-gray-500 truncate">${this.unavailableCopy(row)}</span>
      </div>`;
  },

  renderCountdowns() {
    if (!this.container) return;

    const labels = this.container.querySelectorAll('[data-reset-at]');
    for (const label of labels) {
      const resetAt = label.getAttribute('data-reset-at');
      label.textContent = this.resetLabel(resetAt);
    }
  },

  providerLabel(row) {
    return row.provider === 'claude' ? 'Claude' : 'Codex';
  },

  windows(row) {
    return [row.primary, row.secondary].filter(Boolean);
  },

  windowLabel(window) {
    const minutes = Number(window.window_minutes || 0);
    if (minutes === 300) return '5h';
    if (minutes === 10080) return '1w';
    if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  },

  percentLabel(window) {
    const remaining = Number.isFinite(window.remaining_percent)
      ? window.remaining_percent
      : Math.max(0, 100 - Number(window.used_percent || 0));
    return `${Math.round(remaining)}% left`;
  },

  barColor(usedPercent) {
    if (usedPercent >= 85) return 'bg-red-500';
    if (usedPercent >= 60) return 'bg-yellow-500';
    return 'bg-emerald-500';
  },

  resetLabel(value) {
    if (!value) return 'reset unavailable';

    const resetAt = new Date(value);
    if (Number.isNaN(resetAt.getTime())) return 'reset unavailable';

    const msRemaining = resetAt.getTime() - Date.now();
    if (msRemaining <= 0) return 'resetting';
    if (msRemaining < 60 * 60 * 1000) return `resets in ${Math.ceil(msRemaining / 60000)}m`;
    if (msRemaining < 24 * 60 * 60 * 1000) {
      return `resets ${resetAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()}`;
    }
    return `resets ${resetAt.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  },

  unavailableCopy(row) {
    if (row.status === 'error') return row.error_message || 'quota unavailable';
    return row.provider === 'claude' ? 'statusline bridge needed' : 'native quota unavailable';
  },
};
