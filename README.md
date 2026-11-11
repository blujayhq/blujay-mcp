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
- "Did my last message to Sam get delivered?"
- "Start the Website demo texts workflow for Ava."
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

- **Assistants ask before sends.** Every tool is labeled read or act, so your client can approve reads and ask before anything reaches a person.
- **`--allow-send-to +15555550123`** limits every send and change to the numbers you list; try it on your own number first.
- **`--read-only`** leaves out every tool that sends, changes or deletes.
- **Files only by full path:** photos, videos, documents, contact cards and audio up to 100 MiB, checked by their contents.

Details, including what these checks can't stop, are in [SECURITY.md](SECURITY.md).

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
| `list_workflows` | Workflows you can start for a contact (active, published, started manually; tag-triggered ones start with `save_contact`) | |
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
| `enroll_in_workflow` | Start a manual workflow for a contact; safe to retry, never enrolls twice for the same request | Yes: the workflow texts them |
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
