# Changelog

## 1.0.0 (2026-11-10)

First release.

- Read tools: account and numbers, conversations, transcripts, who needs a reply, message status, iMessage checks, contacts, webhooks, docs search
- Write tools: send texts (to phone numbers, or email addresses over iMessage) with a photo, video, document (PDF, .docx, .xlsx, .pptx; iMessage or RCS) or contact card (from a link, or a file on your computer in one step), iMessage effects on follow-ups, audio files as voice memos, reactions (tapbacks and emoji), edit and unsend, read receipts, typing, group changes, contacts, opt-outs, webhooks
- Safety: `--read-only`, `--allow-send-to`, read/act labels on every tool, an idempotency key on every send
- Prompts: Who needs a reply?, Summarize a conversation, Send me a test message
- `--enable-invoke-api` adds `invoke_api` for any endpoint
