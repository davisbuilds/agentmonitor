// Tool Analytics - tool usage breakdown section
const ToolAnalytics = {
  data: null,

  formatNumber(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString();
  },

  async load(filters) {
    try {
      const qs = new URLSearchParams(filters || {}).toString();
      const res = await fetch(`/api/stats/tools${qs ? '?' + qs : ''}`);
      this.data = await res.json();
      this.render();
    } catch (err) {
      console.error('Failed to load tool analytics:', err);
    }
  },

  render() {
    const container = document.getElementById('tool-analytics');
    if (!container || !this.data) return;

    const { tools } = this.data;

    if (!tools || tools.length === 0) {
      container.innerHTML = '<div class="text-xs text-gray-500 py-4 text-center">No tool data yet</div>';
      return;
    }

    const maxCalls = Math.max(...tools.map(t => t.total_calls), 1);

    container.innerHTML = `
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="text-gray-500 uppercase tracking-wider text-left border-b border-gray-800">
              <th class="pb-2 pr-4">Tool</th>
              <th class="pb-2 pr-4 text-right">Calls</th>
              <th class="pb-2 pr-4 w-1/3">Frequency</th>
              <th class="pb-2 pr-4 text-right">Errors</th>
              <th class="pb-2 pr-4 text-right">Error Rate</th>
              <th class="pb-2 text-right">Avg Duration</th>
            </tr>
          </thead>
          <tbody>
            ${tools.map(t => this.renderRow(t, maxCalls)).join('')}
          </tbody>
        </table>
      </div>
    `;
  },

  renderRow(tool, maxCalls) {
    const pct = (tool.total_calls / maxCalls) * 100;
    const errColor = tool.error_rate > 0.1 ? 'text-red-400' : tool.error_rate > 0 ? 'text-yellow-400' : 'text-gray-500';
    const duration = tool.avg_duration_ms != null ? `${Math.round(tool.avg_duration_ms)}ms` : '-';

    return `
      <tr class="border-b border-gray-800/50 hover:bg-gray-800/30">
        <td class="py-1.5 pr-4 text-gray-200 font-medium">${tool.tool_name}</td>
        <td class="py-1.5 pr-4 text-right text-gray-300">${this.formatNumber(tool.total_calls)}</td>
        <td class="py-1.5 pr-4">
          <div class="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div class="h-full bg-emerald-500 rounded-full" style="width:${Math.max(2, pct)}%"></div>
          </div>
        </td>
        <td class="py-1.5 pr-4 text-right ${errColor}">${tool.error_count}</td>
        <td class="py-1.5 pr-4 text-right ${errColor}">${(tool.error_rate * 100).toFixed(1)}%</td>
        <td class="py-1.5 text-right text-gray-400">${duration}</td>
      </tr>
    `;
  },
};
