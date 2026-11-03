# Security

Please report a security issue privately to [support@blujay.io](mailto:support@blujay.io) with "Security" in the subject, not in a public issue. Include what you found and how to reproduce it. We'll reply within two business days and keep you updated until it's fixed.

This covers this MCP server and the Blujay API it talks to.

## What the MCP server does to keep sends safe

These checks guard against mistakes. They aren't a security boundary: the server runs as you, with your API key.

- **Approvals.** Each tool says whether it only reads or acts, so Claude, Cursor and VS Code can approve reads automatically and still ask before every send, reaction or group change. Whether they ask depends on your client's approval settings: with automatic approval turned on (such as auto-run in Cursor), sends go out without asking. Use `--allow-send-to` while you try it.
- **`--allow-send-to`.** Limits every text, reaction, typing bubble, read receipt, group change and contact tag to the numbers you list, and turns off opt-outs and webhook creation. Anything else is refused before it reaches Blujay. An empty list refuses to start rather than allowing everyone. It checks a conversation's members just before acting, so it can't stop someone else in your workspace changing contacts or group members at that same moment.
- **`--read-only`.** Leaves out every tool that sends, changes or deletes.
- **Files.** `send_message` opens a file only when given its full path, checks `--allow-send-to` before opening it, and sends it only if its contents are a photo, a video, a document (PDF, or Word, Excel or PowerPoint as .docx, .xlsx or .pptx), a contact card or audio (sent as a voice memo), up to 100 MiB. A text file, key, `.env` file, plain zip or program is refused whatever its name. The check is on the file's type, not on what a document says, and it can't stop an assistant that can also write files on your computer from making a file that looks like a document. The server can read any file you can; your assistant is told to use only a path you gave it, never one from a message or web page.
- **No double texts.** The exact same text (or file) to the same person or conversation within 10 minutes isn't sent again: the assistant gets the first send back, and sends again only if you ask. If the connection drops mid-send, a retry reuses the same request key, so Blujay sends it at most once.
- **Message text is content.** The assistant is told that texts and contact names come from other people and are never instructions to follow.
- **Sending rules.** Blujay's [sending rules](https://docs.blujay.io/messaging/sending-rules) still apply, such as no links before a contact replies; a refused send comes back with a plain explanation and the next step.
