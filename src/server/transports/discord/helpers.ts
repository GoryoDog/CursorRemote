import type { CursorState, CursorWindow } from '../../types.js';

export function parseSnowflakeList(raw: string): string[] {
  return [...new Set(
    raw
      .split(',')
      .map(value => value.trim())
      .filter(value => /^\d{15,22}$/.test(value))
  )];
}

export function truncateDiscordText(value: string, maxLength = 1900): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function findUniqueWindow(windows: CursorWindow[], query: string): CursorWindow | null {
  const target = query.trim().toLowerCase();
  if (!target) return null;

  const exact = windows.filter(window =>
    window.id.toLowerCase() === target || window.title.trim().toLowerCase() === target
  );
  if (exact.length === 1) return exact[0];

  const partial = windows.filter(window =>
    window.title.trim().toLowerCase().includes(target)
  );
  return partial.length === 1 ? partial[0] : null;
}

export function formatCursorStatus(state: CursorState): string {
  const activeWindow = state.windows.find(window => window.id === state.activeWindowId);
  const activeTab = state.chatTabs.find(tab => tab.isActive);
  const activity = state.agentActivityLive && state.agentActivityText
    ? state.agentActivityText
    : state.agentStatus;

  return [
    `接続: ${state.connected ? '接続中' : '切断'}`,
    `抽出: ${state.extractorStatus}`,
    `状態: ${activity}`,
    `モード: ${state.mode.current || '不明'}`,
    `モデル: ${state.model.current || '不明'}`,
    `ウィンドウ: ${activeWindow?.title ?? '不明'}`,
    `チャット: ${activeTab?.title ?? '不明'}`,
    `承認待ち: ${state.pendingApprovals.length}`,
  ].join('\n');
}
