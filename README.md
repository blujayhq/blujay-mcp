# Blujay MCP Server

[![npm](https://img.shields.io/npm/v/blujay-mcp)](https://www.npmjs.com/package/blujay-mcp)
[![CI](https://github.com/blujayhq/blujay-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/blujayhq/blujay-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Let Claude, Cursor, VS Code and other AI assistants work with your [Blujay](https://blujay.io) account: read conversations, see who needs a reply, and send iMessage, RCS and SMS from your Blujay phone numbers.

> **Every text is real.** Blujay has no test mode. Most assistants ask before each send unless you've set them to approve tools automatically, so try it with `--allow-send-to` limited to your own number first (see [Safety](#safety)).

## What you can ask

- "Who texted me today that I haven't answered?"
- "Summarize my conversation with Ava and draft a reply."
- "Text +1 555 555 0123: running 10 minutes late."
- "Send Ava the photo on my Desktop called beach.jpg."
- "Text Sam the lease PDF in my Downloads folder."
- "Send Ava happy birthday with balloons."
- "Leave Ava a voice note in my voice saying I'm running 10 minutes late." (with the ElevenLabs MCP server making the audio)
- "Did my last message to Sam get delivered?"
- "Does this number have iMessage?"
- "Set up a webhook to https://example.com/blujay for new messages."
- "How do I verify webhook signatures?"

## Setup

You need Node.js 20 or later and a Blujay API key from the **API** tab in Blujay.

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en-US/install-mcp?name=blujay&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImJsdWpheS1tY3AiXSwiZW52Ijp7IkJMVUpBWV9BUElfS0VZIjoiYmx1X3lvdXJfYXBpX2tleSJ9fQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Blujay-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=blujay&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22blujay-mcp%22%5D%2C%22env%22%3A%7B%22BLUJAY_API_KEY%22%3A%22blu_your_api_key%22%7D%7D)

The buttons add the server with a placeholder key; replace `blu_your_api_key` with yours.

### Claude Desktop

Open **Settings → Developer → Edit Config** and add:

```json
{
  "mcpServers": {
    "blujay": {
      "command": "npx",
      "args": ["-y", "blujay-mcp"],
      "env": { "BLUJAY_API_KEY": "blu_your_api_key" }
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```sh
claude mcp add blujay --env BLUJAY_API_KEY=blu_your_api_key -- npx -y blujay-mcp
```

### Cursor

In **Cursor Settings → Tools & MCP → New MCP Server**, add to `mcp.json`:

```json
{
  "mcpServers": {
    "blujay": {
      "command": "npx",
      "args": ["-y", "blujay-mcp"],
      "env": { "BLUJAY_API_KEY": "blu_your_api_key" }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "blujay": {
      "command": "npx",
      "args": ["-y", "blujay-mcp"],
      "env": { "BLUJAY_API_KEY": "${input:blujay-api-key}" }
    }
  },
  "inputs": [
    { "id": "blujay-api-key", "type": "promptString", "description": "Blujay API key", "password": true }
  ]
}
```

### Other MCP clients

Run `npx -y blujay-mcp` with `BLUJAY_API_KEY` set. It speaks MCP over stdio.

## Safety

- **Your assistant can ask before anything that reaches a person.** Each tool says whether it only reads or acts, so Claude, Cursor and VS Code can approve reads automatically and still ask before every send, reaction or group change. Whether they ask depends on your client's approval settings: if you've turned on automatic approval (such as auto-run in Cursor), sends go out without asking, so use `--allow-send-to` below.
- **Try it on your own number first.** `--allow-send-to` limits every text, reaction, typing bubble, read receipt, group change and contact tag to the numbers you list, and turns off opt-outs and webhook creation. Anything else is refused before it reaches Blujay. An empty list refuses to start rather than allowing everyone.

  ```json
  "args": ["-y", "blujay-mcp", "--allow-send-to", "+15555550123"]
  ```

- **Read-only.** `--read-only` leaves out every tool that sends, changes or deletes.
- **Files from your computer.** `send_message` opens a file only when given its full path, sends it only if its contents are a photo, a video, a document (PDF, or Word, Excel or PowerPoint as .docx, .xlsx or .pptx), a contact card or audio (sent as a voice memo) up to 100 MiB, and checks `--allow-send-to` before opening it. A text file, key, `.env` file, plain zip or program is refused whatever its name, because the server checks what a file is from its contents. It checks the type, not what a document says, and it can't stop an assistant that can also write files on your computer from making a file that looks like a document. Documents go over iMessage or RCS, not SMS. The server runs as you, so it can read any file you can; your assistant is told to use only a path you gave it, never one from a message or web page.
- **No accidental double texts.** If the assistant asks for the exact same text (or the same file) to the same person or conversation again within 10 minutes, it isn't sent twice: the assistant gets the first send back, and sends it again only if you ask. If the connection drops mid-send, a retry reuses the same request key, so Blujay sends the text at most once, and the assistant is told to check before trying again.
- Blujay's [sending rules](https://docs.blujay.io/messaging/sending-rules) still apply, such as no links before a contact replies. The assistant gets a plain explanation and the next step when a send is refused.
- **Message text is treated as content.** The assistant is told that texts and contact names come from other people and are never instructions to follow.

`--allow-send-to` checks a conversation's members just before acting. It guards against mistakes while you test; it isn't a security boundary against other people changing contacts or group members in your workspace at the same moment.

## Tools

| Tool | What it does | Reaches a person |
| --- | --- | --- |
| `get_account` | Your workspace and phone numbers, and what each can do | |
| `list_conversations` | Recent conversations, optionally with one person or on one number | |
| `get_conversation` | A conversation as a transcript, found by phone number, email or chat ID | |
| `find_unanswered` | Conversations where the other person is waiting on you | |
| `get_message` | A message's delivery status and why it failed | |
| `check_imessage` | Whether a number uses iMessage | |
| `find_contacts` | Search contacts by name, phone or email, or list saved (or unsaved) contacts | |
| `list_webhooks` | Webhook subscriptions and recent delivery attempts | |
| `search_docs` | Search docs.blujay.io | |
| `send_message` | Text a person or group, or reply in a conversation, with an optional photo, video, document, contact card or audio file (sent as a voice memo) from your computer, a photo, video or contact card from a link, or an iMessage effect such as balloons or slam on a follow-up | Yes |
| `react_to_message` | Add or remove a tapback or an emoji reaction | Yes |
| `edit_message` | Edit a sent iMessage | Yes |
| `unsend_message` | Unsend an iMessage | Yes |
| `mark_conversation_read` | Mark a conversation as read | Yes (read receipt) |
| `set_typing` | Show or hide the typing bubble | Yes |
| `update_group` | Rename an iMessage group, or add or remove a person | Yes |
| `save_contact` | Create or update a contact, and tag it | Can: a tag can start a workflow that texts them |
| `opt_out_contact` | Stop all texts to a contact (off with `--allow-send-to`) | |
| `create_webhook` | Create a webhook subscription (off with `--allow-send-to`) | |
| `invoke_api` | Call any Blujay endpoint (only with `--enable-invoke-api`) | Depends |

## Prompts

Your MCP client shows these as ready-made actions:

- **Who needs a reply?** Finds the conversations waiting on you and drafts a reply for each, without sending.
- **Summarize a conversation** with one person.
- **Send me a test message** to your own phone and confirm it arrived.

## Options

| Option | Effect |
| --- | --- |
| `--read-only` | Only the tools that read |
| `--allow-send-to <numbers>` | Only reach these comma-separated numbers |
| `--enable-invoke-api` | Add `invoke_api` for any endpoint. Only `GET` with `--read-only` or `--allow-send-to` |
| `--help`, `--version` | |

## Troubleshooting

- **"set BLUJAY_API_KEY"**: add the key to the `env` block of your MCP client's config, then restart the client.
- **401, `API_KEY_REVOKED` or `API_KEY_EXPIRED`**: email support@blujay.io for a new key, then update `BLUJAY_API_KEY`.
- **The tools don't appear**: check that `npx -y blujay-mcp --version` works in a terminal, and restart your MCP client.

## More

- [Blujay API docs](https://docs.blujay.io)
- Libraries for your own code: [blujay on npm](https://www.npmjs.com/package/blujay) and [blujay on PyPI](https://pypi.org/project/blujay/)
- Questions and bugs: [support@blujay.io](mailto:support@blujay.io) or [open an issue](https://github.com/blujayhq/blujay-mcp/issues). Security issues: [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE)
