import {
  fetchPins,
  fetchSessionPins,
  fetchV2Projects,
  pinSessionMessage,
  unpinSessionMessage,
  type PinnedMessage,
} from '../api/client';
import { navigateToSessionMessage } from './router.svelte';

class PinsStore {
  private initialized = false;
  private sessionVersions: Record<string, number> = {};

  project = $state('');
  projectOptions = $state<string[]>([]);
  pins = $state<PinnedMessage[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  sessionPins = $state<Record<string, number[]>>({});
  sessionLoading = $state<Record<string, boolean>>({});
  sessionErrors = $state<Record<string, string | null>>({});

  async initialize(): Promise<void> {
    if (!this.initialized) {
      try {
        const projects = await fetchV2Projects();
        this.projectOptions = [...projects.data].sort((a, b) => a.localeCompare(b));
      } catch {
        this.projectOptions = [];
      }
      this.initialized = true;
    }

    await this.loadAll();
  }

  async setProject(project: string): Promise<void> {
    if (this.project === project) return;
    this.project = project;
    await this.loadAll();
  }

  async loadAll(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const res = await fetchPins(this.project ? { project: this.project } : {});
      this.pins = res.data;
    } catch (err) {
      console.error('Failed to load pins:', err);
      this.error = 'Failed to load pinned messages.';
    } finally {
      this.loading = false;
    }
  }

  async loadSession(sessionId: string): Promise<void> {
    const version = (this.sessionVersions[sessionId] ?? 0) + 1;
    this.sessionVersions[sessionId] = version;
    this.sessionLoading = { ...this.sessionLoading, [sessionId]: true };
    this.sessionErrors = { ...this.sessionErrors, [sessionId]: null };

    try {
      const res = await fetchSessionPins(sessionId);
      if (this.sessionVersions[sessionId] !== version) return;
      this.sessionPins = {
        ...this.sessionPins,
        [sessionId]: res.data
          .map((pin) => pin.message_ordinal)
          .sort((a, b) => a - b),
      };
    } catch (err) {
      if (this.sessionVersions[sessionId] !== version) return;
      console.error(`Failed to load pins for session ${sessionId}:`, err);
      this.sessionErrors = {
        ...this.sessionErrors,
        [sessionId]: 'Failed to load pins.',
      };
    } finally {
      if (this.sessionVersions[sessionId] === version) {
        this.sessionLoading = { ...this.sessionLoading, [sessionId]: false };
      }
    }
  }

  isPinned(sessionId: string, ordinal: number): boolean {
    return (this.sessionPins[sessionId] ?? []).includes(ordinal);
  }

  async pin(sessionId: string, messageId: number): Promise<PinnedMessage> {
    const pinned = await pinSessionMessage(sessionId, messageId);
    this.updateSessionOrdinal(sessionId, pinned.message_ordinal, true);
    this.upsertPin(pinned);
    return pinned;
  }

  async unpin(sessionId: string, messageId: number): Promise<void> {
    const result = await unpinSessionMessage(sessionId, messageId);
    if (result.message_ordinal == null) {
      await this.loadSession(sessionId);
      await this.loadAll();
      return;
    }

    this.updateSessionOrdinal(sessionId, result.message_ordinal, false);
    this.pins = this.pins.filter(
      (pin) => !(pin.session_id === sessionId && pin.message_ordinal === result.message_ordinal),
    );
  }

  openPin(sessionId: string, ordinal: number): void {
    navigateToSessionMessage(sessionId, ordinal);
  }

  private updateSessionOrdinal(sessionId: string, ordinal: number, add: boolean): void {
    const current = this.sessionPins[sessionId] ?? [];
    const next = add
      ? [...new Set([...current, ordinal])].sort((a, b) => a - b)
      : current.filter((value) => value !== ordinal);

    this.sessionPins = {
      ...this.sessionPins,
      [sessionId]: next,
    };
  }

  private upsertPin(pin: PinnedMessage): void {
    if (this.project && pin.session_project !== this.project) return;
    this.pins = [
      pin,
      ...this.pins.filter(
        (existing) => !(existing.session_id === pin.session_id && existing.message_ordinal === pin.message_ordinal),
      ),
    ];
  }
}

export const pins = new PinsStore();
