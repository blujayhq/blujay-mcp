// API errors as plain sentences with the next step, so the assistant can recover
// or explain the problem instead of showing a bare error code.
import { BlujayError, BlujayTimeoutError } from "blujay";

const NEXT_STEP: Record<string, string> = {
    UNAUTHORIZED: "Check that BLUJAY_API_KEY is set to the key shown under API in the Blujay sidebar.",
    API_KEY_EXPIRED: "This API key has expired. Email support@blujay.io for a new one, then update BLUJAY_API_KEY.",
    API_KEY_REVOKED: "This API key was revoked. Email support@blujay.io for a new one, then update BLUJAY_API_KEY.",
    NOT_FOUND: "Check the ID, or look it up again with list_conversations, find_contacts or list_workflows.",
    WORKFLOW_LIFECYCLE_ERROR:
        "This workflow can't take enrollments: it isn't active, or it doesn't start manually. Pick one from list_workflows, or turn it on in the Blujay app. A tag-triggered workflow starts when you tag the contact with save_contact.",
    WORKFLOW_VALIDATION_ERROR: "This workflow isn't set up to run yet, for example it has no published version or its phone number isn't available. Fix it in the Blujay app, then try again.",
    PRE_REPLY_LIMIT_REACHED: "This person hasn't replied yet, and the number of texts allowed before a reply is used up. Wait for them to reply.",
    PRE_REPLY_CONTENT_BLOCKED: "Links and attachments can't be sent until the person replies. Send text only for now.",
    FIRST_MESSAGE_LINK_NOT_ALLOWED: "A first message can't contain a link. Send text only, and share the link after they reply.",
    PRE_REPLY_LENGTH_EXCEEDED: "Until the person replies, texts must be 300 characters or less. Shorten the text.",
    CONTACT_MUST_TEXT_FIRST: "This number can only message people who texted it first. Send from a different number, or ask them to text you.",
    CONTACT_NOT_VERIFIED: "This number can only message people who texted it first. Send from a different number, or ask them to text you.",
    RECIPIENT_SUPPRESSED: "This person opted out, so Blujay won't text them.",
    FROM_NUMBER_REQUIRED: "Pick which of your numbers to send from (see get_account) and pass it as `from`.",
    QUEUE_FULL: "Too many messages are waiting to send from this number. Try again in a few minutes.",
    IDEMPOTENCY_IN_PROGRESS: "Blujay is still working on the earlier attempt. Check get_conversation in a minute before sending again.",
    RATE_LIMIT_EXCEEDED: "Too many requests right now. Wait a minute and try again.",
    EDIT_LIMIT_REACHED: "This message can't be edited again (iMessage allows 5 edits within 15 minutes).",
    EDIT_WINDOW_EXPIRED: "It's been more than 15 minutes, so it can't be edited. Send a new message instead.",
    UNSEND_WINDOW_EXPIRED: "It's been more than 2 minutes, so it can't be unsent.",
    UNSUPPORTED_ATTACHMENT_TYPE:
        "This file can't go out in this conversation. Documents (PDF, Word, Excel, PowerPoint) and voice memos need iMessage or RCS, and a voice memo needs a conversation that already has messages. Over SMS, send a photo, video or contact card. A link must point straight at a photo, video or contact card (or audio, sent as a voice memo).",
};

/**
 * @param wrote true for a tool that sends or changes something: after a timeout or lost connection
 * it may have gone through, so the assistant must check before trying again.
 */
export function describeError(error: unknown, wrote = false): string {
    const mayHaveHappened = wrote
        ? " It may still have gone through: check with get_conversation or get_message before trying again."
        : "";
    if (error instanceof BlujayTimeoutError) {
        return `Blujay didn't answer in time.${mayHaveHappened || " Try again in a moment."}`;
    }
    if (error instanceof BlujayError && error.statusCode === undefined) {
        // No response at all: the connection failed or dropped.
        return `Couldn't reach Blujay: ${error.message}.${mayHaveHappened}`;
    }
    if (error instanceof BlujayError) {
        const body = error.body as { error?: { message?: string; doc_url?: string } } | undefined;
        const code = error.code;
        const message = body?.error?.message ?? error.message;
        const nextStep = code ? NEXT_STEP[code] : undefined;
        return [
            `Blujay returned an error${error.statusCode ? ` (${error.statusCode}${code ? ` ${code}` : ""})` : ""}: ${message}`,
            nextStep,
            body?.error?.doc_url ? `Details: ${body.error.doc_url}` : undefined,
        ].filter(Boolean).join("\n");
    }
    const text = error instanceof Error ? error.message : String(error);
    return `Couldn't reach Blujay: ${text}.${mayHaveHappened}`;
}
