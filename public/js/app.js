// App initialization - fetch initial data, wire filters, connect SSE
(async function init() {
  EventFeed.init();
  SessionDetail.init();
  UsageMonitor.init();

  // Load filter options and render filter bar
  await FilterBar.init();

  // Wire filter changes to reload all data
  FilterBar.onChange(async (filters) => {
    await reloadData(filters);
  });

  // Initial data load
  await reloadData({});

  // Compact mode toggle
  initCompactMode();

  // Connect SSE for live updates
  SSEClient.connect();
})();

async function reloadData(filters) {
  const qs = new URLSearchParams(filters).toString();
  const qsSep = qs ? '?' + qs : '';

  // Build events query with filters
  const eventsParams = new URLSearchParams(filters);
  eventsParams.set('limit', '100');

  // Build sessions query: live sessions only (active + idle)
  const activeParams = new URLSearchParams();
  if (filters.agent_type) activeParams.set('agent_type', filters.agent_type);
  // limit=0 means "no cap" so active sessions are not dropped on reload.
  activeParams.set('limit', '0');
  activeParams.set('exclude_status', 'ended');

  try {
    const [statsRes, eventsRes, activeRes] = await Promise.all([
      fetch(`/api/stats${qsSep}`),
      fetch(`/api/events?${eventsParams}`),
      fetch(`/api/sessions?${activeParams}`),
    ]);

    if (!statsRes.ok || !eventsRes.ok || !activeRes.ok) {
      throw new Error(
        `core fetch failed: stats=${statsRes.status} events=${eventsRes.status} active=${activeRes.status}`
      );
    }

    const [stats, eventsData, activeData] = await Promise.all([
      statsRes.json(),
      eventsRes.json(),
      activeRes.json(),
    ]);

    // Update core components
    StatsBar.update(stats);
    EventFeed.initFromData(eventsData.events || []);
    AgentCards.initFromData(activeData.sessions || [], eventsData.events || []);

  } catch (err) {
    console.error('Failed to fetch data:', err);
  }

  // Keep analytics loading independent from core list/session bootstrap.
  const analyticsResults = await Promise.allSettled([
    CostDashboard.load(filters),
    ToolAnalytics.load(filters),
  ]);
  for (const result of analyticsResults) {
    if (result.status === 'rejected') {
      console.error('Failed to load analytics section:', result.reason);
    }
  }
}

function initCompactMode() {
  const toggle = document.getElementById('compact-toggle');
  const cardsContainer = document.getElementById('agent-cards');
  let compact = false;

  // Show compact button when 6+ sessions
  const observer = new MutationObserver(() => {
    const count = cardsContainer.querySelectorAll('[data-session-id]').length;
    if (count >= 6) {
      toggle.classList.remove('hidden');
    } else {
      toggle.classList.add('hidden');
    }
  });
  observer.observe(cardsContainer, { childList: true });

  toggle.addEventListener('click', () => {
    compact = !compact;
    toggle.textContent = compact ? 'Expand' : 'Compact';

    if (compact) {
      cardsContainer.classList.remove('md:grid-cols-2', 'lg:grid-cols-3');
      cardsContainer.classList.add('md:grid-cols-3', 'lg:grid-cols-4');
      cardsContainer.querySelectorAll('.max-h-48').forEach(el => {
        el.classList.add('hidden');
      });
    } else {
      cardsContainer.classList.remove('md:grid-cols-3', 'lg:grid-cols-4');
      cardsContainer.classList.add('md:grid-cols-2', 'lg:grid-cols-3');
      cardsContainer.querySelectorAll('.max-h-48').forEach(el => {
        el.classList.remove('hidden');
      });
    }
  });
}
