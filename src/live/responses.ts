import { config } from '../config.js';
import type { LiveSettings } from '../api/v2/types.js';

/** Canonical Live settings response shared by HTTP and CLI. */
export function getLiveSettingsResponse(): LiveSettings {
  return {
    enabled: config.live.enabled,
    codex_mode: config.live.codexMode,
    capture: {
      prompts: config.live.capture.prompts,
      reasoning: config.live.capture.reasoning,
      tool_arguments: config.live.capture.toolArguments,
    },
    diff_payload_max_bytes: config.live.diffPayloadMaxBytes,
  };
}
