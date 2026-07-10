import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findUniqueWindow,
  formatCursorStatus,
  parseSnowflakeList,
  truncateDiscordText,
} from '../src/server/transports/discord/helpers.js';
import type { CursorState, CursorWindow } from '../src/server/types.js';

test('parseSnowflakeList preserves Discord IDs as strings and removes invalid values', () => {
  assert.deepEqual(
    parseSnowflakeList('123456789012345678, 987654321098765432,invalid,123456789012345678'),
    ['123456789012345678', '987654321098765432']
  );
});

test('truncateDiscordText normalizes CRLF and appends an ellipsis', () => {
  assert.equal(truncateDiscordText('abc\r\ndef', 20), 'abc\ndef');
  assert.equal(truncateDiscordText('1234567890', 6), '12345…');
});

test('findUniqueWindow supports exact ID/title and rejects ambiguous partial matches', () => {
  const windows: CursorWindow[] = [
    { id: 'window-1', title: 'CursorRemote', url: 'about:blank' },
    { id: 'window-2', title: 'CursorRemote Tests', url: 'about:blank' },
  ];

  assert.equal(findUniqueWindow(windows, 'window-1')?.title, 'CursorRemote');
  assert.equal(findUniqueWindow(windows, 'cursorremote tests')?.id, 'window-2');
  assert.equal(findUniqueWindow(windows, 'cursor'), null);
});

test('formatCursorStatus reports active state without leaking message contents', () => {
  const state: CursorState = {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: Date.now(),
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'thinking',
    agentActivityText: 'Reviewing files',
    agentActivityLive: true,
    agentActivitySource: 'shimmer',
    messages: [],
    pendingApprovals: [],
    inputAvailable: true,
    chatTabs: [{
      composerId: 'composer-1',
      title: 'Discord transport',
      isActive: true,
      status: 'active',
      selectorPath: '#tab',
    }],
    activeComposerId: 'composer-1',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: 'auto' },
    windows: [{ id: 'window-1', title: 'CursorRemote', url: 'about:blank' }],
    activeWindowId: 'window-1',
    composerQueue: { items: [] },
    questionnaire: null,
  };

  const rendered = formatCursorStatus(state);
  assert.match(rendered, /接続: 接続中/);
  assert.match(rendered, /状態: Reviewing files/);
  assert.match(rendered, /ウィンドウ: CursorRemote/);
  assert.match(rendered, /チャット: Discord transport/);
});
