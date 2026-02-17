// Stats bar - compact header counters
const StatsBar = {
  state: {
    total_events: 0,
    active_sessions: 0,
    total_tokens_in: 0,
    total_tokens_out: 0,
    agent_breakdown: {},
  },

  formatNumber(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString();
  },

  update(stats) {
    Object.assign(this.state, stats);
    this.render();
  },

  incrementEvent(event) {
    this.state.total_events++;
    this.state.total_tokens_in += event.tokens_in || 0;
    this.state.total_tokens_out += event.tokens_out || 0;
    this.render();
  },

  render() {
    const s = this.state;
    document.getElementById('stat-events').textContent = this.formatNumber(s.total_events);
    document.getElementById('stat-sessions').textContent = s.active_sessions;
    document.getElementById('stat-agents').textContent = Object.keys(s.agent_breakdown || {}).length || 0;
    document.getElementById('stat-tokens-in').textContent = this.formatNumber(s.total_tokens_in);
    document.getElementById('stat-tokens-out').textContent = this.formatNumber(s.total_tokens_out);
  },
};
