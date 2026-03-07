export type Tab = 'monitor' | 'sessions' | 'analytics' | 'search';

let currentTab = $state<Tab>('monitor');

export function getTab(): Tab {
  return currentTab;
}

export function setTab(tab: Tab): void {
  currentTab = tab;
  window.location.hash = tab === 'monitor' ? '' : tab;
}

// Initialize from URL hash
function initFromHash(): void {
  const hash = window.location.hash.slice(1);
  if (hash === 'sessions' || hash === 'analytics' || hash === 'search') {
    currentTab = hash;
  }
}

initFromHash();
window.addEventListener('hashchange', initFromHash);
