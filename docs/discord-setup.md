# Discord Bot API Setup

CursorRemote can connect directly to Discord through Discord's Gateway and REST API. It registers a guild-scoped `/cursor` slash command and uses Discord buttons for Cursor approval prompts.

The transport does **not** read ordinary Discord messages and therefore does not require the privileged Message Content Intent.

## What you can do

- Inspect Cursor/CDP connection, active window, tab, mode, model, and approval count
- Send a prompt to Cursor
- Switch Agent/Plan mode and models
- Approve, reject, or accept all pending actions
- Switch chat tabs and Cursor windows
- Display recent human/assistant messages
- Create a new chat
- Receive optional assistant-message, approval, and connection notifications

## 1. Create a Discord application and bot

1. Open the Discord Developer Portal.
2. Create a new application.
3. Open **Bot**, create the bot, and copy/reset its token.
4. Keep **Message Content Intent** disabled. This integration uses slash commands and interaction events instead.
5. Never commit the bot token to Git or paste it into logs/issues.

## 2. Invite the bot

In **OAuth2 > URL Generator**, select:

- Scopes: `bot`, `applications.commands`
- Bot permissions:
  - View Channels
  - Send Messages
  - Read Message History

Open the generated URL and add the bot to the Discord server you will use.

## 3. Obtain IDs

Enable **Developer Mode** in Discord under **User Settings > Advanced**. Then copy:

- Server ID: right-click the server > **Copy Server ID**
- Channel ID: right-click the target channel > **Copy Channel ID**
- Your user ID: right-click your account > **Copy User ID**

CursorRemote requires an explicit user allowlist. Discord IDs are stored as strings so large snowflake IDs are not rounded by JavaScript.

## 4A. Configure the Cursor extension

Open Cursor settings and set:

```json
{
  "cursorRemote.discord.enabled": true,
  "cursorRemote.discord.botToken": "YOUR_BOT_TOKEN",
  "cursorRemote.discord.guildId": "YOUR_SERVER_ID",
  "cursorRemote.discord.channelId": "YOUR_CHANNEL_ID",
  "cursorRemote.discord.allowedUsers": "YOUR_USER_ID",
  "cursorRemote.discord.notify": true
}
```

Reload Cursor once after entering the token. On activation, CursorRemote copies the token to VS Code/Cursor SecretStorage and clears the plaintext setting.

For multiple operators, separate IDs with commas:

```json
{
  "cursorRemote.discord.allowedUsers": "111111111111111111,222222222222222222"
}
```

Restart the CursorRemote server after changing any Discord setting.

## 4B. Configure standalone mode

Add the following values to `.env`:

```dotenv
DISCORD_ENABLED=true
DISCORD_BOT_TOKEN=YOUR_BOT_TOKEN
DISCORD_GUILD_ID=YOUR_SERVER_ID
DISCORD_CHANNEL_ID=YOUR_CHANNEL_ID
DISCORD_ALLOWED_USERS=YOUR_USER_ID
DISCORD_NOTIFY=true
```

Then run:

```bash
npm run build
npm start
```

## 5. Verify the connection

After startup, the server log should include messages similar to:

```text
[discord] Application verified: ...
[discord] Registered guild command /cursor for guild ...
[discord] Gateway ready as ...
```

Guild commands normally appear quickly. In the configured channel, run:

```text
/cursor status
```

## Commands

| Command | Effect |
|---|---|
| `/cursor status` | Show connection, activity, mode, model, window, tab, and approvals |
| `/cursor send prompt:<text> [mode]` | Send a prompt, optionally switching Agent/Plan mode first |
| `/cursor approve` | Approve the most recent pending action |
| `/cursor reject` | Reject the most recent pending action |
| `/cursor approve-all` | Execute Cursor's Accept All action |
| `/cursor mode value:<id>` | Switch mode |
| `/cursor model value:<id-or-label>` | Switch model |
| `/cursor tab name:<title>` | Switch chat tab |
| `/cursor window name:<title-or-id>` | Switch Cursor window |
| `/cursor windows` | List detected Cursor windows |
| `/cursor history [count]` | Show the latest 1–10 human/assistant messages |
| `/cursor new-chat` | Create a new chat |

Command responses are ephemeral. Only the operator sees them. When notifications are enabled, assistant output and approval cards are posted to the configured channel.

## Security model

All control paths must pass three checks:

1. The interaction came from the configured guild.
2. The interaction came from the configured channel.
3. The Discord user ID is in `allowedUsers`.

Additional safeguards:

- Bot mentions are disabled in outgoing messages (`allowed_mentions.parse = []`).
- Approval buttons use random, short-lived opaque IDs instead of embedding Cursor selectors.
- Bot tokens are masked from normal logs and stored in Cursor SecretStorage in extension mode.
- CursorRemote remains local; Discord is the only external transport endpoint used by this feature.

Use a dedicated private channel and give the bot only the minimum permissions listed above. Anyone allowed to operate this bot can send instructions to, and approve actions in, your local Cursor session.

## Troubleshooting

### `/cursor` does not appear

- Confirm the bot was invited with the `applications.commands` scope.
- Confirm `DISCORD_GUILD_ID` / `cursorRemote.discord.guildId` is the correct server ID.
- Restart CursorRemote so it registers the guild command again.

### `401 Unauthorized`

The bot token is invalid or was reset. Enter the current token and restart CursorRemote.

### `403 Missing Access`

Check that the bot is in the configured server and can view/send messages in the configured channel.

### Command says you are unauthorized

Check the exact guild, channel, and user IDs. Do not use display names, usernames, or channel names in these settings.

### Notifications are too noisy

Set `cursorRemote.discord.notify` or `DISCORD_NOTIFY` to `false`. Slash-command control remains available.
