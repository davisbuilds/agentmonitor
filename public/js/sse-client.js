// SSE Client - EventSource with auto-reconnect and status indicator
const SSEClient = {
  source: null,
  reconnectDelay: 1000,
  maxReconnectDelay: 30000,
  reconnectTimer: null,

  connect() {
    if (this.source) {
      this.source.close();
    }

    this.setStatus('connecting');
    this.source = new EventSource('/api/stream');

    this.source.onopen = () => {
      this.reconnectDelay = 1000;
      this.setStatus('connected');
    };

    this.source.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        this.dispatch(msg);
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    this.source.onerror = () => {
      this.source.close();
      this.setStatus('disconnected');
      this.scheduleReconnect();
    };
  },

  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  },

  dispatch(msg) {
    switch (msg.type) {
      case 'connected':
        break;
      case 'event':
        EventFeed.addEvent(msg.payload);
        AgentCards.handleEvent(msg.payload);
        StatsBar.incrementEvent(msg.payload);
        break;
      case 'stats':
        StatsBar.update(msg.payload);
        break;
      case 'session_update':
        AgentCards.handleSessionUpdate(msg.payload);
        break;
    }
  },

  setStatus(status) {
    const dot = document.getElementById('connection-dot');
    const text = document.getElementById('connection-text');

    switch (status) {
      case 'connected':
        dot.className = 'w-2 h-2 rounded-full bg-green-400';
        text.textContent = 'Connected';
        text.className = 'text-green-400';
        break;
      case 'connecting':
        dot.className = 'w-2 h-2 rounded-full bg-yellow-400 animate-pulse';
        text.textContent = 'Connecting...';
        text.className = 'text-yellow-400';
        break;
      case 'disconnected':
        dot.className = 'w-2 h-2 rounded-full bg-red-400';
        text.textContent = 'Disconnected';
        text.className = 'text-red-400';
        break;
    }
  },

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.source) this.source.close();
  },
};
