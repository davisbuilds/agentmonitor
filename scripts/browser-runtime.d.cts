import type { Browser, LaunchOptions } from '@playwright/test';
export function assertPatchedVersion(version: string): void;
export const browserUse: { channel: string; launchOptions: LaunchOptions };
export function launchPatchedChromium(options?: LaunchOptions): Promise<Browser>;
export default function checkBrowser(): Promise<void>;
