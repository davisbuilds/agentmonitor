// App initialization - fetch initial data and connect SSE
(async function init() {
  EventFeed.init();

  try {
    // Fetch initial data in parallel
    const [statsRes, eventsRes, sessionsRes] = await Promise.all([
      fetch('/api/stats'),
      fetch('/api/events?limit=100'),
      fetch('/api/sessions?limit=20'),
    ]);

    const [stats, eventsData, sessionsData] = await Promise.all([
      statsRes.json(),
      eventsRes.json(),
      sessionsRes.json(),
    ]);

    // Initialize components with data
    StatsBar.update(stats);
    EventFeed.initFromData(eventsData.events || []);
    AgentCards.initFromData(sessionsData.sessions || [], eventsData.events || []);

  } catch (err) {
    console.error('Failed to fetch initial data:', err);
  }

  // Connect SSE for live updates
  SSEClient.connect();
})();
