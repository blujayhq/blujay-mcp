// Turns API objects into short, readable text for an AI assistant: a transcript
// reads better and costs far fewer tokens than the raw JSON.
import type { Blujay } from "blujay";

type Part = Record<string, unknown> & { type?: string };

export function when(iso: string | null | undefined): string {
    if (!iso) return "unknown time";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
    });
}

/** The readable content of a message: its text, plus a note for each attachment. */
export function partsText(parts: unknown[] | undefined): string {
    const pieces: string[] = [];
    for (const raw of parts ?? []) {
        const part = raw as Part;
        switch (part.type) {
            case "text":
                if (typeof part.text === "string") pieces.push(part.text);
                break;
            case "link":
                pieces.push(String(part.value ?? part.url ?? "[link]"));
                break;
            case "audio":
                pieces.push("[voice memo]");
                break;
            case "contact_card":
                pieces.push("[contact card]");
                break;
            case "media": {
                const name = typeof part.filename === "string" ? `: ${part.filename}` : "";
                const kind = typeof part.content_type === "string" && part.content_type.startsWith("image/") ? "photo" : "file";
                pieces.push(`[${kind}${name}]`);
                break;
            }
            default:
                pieces.push(`[${part.type ?? "attachment"}]`);
        }
    }
    return pieces.join(" ").trim() || "[no text]";
}

/** "Ava Chen (+15555550123)", or just the address when there's no name. */
export function personLabel(participant: Blujay.ChatParticipant | undefined): string {
    if (!participant) return "unknown";
    return participant.display_name ? `${participant.display_name} (${participant.address})` : participant.address;
}

export function chatTitle(chat: Blujay.Chat): string {
    if (chat.display_name) return chat.display_name;
    const people = (chat.participants ?? []).map(personLabel);
    if (chat.type === "group") return people.length ? `Group with ${people.join(", ")}` : "Unnamed group";
    return people[0] ?? "Unknown contact";
}

export function chatLine(chat: Blujay.Chat): string {
    const service = chat.service ? `, ${chat.service}` : "";
    return `- ${chatTitle(chat)} — ${chat.type} chat${service}, last activity ${when(chat.updated_at)} (chat_id: ${chat.chat_id})`;
}

function senderLabel(message: Blujay.Message, people: Map<string, string>): string {
    if (message.direction === "outbound") return "You";
    if (message.sender) return people.get(message.sender.address) ?? message.sender.address;
    return people.values().next().value ?? "Them";
}

export function messageStatus(message: Blujay.Message): string {
    if (message.unsent_at) return "unsent";
    if (message.status === "failed") {
        return `failed${message.failure?.reason ? `: ${message.failure.reason}` : ""}`;
    }
    return String(message.status);
}

/** A conversation as a transcript, oldest first. */
export function transcript(chat: Blujay.Chat, messages: Blujay.Message[]): string {
    const people = new Map<string, string>();
    for (const participant of chat.participants ?? []) people.set(participant.address, personLabel(participant));
    const lines = [...messages]
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((message) => {
            const status = message.direction === "outbound" ? ` (${messageStatus(message)})` : "";
            const edited = message.edited_at ? " (edited)" : "";
            const text = message.unsent_at ? "[unsent]" : partsText(message.parts);
            return `[${when(message.created_at)}] ${senderLabel(message, people)}: ${text}${edited}${status}  (message_id: ${message.message_id})`;
        });
    return [
        `${chatTitle(chat)} — ${chat.type} chat${chat.service ? ` over ${chat.service}` : ""} (chat_id: ${chat.chat_id})`,
        lines.length ? lines.join("\n") : "No messages yet.",
    ].join("\n");
}
