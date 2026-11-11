# Changelog

## 1.0.3 (2026-11-11)

- New `list_workflows`: the active, published workflows that start manually, with each one's label and `workflow_id`. Tag-triggered workflows aren't listed; they start when you tag a contact with `save_contact`.
- New `enroll_in_workflow`: starts a manual workflow for a contact, which texts them. Pass your own `request_id`, or leave it out and the server reuses one for the same workflow and contact for 10 minutes, so a retry never enrolls twice. Says plainly whether a run started, the contact was already enrolled, is already in an unfinished run, or has opted out. Left out with `--read-only`; with `--allow-send-to`, only contacts on the list can be enrolled.

## 1.0.2 (2026-11-11)

- Listed in the official MCP Registry as `io.github.blujayhq/blujay-mcp`. No change to tools or how they work.

## 1.0.1 (2026-11-11)

- Security: updated zod to 4.6.7, which fixes a memory problem when checking very large inputs. No change to tools or how they work.

## 1.0.0 (2026-11-10)

First release.

- Read tools: account and numbers, conversations, transcripts, who needs a reply, message status, iMessage checks, contacts, webhooks, docs search
- Write tools: send texts (to phone numbers, or email addresses over iMessage) with a photo, video, document (PDF, .docx, .xlsx, .pptx; iMessage or RCS) or contact card (from a link, or a file on your computer in one step), iMessage effects on follow-ups, audio files as voice memos, reactions (tapbacks and emoji), edit and unsend, read receipts, typing, group changes, contacts, opt-outs, webhooks
- Safety: `--read-only`, `--allow-send-to`, read/act labels on every tool, an idempotency key on every send
- Prompts: Who needs a reply?, Summarize a conversation, Send me a test message
- `--enable-invoke-api` adds `invoke_api` for any endpoint
