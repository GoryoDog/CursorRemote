import { randomBytes } from 'crypto';
import { WebSocket, type RawData } from 'ws';
import type { Transport } from '../types.js';
import type {
  Approval,
  ApprovalAction,
  CommandResult,
  CursorState,
  DiscordConfig,
} from '../../types.js';
import type { StateManager } from '../../state-manager.js';
import type { CommandExecutor } from '../../command-executor.js';
import type { CDPBridge } from '../../cdp-bridge.js';
import type { WindowMonitor } from '../../window-monitor.js';
import {
  findUniqueWindow,
  formatCursorStatus,
  truncateDiscordText,
} from './helpers.js';

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const EPHEMERAL_FLAG = 1 << 6;
const GUILDS_INTENT = 1 << 0;
const MAX_RECONNECT_DELAY_MS = 30_000;
const ACTION_TTL_MS = 30 * 60 * 1000;

interface GatewayPayload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

interface DiscordApplication {
  id: string;
  name?: string;
}

interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
}

interface DiscordInteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordInteractionOption[];
}

interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  data?: {
    name?: string;
    custom_id?: string;
    component_type?: number;
    options?: DiscordInteractionOption[];
  };
  message?: {
    id: string;
    channel_id?: string;
    content?: string;
  };
}

interface PendingDiscordAction {
  approvalId: string;
  action: ApprovalAction;
  createdAt: number;
}

interface DiscordMessageComponent {
  type: number;
  components: Array<{
    type: number;
    style: number;
    label: string;
    custom_id: string;
    disabled?: boolean;
  }>;
}

interface DiscordMessageBody {
  content: string;
  flags?: number;
  components?: DiscordMessageComponent[];
  allowed_mentions?: { parse: string[] };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function interactionUser(interaction: DiscordInteraction): DiscordUser | undefined {
  return interaction.member?.user ?? interaction.user;
}

function commandOptions(interaction: DiscordInteraction): DiscordInteractionOption[] {
  return interaction.data?.options ?? [];
}

function optionValue(
  options: DiscordInteractionOption[],
  name: string
): string | number | boolean | undefined {
  for (const option of options) {
    if (option.name === name) return option.value;
    const nested = option.options ? optionValue(option.options, name) : undefined;
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function resultMessage(result: CommandResult, success: string): string {
  return result.ok ? success : `失敗: ${result.error ?? '不明なエラー'}`;
}

function applicationCommandDefinition(): Record<string, unknown> {
  const stringOption = (
    name: string,
    description: string,
    required = true,
    extra: Record<string, unknown> = {}
  ) => ({ type: 3, name, description, required, ...extra });

  return {
    name: 'cursor',
    description: 'ローカルのCursorエージェントを操作します',
    dm_permission: false,
    options: [
      {
        type: 1,
        name: 'status',
        description: 'Cursorの接続状態・モデル・モードを表示します',
      },
      {
        type: 1,
        name: 'send',
        description: 'Cursorへプロンプトを送信します',
        options: [
          stringOption('prompt', '送信するプロンプト', true, { max_length: 4000 }),
          stringOption('mode', '送信前に切り替えるモード', false, {
            choices: [
              { name: 'Agent', value: 'agent' },
              { name: 'Plan', value: 'plan' },
            ],
          }),
        ],
      },
      {
        type: 1,
        name: 'approve',
        description: '最新の承認待ち操作を承認します',
      },
      {
        type: 1,
        name: 'reject',
        description: '最新の承認待ち操作を拒否します',
      },
      {
        type: 1,
        name: 'approve-all',
        description: 'CursorのAccept Allを実行します',
      },
      {
        type: 1,
        name: 'mode',
        description: 'Cursorのモードを切り替えます',
        options: [stringOption('value', 'モードID（agent / planなど）')],
      },
      {
        type: 1,
        name: 'model',
        description: 'Cursorのモデルを切り替えます',
        options: [stringOption('value', 'モデルIDまたは表示名')],
      },
      {
        type: 1,
        name: 'tab',
        description: 'チャットタブを切り替えます',
        options: [stringOption('name', 'タブ名')],
      },
      {
        type: 1,
        name: 'window',
        description: 'Cursorウィンドウを切り替えます',
        options: [stringOption('name', 'ウィンドウ名またはID')],
      },
      {
        type: 1,
        name: 'windows',
        description: '検出中のCursorウィンドウを一覧表示します',
      },
      {
        type: 1,
        name: 'history',
        description: '直近の会話を表示します',
        options: [{
          type: 4,
          name: 'count',
          description: '表示件数（1〜10）',
          required: false,
          min_value: 1,
          max_value: 10,
        }],
      },
      {
        type: 1,
        name: 'new-chat',
        description: '新しいチャットを作成します',
      },
    ],
  };
}

export class DiscordTransport implements Transport {
  readonly name = 'discord';

  private readonly config: DiscordConfig;
  private readonly windowMonitor: WindowMonitor;
  private readonly stateManager: StateManager;
  private readonly commandExecutor: CommandExecutor;
  private readonly cdpBridge: CDPBridge;
  private readonly allowedUsers: Set<string>;

  private ws: WebSocket | null = null;
  private sequence: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1000;
  private stopping = false;
  private started = false;
  private applicationId = '';

  private readonly pendingActions = new Map<string, PendingDiscordAction>();
  private readonly announcedApprovals = new Set<string>();
  private readonly seenMessageIds = new Set<string>();

  constructor(
    config: DiscordConfig,
    windowMonitor: WindowMonitor,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge
  ) {
    this.config = config;
    this.windowMonitor = windowMonitor;
    this.stateManager = stateManager;
    this.commandExecutor = commandExecutor;
    this.cdpBridge = cdpBridge;
    this.allowedUsers = new Set(config.allowedUsers);
  }

  async start(): Promise<void> {
    if (!this.config.botToken) {
      console.error('[discord] DISCORD_BOT_TOKEN is empty; transport disabled');
      return;
    }
    if (!this.config.guildId) {
      console.error('[discord] DISCORD_GUILD_ID is empty; transport disabled');
      return;
    }
    if (this.allowedUsers.size === 0) {
      console.error('[discord] DISCORD_ALLOWED_USERS must contain at least one Discord user ID');
      return;
    }

    const app = await this.api<DiscordApplication>('GET', '/oauth2/applications/@me');
    this.applicationId = app.id;
    console.log(`[discord] Application verified: ${app.name ?? app.id} (${app.id})`);

    await this.api(
      'PUT',
      `/applications/${this.applicationId}/guilds/${this.config.guildId}/commands`,
      [applicationCommandDefinition()]
    );
    console.log(`[discord] Registered guild command /cursor for guild ${this.config.guildId}`);

    const state = this.stateManager.getCurrentState();
    for (const message of state.messages) this.seenMessageIds.add(message.id);

    this.stateManager.on('state:patch', this.onStatePatch);
    this.stateManager.on('connection:changed', this.onConnectionChanged);
    this.started = true;
    this.stopping = false;
    this.connectGateway();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    this.stateManager.off('state:patch', this.onStatePatch);
    this.stateManager.off('connection:changed', this.onConnectionChanged);
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, 'shutdown');
      this.ws = null;
    }
    console.log('[discord] Bot stopped');
  }

  private connectGateway(): void {
    if (this.stopping || !this.started) return;

    console.log('[discord] Connecting to Gateway...');
    const ws = new WebSocket(DISCORD_GATEWAY);
    this.ws = ws;

    ws.on('message', (raw: RawData) => {
      this.handleGatewayPayload(raw).catch(err => {
        console.error(`[discord] Gateway payload failed: ${err instanceof Error ? err.message : err}`);
      });
    });

    ws.on('error', err => {
      console.error(`[discord] Gateway error: ${err.message}`);
    });

    ws.on('close', (code, reason) => {
      this.clearHeartbeat();
      if (this.ws === ws) this.ws = null;
      if (this.stopping) return;
      console.warn(`[discord] Gateway closed (${code}): ${reason.toString() || 'no reason'}`);
      this.scheduleReconnect();
    });
  }

  private async handleGatewayPayload(raw: RawData): Promise<void> {
    const payload = JSON.parse(raw.toString()) as GatewayPayload;
    if (typeof payload.s === 'number') this.sequence = payload.s;

    switch (payload.op) {
      case 10: {
        const hello = payload.d as { heartbeat_interval: number };
        this.startHeartbeat(hello.heartbeat_interval);
        this.sendGateway({
          op: 2,
          d: {
            token: this.config.botToken,
            intents: GUILDS_INTENT,
            properties: {
              os: process.platform,
              browser: 'cursor-remote',
              device: 'cursor-remote',
            },
          },
        });
        break;
      }
      case 0:
        if (payload.t === 'READY') {
          const ready = payload.d as { user?: DiscordUser };
          const user = ready.user;
          console.log(`[discord] Gateway ready as ${user?.username ?? user?.id ?? 'unknown'}`);
          this.reconnectDelayMs = 1000;
          if (this.config.notify) {
            await this.postChannelMessage('CursorRemote Discord transport started. `/cursor status` で状態を確認できます。');
          }
        } else if (payload.t === 'INTERACTION_CREATE') {
          await this.handleInteraction(payload.d as DiscordInteraction);
        }
        break;
      case 1:
        this.sendHeartbeat();
        break;
      case 7:
        this.ws?.close(4000, 'server requested reconnect');
        break;
      case 9:
        this.sequence = null;
        this.ws?.close(4000, 'invalid session');
        break;
      case 11:
        break;
      default:
        break;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    const initialDelay = Math.floor(Math.random() * intervalMs);
    setTimeout(() => {
      if (!this.stopping && this.ws?.readyState === WebSocket.OPEN) this.sendHeartbeat();
    }, initialDelay);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    this.sendGateway({ op: 1, d: this.sequence });
  }

  private sendGateway(payload: GatewayPayload): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping) return;
    const delay = this.reconnectDelayMs + Math.floor(Math.random() * 500);
    console.log(`[discord] Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      this.connectGateway();
    }, delay);
  }

  private isAuthorized(interaction: DiscordInteraction): boolean {
    const user = interactionUser(interaction);
    if (!user || !this.allowedUsers.has(user.id)) return false;
    if (interaction.guild_id !== this.config.guildId) return false;
    if (this.config.channelId && interaction.channel_id !== this.config.channelId) return false;
    return true;
  }

  private async handleInteraction(interaction: DiscordInteraction): Promise<void> {
    if (!this.isAuthorized(interaction)) {
      await this.respondInitial(interaction, 'この操作を実行する権限がありません。');
      return;
    }

    if (interaction.type === 2 && interaction.data?.name === 'cursor') {
      await this.defer(interaction);
      try {
        const content = await this.handleCursorCommand(interaction);
        await this.editInteractionResponse(interaction, content);
      } catch (err) {
        await this.editInteractionResponse(
          interaction,
          `エラー: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return;
    }

    if (interaction.type === 3 && interaction.data?.custom_id?.startsWith('cr:')) {
      await this.defer(interaction);
      try {
        const content = await this.handleComponent(interaction);
        await this.editInteractionResponse(interaction, content);
      } catch (err) {
        await this.editInteractionResponse(
          interaction,
          `エラー: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private async handleCursorCommand(interaction: DiscordInteraction): Promise<string> {
    const root = commandOptions(interaction)[0];
    const subcommand = root?.name;
    const options = root?.options ?? [];
    const state = this.stateManager.getCurrentState();
    const commandId = `discord-${interaction.id}`;

    switch (subcommand) {
      case 'status':
        return `\`\`\`\n${formatCursorStatus(state)}\n\`\`\``;

      case 'send': {
        const prompt = String(optionValue(options, 'prompt') ?? '').trim();
        const mode = optionValue(options, 'mode');
        if (!prompt) return 'プロンプトが空です。';
        if (typeof mode === 'string' && mode !== state.mode.current) {
          const modeResult = await this.commandExecutor.setMode(`${commandId}-mode`, mode);
          if (!modeResult.ok) return resultMessage(modeResult, '');
          await sleep(300);
        }
        const result = await this.commandExecutor.sendMessage(commandId, prompt);
        return resultMessage(result, 'Cursorへプロンプトを送信しました。');
      }

      case 'approve':
        return this.executeLatestApproval(commandId, 'approve');

      case 'reject':
        return this.executeLatestApproval(commandId, 'reject');

      case 'approve-all': {
        const result = await this.commandExecutor.approveAll(commandId);
        return resultMessage(result, 'Accept Allを実行しました。');
      }

      case 'mode': {
        const value = String(optionValue(options, 'value') ?? '').trim();
        const result = await this.commandExecutor.setMode(commandId, value);
        return resultMessage(result, `モードを ${value} に切り替えました。`);
      }

      case 'model': {
        const value = String(optionValue(options, 'value') ?? '').trim();
        const result = await this.commandExecutor.setModel(commandId, value);
        return resultMessage(result, `モデルを ${value} に切り替えました。`);
      }

      case 'tab': {
        const name = String(optionValue(options, 'name') ?? '').trim();
        const result = await this.commandExecutor.switchTab(commandId, name);
        return resultMessage(result, `チャットタブを「${name}」へ切り替えました。`);
      }

      case 'window': {
        const name = String(optionValue(options, 'name') ?? '').trim();
        const windows = await this.cdpBridge.refreshWindows();
        const target = findUniqueWindow(windows, name);
        if (!target) return `一致するウィンドウを一意に特定できません: ${name}`;
        await this.cdpBridge.switchWindow(target.id);
        return `Cursorウィンドウを「${target.title}」へ切り替えました。`;
      }

      case 'windows': {
        const windows = await this.cdpBridge.refreshWindows();
        if (windows.length === 0) return 'Cursorウィンドウが見つかりません。';
        return windows
          .map(window => `${window.id === this.cdpBridge.activeTargetId ? '▶' : '•'} ${window.title} (${window.id})`)
          .join('\n');
      }

      case 'history': {
        const requested = Number(optionValue(options, 'count') ?? 5);
        const count = Math.min(10, Math.max(1, Number.isFinite(requested) ? requested : 5));
        const messages = state.messages
          .filter(message => message.type === 'human' || message.type === 'assistant')
          .slice(-count)
          .map(message => {
            const author = message.type === 'human' ? 'You' : 'Cursor';
            return `**${author}:** ${truncateDiscordText(message.text, 500)}`;
          });
        return messages.length > 0 ? truncateDiscordText(messages.join('\n\n')) : '表示できる履歴がありません。';
      }

      case 'new-chat': {
        const result = await this.commandExecutor.newChat(commandId);
        return resultMessage(result, '新しいチャットを作成しました。');
      }

      default:
        return '不明なサブコマンドです。';
    }
  }

  private async executeLatestApproval(
    commandId: string,
    desired: 'approve' | 'reject'
  ): Promise<string> {
    const approvals = this.stateManager.getCurrentState().pendingApprovals;
    const approval = approvals[approvals.length - 1];
    if (!approval) return '承認待ちの操作はありません。';

    const action = approval.actions.find(item =>
      desired === 'approve'
        ? item.type === 'approve' || item.type === 'approve_all'
        : item.type === 'reject'
    );
    if (!action) return `${desired === 'approve' ? '承認' : '拒否'}操作が見つかりません。`;

    const result = await this.executeApprovalAction(commandId, action);
    return resultMessage(result, `${action.label} を実行しました。`);
  }

  private async executeApprovalAction(
    commandId: string,
    action: ApprovalAction
  ): Promise<CommandResult> {
    if (action.type === 'approve_all') {
      return this.commandExecutor.approveAll(commandId);
    }
    if (action.type === 'reject') {
      return this.commandExecutor.reject(commandId, action.selectorPath);
    }
    return this.commandExecutor.clickApproval(commandId, action.selectorPath);
  }

  private async handleComponent(interaction: DiscordInteraction): Promise<string> {
    const customId = interaction.data?.custom_id ?? '';
    const token = customId.split(':')[2] ?? '';
    this.prunePendingActions();
    const pending = this.pendingActions.get(token);
    if (!pending) return 'このボタンは期限切れか、すでに処理されています。';

    const stateApproval = this.stateManager.getCurrentState().pendingApprovals
      .find(approval => approval.id === pending.approvalId);
    if (!stateApproval) {
      this.pendingActions.delete(token);
      return 'この承認項目はCursor側ですでに解決されています。';
    }

    const commandId = `discord-${interaction.id}`;
    const result = await this.executeApprovalAction(commandId, pending.action);
    if (!result.ok) return resultMessage(result, '');

    this.pendingActions.delete(token);
    await this.disableSourceMessage(interaction, `${pending.action.label} を実行しました。`);
    return `${pending.action.label} を実行しました。`;
  }

  private async disableSourceMessage(
    interaction: DiscordInteraction,
    suffix: string
  ): Promise<void> {
    const messageId = interaction.message?.id;
    const channelId = interaction.channel_id ?? interaction.message?.channel_id;
    if (!messageId || !channelId) return;

    const original = interaction.message?.content ?? 'Cursor approval';
    await this.api(
      'PATCH',
      `/channels/${channelId}/messages/${messageId}`,
      {
        content: truncateDiscordText(`${original}\n\n✅ ${suffix}`),
        components: [],
        allowed_mentions: { parse: [] },
      }
    ).catch(err => {
      console.warn(`[discord] Could not disable approval message: ${err instanceof Error ? err.message : err}`);
    });
  }

  private readonly onConnectionChanged = (connected: boolean): void => {
    if (!this.config.notify) return;
    this.postChannelMessage(`Cursor CDP: ${connected ? '接続しました。' : '切断されました。'}`).catch(err => {
      console.warn(`[discord] Connection notification failed: ${err instanceof Error ? err.message : err}`);
    });
  };

  private readonly onStatePatch = (patch: Partial<CursorState>): void => {
    this.processStatePatch(patch).catch(err => {
      console.warn(`[discord] State notification failed: ${err instanceof Error ? err.message : err}`);
    });
  };

  private async processStatePatch(patch: Partial<CursorState>): Promise<void> {
    if (!this.config.notify || !this.config.channelId) return;

    if (patch.messages) {
      for (const message of patch.messages) {
        if (this.seenMessageIds.has(message.id)) continue;
        this.seenMessageIds.add(message.id);
        if (message.type === 'assistant' && message.text.trim()) {
          await this.postChannelMessage(`**Cursor**\n${truncateDiscordText(message.text, 1850)}`);
        }
      }
    }

    if (patch.pendingApprovals) {
      for (const approval of patch.pendingApprovals) {
        if (this.announcedApprovals.has(approval.id)) continue;
        this.announcedApprovals.add(approval.id);
        await this.postApproval(approval);
      }
    }
  }

  private async postApproval(approval: Approval): Promise<void> {
    const buttons = approval.actions.slice(0, 5).map(action => {
      const token = randomBytes(9).toString('base64url');
      this.pendingActions.set(token, {
        approvalId: approval.id,
        action,
        createdAt: Date.now(),
      });
      return {
        type: 2,
        style: action.type === 'reject' ? 4 : action.type === 'approve_all' ? 1 : 3,
        label: truncateDiscordText(action.label || action.type, 80),
        custom_id: `cr:action:${token}`,
      };
    });

    const components = buttons.length > 0
      ? [{ type: 1, components: buttons }]
      : undefined;

    await this.postChannelMessage(
      `⚠️ **Cursorで承認が必要です**\n${truncateDiscordText(approval.description, 1700)}`,
      components
    );
  }

  private prunePendingActions(): void {
    const cutoff = Date.now() - ACTION_TTL_MS;
    for (const [token, action] of this.pendingActions) {
      if (action.createdAt < cutoff) this.pendingActions.delete(token);
    }
  }

  private async postChannelMessage(
    content: string,
    components?: DiscordMessageComponent[]
  ): Promise<void> {
    if (!this.config.channelId) return;
    await this.api(
      'POST',
      `/channels/${this.config.channelId}/messages`,
      {
        content: truncateDiscordText(content),
        components,
        allowed_mentions: { parse: [] },
      }
    );
  }

  private async respondInitial(interaction: DiscordInteraction, content: string): Promise<void> {
    await this.api(
      'POST',
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      {
        type: 4,
        data: {
          content: truncateDiscordText(content),
          flags: EPHEMERAL_FLAG,
          allowed_mentions: { parse: [] },
        },
      },
      false
    );
  }

  private async defer(interaction: DiscordInteraction): Promise<void> {
    await this.api(
      'POST',
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      { type: 5, data: { flags: EPHEMERAL_FLAG } },
      false
    );
  }

  private async editInteractionResponse(
    interaction: DiscordInteraction,
    content: string
  ): Promise<void> {
    const body: DiscordMessageBody = {
      content: truncateDiscordText(content),
      allowed_mentions: { parse: [] },
    };
    await this.api(
      'PATCH',
      `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      body,
      false
    );
  }

  private async api<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    authenticated = true,
    attempt = 1
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'CursorRemote Discord Transport',
    };
    if (authenticated) headers.Authorization = `Bot ${this.config.botToken}`;

    const response = await fetch(`${DISCORD_API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    if (response.status === 429 && attempt <= 4) {
      const rate = await response.json().catch(() => ({})) as { retry_after?: number };
      const retryMs = Math.max(250, Math.ceil((rate.retry_after ?? 1) * 1000));
      await sleep(retryMs);
      return this.api<T>(method, path, body, authenticated, attempt + 1);
    }

    if (response.status >= 500 && attempt <= 3) {
      await sleep(500 * attempt);
      return this.api<T>(method, path, body, authenticated, attempt + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Discord API ${method} ${path} failed: HTTP ${response.status} ${text.slice(0, 500)}`);
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
