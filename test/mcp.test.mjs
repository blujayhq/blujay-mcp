// End-to-end tests: a real MCP client talks to the server, which talks to a fake Blujay API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BlujayClient } from "blujay";
import { createBlujayMcpServer } from "../dist/server.js";

const AVA = "+15555550123";
const SAM = "+15555550199";
const OURS = "+15555550100";

const envelope = (data, status = 200) =>
    new Response(JSON.stringify({ status: "success", data, trace_id: "trc_test", timestamp: "2026-10-29T12:00:00.000Z" }), {
        status,
        headers: { "content-type": "application/json" },
    });
const apiError = (status, code, message) =>
    new Response(
        JSON.stringify({ status: "error", error: { code, message, doc_url: `https://docs.blujay.io/errors/${code.toLowerCase()}`, details: [] }, trace_id: "trc_test", timestamp: "2026-10-29T12:00:00.000Z" }),
        { status, headers: { "content-type": "application/json", "retry-after": "0" } },
    );

const chatAva = { chat_id: "chat_ava", type: "direct", participants: [{ type: "phone", address: AVA, display_name: "Ava Chen" }], service: "iMessage", created_at: "2026-10-28T10:00:00.000Z", updated_at: "2026-10-29T11:00:00.000Z" };
const chatSam = { chat_id: "chat_sam", type: "direct", participants: [{ type: "phone", address: SAM }], service: "SMS", created_at: "2026-10-28T10:00:00.000Z", updated_at: "2026-10-29T10:00:00.000Z" };
const message = (id, chat, direction, text, createdAt, extra = {}) => ({
    message_id: id, chat_id: chat, direction, status: direction === "outbound" ? "delivered" : "received", service: "imessage",
    parts: [{ type: "text", text }], degradations: [], reply_to: null, sent_at: null, delivered_at: null, read_at: null, failed_at: null,
    failure: null, edited_at: null, edit_count: 0, unsent_at: null, unsent_scope: null, phone_number_id: "phone_1",
    preferred_service: null, created_at: createdAt, updated_at: createdAt, ...extra,
});
const recent = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function fakeApi(overrides = {}) {
    const calls = [];
    const fetchFn = async (input, init = {}) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const method = (init.method ?? "GET").toUpperCase();
        const headers = new Headers(init.headers);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        const key = `${method} ${url.pathname}`;
        calls.push({ key, query: Object.fromEntries(url.searchParams), body, idempotencyKey: headers.get("idempotency-key") });
        if (overrides[key]) return overrides[key]({ url, body });
        switch (key) {
            case "GET /v1/me":
                return envelope({ workspace_id: "ws_1", workspace_label: "Northwind Realty", credential: { type: "api_key" } });
            case "GET /v1/phone-numbers":
                return envelope({ phone_numbers: [{ phone_number_id: "phone_1", display_number: OURS, label: "Main", status: "active", line_type: "outbound", access_type: "dedicated", send_status: { allowed: true }, capabilities: { messaging: { outbound: true, inbound: true, media_attachments: true, link_parts: true } }, outbound_policy: { inbound_first: false, first_message_links_allowed: false, follow_up_links_allowed: true, daily_total_enforced: true } }] });
            case "GET /v1/chats": {
                const to = url.searchParams.get("to");
                const chats = to === AVA ? [chatAva] : to ? [] : [chatAva, chatSam];
                return envelope({ data: chats, has_more: false, limit: 20 });
            }
            case "GET /v1/chats/chat_ava":
                return envelope(chatAva);
            case "GET /v1/chats/chat_sam":
                return envelope(chatSam);
            case "GET /v1/chats/chat_ava/messages":
                return envelope({ data: [
                    message("msg_2", "chat_ava", "outbound", "Yes, 3pm works!", "2026-10-29T10:05:00.000Z"),
                    message("msg_1", "chat_ava", "inbound", "Is 3pm still good?", "2026-10-29T10:00:00.000Z"),
                ], has_more: false, limit: 60 });
            case "GET /v1/messages":
                return envelope({ data: [
                    message("msg_10", "chat_sam", "inbound", "Can you send the listing?", recent(30)),
                    message("msg_11", "chat_ava", "inbound", "Thanks!", recent(50)),
                    message("msg_12", "chat_ava", "outbound", "You're welcome", recent(40)),
                ], has_more: false, limit: 100 });
            case "GET /v1/messages/msg_1":
                return envelope(message("msg_1", "chat_ava", "inbound", "Is 3pm still good?", "2026-10-29T10:00:00.000Z"));
            case "POST /v1/chats":
                return envelope({ chat_id: "chat_new", message: { id: "msg_new", direction: "outbound", delivery_status: "accepted", service: null, from: OURS, to: body.to, created_at: recent(0), parts: [] } }, 202);
            case "POST /v1/chats/chat_ava/messages":
                return envelope({ chat_id: "chat_ava", message: { id: "msg_reply", direction: "outbound", delivery_status: "accepted", service: "imessage", from: OURS, to: [AVA], created_at: recent(0), parts: [] } }, 202);
            case "POST /v1/messages/msg_1/reactions":
                return envelope({ status: "accepted" }, 202);
            case "POST /v1/attachments": {
                const id = `att_${calls.filter((c) => c.key === key).length}`;
                return envelope({
                    attachment_id: id,
                    upload_url: `https://uploads.test/${id}?signature=abc`,
                    upload_expires_at: recent(-15),
                    upload_headers: { "Content-Type": body.content_type, "Content-Length": String(body.size_bytes) },
                    download_url: `/v1/attachments/${id}/content`,
                }, 201);
            }
            default:
                return apiError(404, "NOT_FOUND", "No such resource");
        }
    };
    return { calls, fetchFn };
}

async function connect(options = {}, overrides) {
    const api = fakeApi(overrides);
    const docsFetch = async () => new Response("# Sending rules\nSource: https://docs.blujay.io/messaging/sending-rules\n\nBefore a contact replies, links are blocked.\n\n# Webhooks\nSource: https://docs.blujay.io/webhooks/overview\n\nWebhooks deliver events.\n");
    const server = createBlujayMcpServer({
        client: new BlujayClient({ apiKey: "blu_test", fetch: api.fetchFn, maxRetries: 0 }),
        fetchFn: docsFetch,
        ...options,
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args });
        return { text: result.content.map((c) => c.text).join("\n"), isError: !!result.isError };
    };
    return { client, call, calls: api.calls };
}

test("read tools are marked read-only; read-only mode drops every write tool", async () => {
    const full = await connect();
    const tools = (await full.client.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.get_conversation.annotations.readOnlyHint, true);
    assert.equal(byName.send_message.annotations.readOnlyHint, false);
    assert.equal(byName.unsend_message.annotations.destructiveHint, true);
    assert.match(byName.send_message.description, /real text/);
    assert.equal(byName.invoke_api, undefined, "invoke_api is opt-in");

    const readOnly = await connect({ readOnly: true });
    const names = (await readOnly.client.listTools()).tools.map((t) => t.name);
    for (const name of ["send_message", "react_to_message", "edit_message", "unsend_message", "update_group", "opt_out_contact", "create_webhook", "enroll_in_workflow"]) {
        assert.ok(!names.includes(name), `${name} should be hidden in read-only mode`);
    }
    assert.ok(names.includes("get_conversation"));
    assert.ok(names.includes("list_workflows"), "listing workflows only reads");
    const prompts = (await readOnly.client.listPrompts()).prompts.map((p) => p.name);
    assert.deepEqual(prompts.sort(), ["summarize_conversation", "who_needs_a_reply"]);
});

test("get_account explains each number in plain words", async () => {
    const { call } = await connect();
    const { text } = await call("get_account");
    assert.match(text, /Northwind Realty/);
    assert.match(text, /\+15555550100 — Main, dedicated number, can start conversations \(phone_number_id: phone_1\)/);
});

test("get_conversation finds the chat from a phone number and reads it as a transcript", async () => {
    const { call, calls } = await connect();
    const { text, isError } = await call("get_conversation", { person: AVA });
    assert.equal(isError, false);
    assert.deepEqual(calls.find((c) => c.key === "GET /v1/chats").query.to, AVA);
    const ask = text.indexOf("Ava Chen (+15555550123): Is 3pm still good?");
    const answer = text.indexOf("You: Yes, 3pm works! (delivered)");
    assert.ok(ask > 0 && answer > ask, `transcript should read oldest first:\n${text}`);
});

test("list_conversations passes the person filter", async () => {
    const { call, calls } = await connect();
    const { text } = await call("list_conversations", { with: SAM });
    assert.equal(calls.at(-1).query.to, SAM);
    assert.match(text, /No conversations with/);
});

test("find_unanswered lists people whose last message is waiting on you", async () => {
    const { call } = await connect();
    const { text } = await call("find_unanswered", { since_hours: 24 });
    assert.match(text, /Can you send the listing\?/);
    assert.doesNotMatch(text, /Thanks!/, "Ava got a reply after her last message");
});

test("send_message sends once, with an idempotency key, and says what happened", async () => {
    const { call, calls } = await connect();
    const { text, isError } = await call("send_message", { to: [AVA], text: "Hi Ava!" });
    assert.equal(isError, false);
    const sends = calls.filter((c) => c.key === "POST /v1/chats");
    assert.equal(sends.length, 1);
    assert.ok(sends[0].idempotencyKey, "every send carries an idempotency key");
    assert.deepEqual(sends[0].body.message.parts, [{ type: "text", text: "Hi Ava!" }]);
    assert.match(text, /message_id: msg_new, chat_id: chat_new/);
});

test("--allow-send-to blocks anyone else before calling Blujay", async () => {
    const { call, calls } = await connect({ allowSendTo: ["(555) 555-0123"] });
    const blocked = await call("send_message", { to: [SAM], text: "hi" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /only reaches \+15555550123/);
    const blockedChat = await call("send_message", { chat_id: "chat_sam", text: "hi" });
    assert.equal(blockedChat.isError, true);
    assert.equal(calls.filter((c) => c.key.startsWith("POST")).length, 0, "nothing was sent");

    const allowed = await call("send_message", { chat_id: "chat_ava", text: "hi" });
    assert.equal(allowed.isError, false);
    const react = await call("react_to_message", { message_id: "msg_1", reaction: "love" });
    assert.equal(react.isError, false);
});

test("react_to_message sends a tapback or any single emoji, and removes either", async () => {
    const { call, calls } = await connect({}, {
        "DELETE /v1/messages/msg_1/reactions/custom": () => envelope({ status: "accepted" }, 202),
        "DELETE /v1/messages/msg_1/reactions/love": () => envelope({ status: "accepted" }, 202),
    });
    const reactions = () => calls.filter((c) => c.key.includes("/reactions"));

    const tapback = await call("react_to_message", { message_id: "msg_1", reaction: "love" });
    assert.equal(tapback.isError, false, tapback.text);
    assert.deepEqual(reactions().at(-1).body, { type: "love" });

    for (const emoji of ["😍", "👍🏽", "👨‍👩‍👧", "🇺🇸", "1️⃣", "❤"]) {
        const { text, isError } = await call("react_to_message", { message_id: "msg_1", emoji });
        assert.equal(isError, false, `${emoji}: ${text}`);
        assert.match(text, new RegExp(`Added ${emoji}`));
        assert.deepEqual(reactions().at(-1).body, { type: "custom", emoji });
    }

    const removed = await call("react_to_message", { message_id: "msg_1", emoji: "😍", remove: true });
    assert.equal(removed.isError, false, removed.text);
    assert.equal(reactions().at(-1).key, "DELETE /v1/messages/msg_1/reactions/custom");
    assert.equal(reactions().at(-1).query.emoji, "😍");
    const removedTapback = await call("react_to_message", { message_id: "msg_1", reaction: "love", remove: true });
    assert.equal(removedTapback.isError, false, removedTapback.text);
    assert.equal(reactions().at(-1).key, "DELETE /v1/messages/msg_1/reactions/love");
    assert.equal(reactions().at(-1).query.emoji, undefined);
});

test("react_to_message refuses anything but one tapback or exactly one emoji, before calling Blujay", async () => {
    const { call, calls } = await connect();
    const before = calls.length;
    for (const args of [
        { message_id: "msg_1" },
        { message_id: "msg_1", reaction: "love", emoji: "😍" },
        { message_id: "msg_1", emoji: "😍😂" },
        { message_id: "msg_1", emoji: "love" },
        { message_id: "msg_1", emoji: " 😍" },
        { message_id: "msg_1", emoji: "1" },
    ]) {
        const { isError, text } = await call("react_to_message", args);
        assert.equal(isError, true, JSON.stringify(args));
        assert.match(text, /reaction|emoji/);
    }
    assert.equal(calls.length, before, "nothing reached Blujay");
});

test("API errors come back as a sentence with the next step", async () => {
    const { call } = await connect({}, {
        "POST /v1/chats": () => apiError(403, "PRE_REPLY_CONTENT_BLOCKED", "Links can't be sent before the contact replies"),
    });
    const { text, isError } = await call("send_message", { to: [AVA], text: "See https://example.com" });
    assert.equal(isError, true);
    assert.match(text, /403 PRE_REPLY_CONTENT_BLOCKED/);
    assert.match(text, /Send text only for now/);
});

test("search_docs returns the matching page with its link", async () => {
    const { call } = await connect();
    const { text } = await call("search_docs", { query: "links before reply" });
    assert.match(text, /# Sending rules\nhttps:\/\/docs.blujay.io\/messaging\/sending-rules/);
});

test("invoke_api is opt-in and read-only when the server is", async () => {
    const { call, calls } = await connect({ enableInvokeApi: true, readOnly: true });
    const refused = await call("invoke_api", { method: "POST", path: "/v1/chats", body: { to: [AVA] } });
    assert.equal(refused.isError, true);
    assert.equal(calls.length, 0);
    const read = await call("invoke_api", { method: "GET", path: "/v1/me" });
    assert.match(read.text, /HTTP 200/);
});

test("the blujay-mcp command runs over stdio the way Claude and Cursor start it", async () => {
    const http = await import("node:http");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const seen = [];
    const api = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
        res.writeHead(200, { "content-type": "application/json" });
        const data = req.url.startsWith("/v1/me")
            ? { workspace_id: "ws_1", workspace_label: "Stdio Test", credential: { type: "api_key" } }
            : { phone_numbers: [] };
        res.end(JSON.stringify({ status: "success", data, trace_id: "trc", timestamp: "2026-10-29T12:00:00.000Z" }));
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [new URL("../dist/index.js", import.meta.url).pathname, "--read-only"],
        env: { ...process.env, BLUJAY_API_KEY: "blu_stdio", BLUJAY_BASE_URL: `http://127.0.0.1:${api.address().port}` },
    });
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    try {
        await client.connect(transport);
        const names = (await client.listTools()).tools.map((t) => t.name);
        assert.ok(names.includes("get_account") && !names.includes("send_message"));
        const result = await client.callTool({ name: "get_account", arguments: {} });
        assert.match(result.content[0].text, /Workspace: Stdio Test/);
        assert.ok(seen.some((line) => line.endsWith("Bearer blu_stdio")));
    } finally {
        await client.close();
        api.close();
    }
});

test("blujay-mcp refuses to start without an API key", async () => {
    const { spawnSync } = await import("node:child_process");
    const env = { ...process.env };
    delete env.BLUJAY_API_KEY;
    const result = spawnSync(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname], { env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /set BLUJAY_API_KEY/);
});

// ---- Review regressions -------------------------------------------------------------------------

test("an empty --allow-send-to never means 'no limit'", async () => {
    const { spawnSync } = await import("node:child_process");
    const cli = new URL("../dist/index.js", import.meta.url).pathname;
    for (const value of ["", " ", ","]) {
        const result = spawnSync(process.execPath, [cli, "--allow-send-to", value], {
            env: { ...process.env, BLUJAY_API_KEY: "blu_test" },
            encoding: "utf8",
            input: "",
        });
        assert.equal(result.status, 1, `--allow-send-to "${value}" must refuse to start`);
        assert.match(result.stderr, /--allow-send-to is empty/);
    }
    assert.throws(() => createBlujayMcpServer({ client: new BlujayClient({ apiKey: "x" }), allowSendTo: [" "] }), /empty/);
});

test("test mode blocks tagging, opt-outs and webhooks for other people", async () => {
    const { call, calls } = await connect({ allowSendTo: [AVA] });
    const tag = await call("save_contact", { phone_number: SAM, name: "Sam", tag: "buyer" });
    assert.equal(tag.isError, true, "a tag can start a workflow that texts the contact");
    const optOut = await call("opt_out_contact", { contact_id: "contact_1" });
    assert.equal(optOut.isError, true);
    const hook = await call("create_webhook", { url: "https://example.com/hook", event_types: ["message.received"] });
    assert.equal(hook.isError, true);
    assert.equal(calls.filter((c) => !c.key.startsWith("GET")).length, 0, "nothing was changed");
});

test("a non-US number can't pass the test list as a US one", async () => {
    const { normalizeAddress } = await import("../dist/server.js");
    assert.equal(normalizeAddress("(415) 555-0123"), "+14155550123");
    assert.notEqual(normalizeAddress("+4155550123"), "+14155550123");
    const { call, calls } = await connect({ allowSendTo: ["+14155550123"] }, {
        "GET /v1/chats/chat_group": () => envelope({ chat_id: "chat_group", type: "group", participants: [{ type: "phone", address: "+14155550123" }] }),
    });
    const result = await call("update_group", { chat_id: "chat_group", add_person: "+4155550123" });
    assert.equal(result.isError, true);
    assert.equal(calls.filter((c) => c.key.startsWith("POST")).length, 0);
});

test("asking for the same send twice can't text twice", async () => {
    const { call, calls } = await connect();
    await call("send_message", { to: [AVA], text: "Running 10 minutes late" });
    const repeat = await call("send_message", { to: ["(555) 555-0123"], text: "Running 10 minutes late" });
    assert.match(repeat.text, /Not sent again/);
    assert.match(repeat.text, /message_id: msg_new/);
    await call("send_message", { to: [AVA], text: "Actually 15 minutes" });
    await call("send_message", { to: [AVA], text: "Running 10 minutes late", send_again: true });
    const keys = calls.filter((c) => c.key === "POST /v1/chats").map((c) => c.idempotencyKey);
    assert.equal(keys.length, 3, "the repeat never reached Blujay; send_again did");
    assert.equal(new Set(keys).size, 3);
});

test("a send with an unknown outcome is retried with the same key; a rejected one starts fresh", async () => {
    let attempt = 0;
    const { call, calls } = await connect({}, {
        "POST /v1/chats": ({ body }) => {
            attempt++;
            if (attempt === 1) throw new TypeError("fetch failed");
            if (body.message.parts[0].text.includes("http")) return apiError(403, "FIRST_MESSAGE_LINK_NOT_ALLOWED", "No links in a first message");
            return envelope({ chat_id: "chat_new", message: { id: "msg_new", direction: "outbound", delivery_status: "accepted", service: null, from: OURS, to: body.to, created_at: recent(0), parts: [] } }, 202);
        },
    });
    await call("send_message", { to: [AVA], text: "Hi Ava" });
    const retry = await call("send_message", { to: [AVA], text: "Hi Ava" });
    assert.equal(retry.isError, false);
    const keys = calls.filter((c) => c.key === "POST /v1/chats").map((c) => c.idempotencyKey);
    assert.equal(keys[0], keys[1], "the retry reuses the first key, so Blujay sends at most once");

    await call("send_message", { to: [SAM], text: "See http://example.com" });
    await call("send_message", { to: [SAM], text: "See http://example.com" });
    const samKeys = calls.filter((c) => c.key === "POST /v1/chats" && c.body.to[0] === SAM).map((c) => c.idempotencyKey);
    assert.equal(samKeys.length, 2);
    assert.notEqual(samKeys[0], samKeys[1], "a clear rejection is forgotten");
});

test("repeated group changes each reach Blujay", async () => {
    const group = { chat_id: "chat_group", type: "group", participants: [{ type: "phone", address: AVA }] };
    const { call, calls } = await connect({}, {
        "GET /v1/chats/chat_group": () => envelope(group),
        "POST /v1/chats/chat_group/participants": () => envelope({ status: "accepted" }, 202),
        "DELETE /v1/chats/chat_group/participants": () => envelope({ status: "accepted" }, 202),
    });
    await call("update_group", { chat_id: "chat_group", remove_person: SAM });
    await call("update_group", { chat_id: "chat_group", add_person: SAM });
    await call("update_group", { chat_id: "chat_group", remove_person: SAM });
    const changes = calls.filter((c) => c.key.endsWith("/participants") && c.key !== "GET /v1/chats/chat_group/participants");
    assert.equal(changes.length, 3);
    assert.equal(new Set(changes.map((c) => c.idempotencyKey)).size, 3, "remove, add, remove are three different actions");
});

test("a send whose reply is lost says it may have gone", async () => {
    const { call } = await connect({}, {
        "POST /v1/chats": () => {
            throw new TypeError("fetch failed");
        },
    });
    const { text, isError } = await call("send_message", { to: [AVA], text: "hi" });
    assert.equal(isError, true);
    assert.match(text, /may still have gone through/);
});

test("get_conversation never shows someone else's chat as the person's", async () => {
    // An API that ignores the person filter (before it shipped) lists everyone's chats.
    const { call } = await connect({}, {
        "GET /v1/chats": () => envelope({ data: [chatSam, chatAva], has_more: false, limit: 10 }),
    });
    const { text } = await call("get_conversation", { person: AVA });
    assert.match(text, /chat_id: chat_ava/);
    assert.doesNotMatch(text.split("\n")[0], /chat_sam/);
    const none = await call("get_conversation", { person: "+15555550111" });
    assert.match(none.text, /No conversation with/);
    const listed = await call("list_conversations", { with: AVA });
    assert.doesNotMatch(listed.text, /chat_sam/);
});

test("a chat started from an email address is found by that address", async () => {
    const contactless = { chat_id: "chat_email", type: "direct", participants: [], service: "iMessage", created_at: recent(60), updated_at: recent(5) };
    const { call } = await connect({}, {
        "GET /v1/chats": ({ url }) => envelope({ data: url.searchParams.get("to") === "alice@example.com" ? [contactless] : [], has_more: false, limit: 10 }),
        "GET /v1/chats/chat_email/messages": () => envelope({ data: [message("msg_e", "chat_email", "inbound", "Hello from email", recent(5))], has_more: false, limit: 100 }),
    });
    const { text } = await call("get_conversation", { person: "alice@example.com" });
    assert.match(text, /chat_id: chat_email/);
    assert.match(text, /Hello from email/);
});

test("a failed reply doesn't count as answering", async () => {
    const { call } = await connect({}, {
        "GET /v1/messages": () => envelope({ data: [
            message("msg_a", "chat_ava", "inbound", "Is 3pm still good?", recent(60)),
            message("msg_b", "chat_ava", "outbound", "Yes!", recent(55), { status: "failed", failure: { code: "delivery_failed", reason: "Not delivered" } }),
        ], has_more: false, limit: 100 }),
    });
    const { text } = await call("find_unanswered", { since_hours: 24 });
    assert.match(text, /Is 3pm still good\?/);
});

test("find_unanswered says when a busy account wasn't fully checked", async () => {
    let n = 0;
    const { call } = await connect({}, {
        "GET /v1/messages": () => {
            n++;
            return envelope({ data: [message(`msg_${n}`, "chat_sam", "outbound", "old", recent(60 * 24 * 3))], next_cursor: `c${n}`, has_more: true, limit: 100 });
        },
    });
    const { text } = await call("find_unanswered", { since_hours: 24 });
    assert.match(text, /not everything was checked/);
});

test("get_conversation shows the newest messages even when older ones were updated recently", async () => {
    // Sent on Oct 1 but read (updated) after the newest message arrived, so they list first.
    const old = Array.from({ length: 100 }, (_, i) =>
        message(`msg_old_${i}`, "chat_ava", "outbound", `old ${i}`, `2026-10-01T10:${String(i % 60).padStart(2, "0")}:00.000Z`, { updated_at: "2026-10-29T11:00:00.000Z" }));
    const { call } = await connect({}, {
        "GET /v1/chats/chat_ava/messages": ({ url }) =>
            url.searchParams.get("cursor")
                ? envelope({ data: [message("msg_new", "chat_ava", "inbound", "Newest question?", "2026-10-29T10:00:00.000Z")], has_more: false, limit: 100 })
                : envelope({ data: old, next_cursor: "p2", has_more: true, limit: 100 }),
    });
    const { text } = await call("get_conversation", { chat_id: "chat_ava", limit: 5 });
    assert.match(text, /Newest question\?/);
});

test("--version prints the version from package.json", async () => {
    const { spawnSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const result = spawnSync(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname, "--version"], { encoding: "utf8" });
    assert.equal(result.stdout.trim(), pkg.version);
});


// ---- send_message with a file from this computer ------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF photo bytes")]);
const VCARD = Buffer.from("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ava Chen\r\nTEL:+15555550123\r\nEND:VCARD\r\n");

function tempFile(name, bytes) {
    const dir = mkdtempSync(join(tmpdir(), "blujay-mcp-test-"));
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
}

/** Stands in for the storage host that takes the upload PUT. */
function fakeUploads(status = 200, delayMs = 0) {
    const puts = [];
    const fetchFn = async (input, init = {}) => {
        puts.push({ url: String(input), method: init.method, headers: new Headers(init.headers), body: Buffer.from(await new Response(init.body).arrayBuffer()) });
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return new Response(null, { status });
    };
    return { puts, fetchFn };
}

test("send_message uploads a photo from this computer, then sends it in one step", async () => {
    const uploads = fakeUploads();
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn });
    const path = tempFile("beach photo.jpeg", JPEG);
    const { text, isError } = await call("send_message", { to: [AVA], text: "From the beach", file_path: path });
    assert.equal(isError, false, text);
    const created = calls.find((c) => c.key === "POST /v1/attachments");
    assert.deepEqual(created.body, { filename: "beach photo.jpg", content_type: "image/jpeg", size_bytes: JPEG.length });
    assert.equal(uploads.puts.length, 1);
    const put = uploads.puts[0];
    assert.equal(put.method, "PUT");
    assert.equal(put.url, "https://uploads.test/att_1?signature=abc");
    assert.equal(put.headers.get("content-type"), "image/jpeg");
    assert.equal(put.headers.get("authorization"), null, "the API key never goes to the storage host");
    assert.deepEqual(put.body, JPEG);
    const send = calls.find((c) => c.key === "POST /v1/chats");
    assert.deepEqual(send.body.message.parts, [{ type: "text", text: "From the beach" }, { type: "media", attachment_id: "att_1" }]);
    assert.ok(send.idempotencyKey);
    assert.match(text, /Accepted/);
});

test("send_message sends a contact card file, detected from its contents", async () => {
    const uploads = fakeUploads();
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn });
    const { isError, text } = await call("send_message", { chat_id: "chat_ava", file_path: tempFile("ava", VCARD) });
    assert.equal(isError, false, text);
    assert.deepEqual(calls.find((c) => c.key === "POST /v1/attachments").body, { filename: "ava.vcf", content_type: "text/vcard", size_bytes: VCARD.length });
});

test("send_message refuses a file that isn't a photo, video or contact card, whatever its name", async () => {
    const uploads = fakeUploads();
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn });
    for (const [name, bytes] of [["notes.txt", "hello"], ["invoice.docx", "%PDX-1.7 not a pdf"], ["fake.jpg", "<html><script>x</script></html>"]]) {
        const { text, isError } = await call("send_message", { to: [AVA], file_path: tempFile(name, bytes) });
        assert.equal(isError, true);
        assert.match(text, /only send a photo, a video, a document \(PDF, Word, Excel or PowerPoint\), a contact card \(vCard\) or an audio file/i);
    }
    assert.equal(calls.filter((c) => c.key === "POST /v1/attachments" || c.key === "POST /v1/chats").length, 0);
    assert.equal(uploads.puts.length, 0);
});

test("send_message refuses a file over the 100 MiB limit, a folder, an empty file or a relative path before uploading", async () => {
    const uploads = fakeUploads();
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn });
    const big = tempFile("huge.mov", JPEG);
    truncateSync(big, 100 * 1024 * 1024 + 1);
    const folder = mkdtempSync(join(tmpdir(), "blujay-mcp-dir-"));
    mkdirSync(join(folder, "inner"));
    for (const [path, pattern] of [
        [big, /larger than 100 MiB/],
        [folder, /not a file/],
        [tempFile("empty.jpg", ""), /empty/],
        ["photos/beach.jpg", /full path/],
        [join(folder, "missing.jpg"), /no file/i],
    ]) {
        const { text, isError } = await call("send_message", { to: [AVA], file_path: path });
        assert.equal(isError, true, path);
        assert.match(text, pattern);
    }
    assert.equal(calls.filter((c) => c.key === "POST /v1/attachments").length, 0);
    assert.equal(uploads.puts.length, 0);
});

test("--allow-send-to refuses a file send before reading or uploading the file", async () => {
    const uploads = fakeUploads();
    const { call, calls } = await connect({ allowSendTo: [SAM], uploadFetchFn: uploads.fetchFn });
    // The path doesn't exist: if the file were read first, the error would be about the file.
    const { text, isError } = await call("send_message", { to: [AVA], file_path: "/nonexistent/beach.jpg" });
    assert.equal(isError, true);
    assert.match(text, /allow-send-to/);
    const inChat = await call("send_message", { chat_id: "chat_ava", file_path: "/nonexistent/beach.jpg" });
    assert.match(inChat.text, /allow-send-to/);
    assert.equal(calls.filter((c) => c.key === "POST /v1/attachments").length, 0);
    assert.equal(uploads.puts.length, 0);
});

test("the same file to the same person within 10 minutes isn't sent twice; a different file is", async () => {
    const uploads = fakeUploads();
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn });
    const first = await call("send_message", { to: [AVA], file_path: tempFile("a.jpg", JPEG) });
    assert.equal(first.isError, false, first.text);
    const again = await call("send_message", { to: [AVA], file_path: tempFile("copy.jpg", JPEG) });
    assert.match(again.text, /Not sent again/);
    const other = await call("send_message", { to: [AVA], file_path: tempFile("b.jpg", Buffer.concat([JPEG, Buffer.from("different")])) });
    assert.equal(other.isError, false, other.text);
    assert.doesNotMatch(other.text, /Not sent again/);
    const forced = await call("send_message", { to: [AVA], file_path: tempFile("a2.jpg", JPEG), send_again: true });
    assert.doesNotMatch(forced.text, /Not sent again/);
    assert.equal(calls.filter((c) => c.key === "POST /v1/chats").length, 3);
    assert.equal(uploads.puts.length, 3);
});

test("a send whose answer was lost is retried with the same upload and key, so it can't go out twice", async () => {
    const uploads = fakeUploads();
    let attempts = 0;
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn }, {
        "POST /v1/chats": ({ body }) => (++attempts === 1
            ? apiError(503, "QUEUE_UNAVAILABLE", "Try again")
            : envelope({ chat_id: "chat_new", message: { id: "msg_new", direction: "outbound", delivery_status: "accepted", service: null, from: OURS, to: body.to, created_at: recent(0), parts: [] } }, 202)),
    });
    const path = tempFile("a.jpg", JPEG);
    const first = await call("send_message", { to: [AVA], file_path: path });
    assert.equal(first.isError, true);
    const retry = await call("send_message", { to: [AVA], file_path: path });
    assert.equal(retry.isError, false, retry.text);
    const sends = calls.filter((c) => c.key === "POST /v1/chats");
    assert.equal(sends.length, 2);
    assert.equal(sends[0].idempotencyKey, sends[1].idempotencyKey);
    assert.deepEqual(sends[1].body.message.parts, sends[0].body.message.parts);
    assert.equal(calls.filter((c) => c.key === "POST /v1/attachments").length, 1);
    assert.equal(uploads.puts.length, 1);
});

test("a failed upload sends nothing and says so", async () => {
    const uploads = fakeUploads(403);
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn });
    const { text, isError } = await call("send_message", { to: [AVA], file_path: tempFile("a.jpg", JPEG) });
    assert.equal(isError, true);
    assert.match(text, /Not sent: the file couldn't be uploaded/);
    assert.doesNotMatch(text, /may still have gone through/);
    assert.equal(calls.filter((c) => c.key === "POST /v1/chats").length, 0);
});

test("send_message takes file_path or attachment_url, not both", async () => {
    const { call, calls } = await connect({ uploadFetchFn: fakeUploads().fetchFn });
    const { text, isError } = await call("send_message", { to: [AVA], file_path: tempFile("a.jpg", JPEG), attachment_url: "https://example.com/a.jpg" });
    assert.equal(isError, true);
    assert.match(text, /file_path or attachment_url, not both/);
    assert.equal(calls.filter((c) => c.key.startsWith("POST")).length, 0);
});

test("photos, videos, PDFs and contact cards are recognised from their bytes; unknown audio isn't", async () => {
    const { detectFileType } = await import("../dist/files.js");
    const box = (type, ...children) => {
        const body = Buffer.concat(children);
        const header = Buffer.alloc(8);
        header.writeUInt32BE(8 + body.length, 0);
        header.write(type, 4, "latin1");
        return Buffer.concat([header, body]);
    };
    const ftyp = (major, ...compatible) => box("ftyp", Buffer.from(major, "latin1"), Buffer.alloc(4), ...compatible.map((b) => Buffer.from(b, "latin1")));
    const handler = (kind) => box("hdlr", Buffer.alloc(8), Buffer.from(kind, "latin1"), Buffer.alloc(12));
    const movie = (kind) => box("moov", box("trak", box("mdia", handler(kind))));
    const cases = [
        [Buffer.concat([ftyp("isom", "isom", "mp41"), movie("vide")]), "video/mp4"],
        [Buffer.concat([ftyp("qt  ", "qt  "), box("wide"), movie("vide")]), "video/quicktime"],
        [Buffer.concat([ftyp("heic", "mif1", "heic"), box("meta")]), "image/heic"],
        [Buffer.concat([ftyp("M4A ", "M4A ", "isom"), movie("soun")]), "audio/mp4"],
        [Buffer.concat([ftyp("isom", "isom", "mp42"), movie("soun")]), null],
        [Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1"), "image/webp"],
        [Buffer.from("GIF89a....", "latin1"), "image/gif"],
        [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), "image/png"],
        [Buffer.from("BEGIN:VCARD\nFN:Ava\n"), null],
        [Buffer.from("%PDF-1.7\n%%EOF\n"), "application/pdf"],
    ];
    for (const [bytes, expected] of cases) assert.equal(detectFileType(bytes)?.contentType ?? null, expected, expected ?? bytes.subarray(0, 12).toString("latin1"));
});

test("two identical file sends at the same time share one upload and one request key", async () => {
    const uploads = fakeUploads(200, 100);
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn });
    const path = tempFile("a.jpg", JPEG);
    const results = await Promise.all([call("send_message", { to: [AVA], file_path: path }), call("send_message", { to: [AVA], file_path: path })]);
    assert.equal(results.filter((r) => r.isError).length, 0, results.map((r) => r.text).join("\n"));
    assert.equal(calls.filter((c) => c.key === "POST /v1/attachments").length, 1);
    assert.equal(uploads.puts.length, 1);
    const sends = calls.filter((c) => c.key === "POST /v1/chats");
    assert.ok(sends.length >= 1 && sends.length <= 2);
    for (const send of sends) {
        assert.equal(send.idempotencyKey, sends[0].idempotencyKey);
        assert.deepEqual(send.body, sends[0].body);
    }
    const later = await call("send_message", { to: [AVA], file_path: path });
    assert.match(later.text, /Not sent again/);
});

test("a stale failure can't erase the record of a send that went out", async () => {
    const uploads = fakeUploads(200, 100);
    let attempts = 0;
    const accepted = ({ body }) => envelope({ chat_id: "chat_new", message: { id: "msg_new", direction: "outbound", delivery_status: "accepted", service: null, from: OURS, to: body.to, created_at: recent(0), parts: [] } }, 202);
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn }, {
        // The second identical send loses the race to Blujay's idempotency check.
        "POST /v1/chats": (req) => (++attempts === 2 ? apiError(409, "IDEMPOTENCY_REQUEST_MISMATCH", "Different request") : accepted(req)),
    });
    const path = tempFile("a.jpg", JPEG);
    await Promise.all([call("send_message", { to: [AVA], file_path: path }), call("send_message", { to: [AVA], file_path: path })]);
    const later = await call("send_message", { to: [AVA], file_path: path });
    assert.match(later.text, /Not sent again/);
    assert.equal(calls.filter((c) => c.key === "POST /v1/chats").length, 2);
});

test("the file is checked and read through one handle, never more than the size it was checked at", async () => {
    const { readSendableFile } = await import("../dist/files.js");
    const { execFileSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "blujay-mcp-fifo-"));
    const fifo = join(dir, "pipe.jpg");
    execFileSync("mkfifo", [fifo]);
    // A named pipe with no writer: reading it by path would hang; it must be refused at once.
    await assert.rejects(readSendableFile(fifo), /not a file/);
});

test("a file that changes size between the check and the read is refused, not sent half-written", async () => {
    const { readExactly } = await import("../dist/files.js");
    const { open } = await import("node:fs/promises");
    const path = tempFile("growing.jpg", Buffer.concat([JPEG, Buffer.from("still saving")]));
    for (const checkedSize of [JPEG.length, JPEG.length + 100]) {
        const handle = await open(path, "r");
        try {
            await assert.rejects(readExactly(handle, checkedSize, path), /changed while it was being read/);
        } finally {
            await handle.close();
        }
    }
});

// ---- iMessage effects ----------------------------------------------------------------------------

test("send_message sends an iMessage effect as the API's screen or bubble effect", async () => {
    const { call, calls } = await connect();
    for (const [effect, expected] of [["balloons", { type: "screen", name: "balloons" }], ["happy_birthday", { type: "screen", name: "happy_birthday" }], ["slam", { type: "bubble", name: "slam" }], ["invisible", { type: "bubble", name: "invisible" }]]) {
        const { text, isError } = await call("send_message", { chat_id: "chat_ava", text: `Happy birthday! (${effect})`, effect });
        assert.equal(isError, false, text);
        assert.match(text, /only over iMessage/);
        assert.deepEqual(calls.filter((c) => c.key === "POST /v1/chats/chat_ava/messages").at(-1).body.message.effect, expected);
    }
});

test("send_message refuses an effect on a first message or with an attachment, before sending", async () => {
    const { call, calls } = await connect({ uploadFetchFn: fakeUploads().fetchFn });
    const first = await call("send_message", { to: [AVA], text: "Hi!", effect: "confetti" });
    assert.equal(first.isError, true);
    assert.match(first.text, /follow-up in an existing conversation/);
    const withPhoto = await call("send_message", { chat_id: "chat_ava", text: "Look", attachment_url: "https://example.com/a.jpg", effect: "confetti" });
    assert.match(withPhoto.text, /can't go with a photo, video, contact card or file/);
    const withFile = await call("send_message", { chat_id: "chat_ava", text: "Look", file_path: tempFile("a.jpg", JPEG), effect: "slam" });
    assert.match(withFile.text, /can't go with a photo, video, contact card or file/);
    assert.equal(calls.filter((c) => c.key.startsWith("POST")).length, 0);
});

test("get_message says plainly when an effect wasn't shown because the text went as SMS or RCS", async () => {
    const { call } = await connect({}, {
        "GET /v1/messages/msg_fx": () => envelope(message("msg_fx", "chat_sam", "outbound", "Happy birthday!", recent(1), {
            service: "sms", effect: { type: "screen", name: "balloons" },
            degradations: [{ code: "effect_not_delivered", reason: "The iMessage effect was not delivered because the message was sent as SMS or RCS." }],
        })),
    });
    const { text } = await call("get_message", { message_id: "msg_fx" });
    assert.match(text, /balloons effect wasn't shown: the message went as SMS or RCS/);
});

test("the same text with a different effect isn't treated as a repeat", async () => {
    const { call, calls } = await connect();
    await call("send_message", { chat_id: "chat_ava", text: "Congrats!", effect: "confetti" });
    const repeat = await call("send_message", { chat_id: "chat_ava", text: "Congrats!", effect: "confetti" });
    assert.match(repeat.text, /Not sent again/);
    const other = await call("send_message", { chat_id: "chat_ava", text: "Congrats!", effect: "fireworks" });
    assert.doesNotMatch(other.text, /Not sent again/);
    const plain = await call("send_message", { chat_id: "chat_ava", text: "Congrats!" });
    assert.doesNotMatch(plain.text, /Not sent again/);
    assert.equal(calls.filter((c) => c.key === "POST /v1/chats/chat_ava/messages").length, 3);
});


// ---- Voice memos ---------------------------------------------------------------------------------

const MP3 = Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.from("spoken words")]);

test("an audio file goes out as a voice memo: an audio part on its own", async () => {
    const uploads = fakeUploads();
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn });
    const { text, isError } = await call("send_message", { chat_id: "chat_ava", file_path: tempFile("running late", MP3) });
    assert.equal(isError, false, text);
    assert.deepEqual(calls.find((c) => c.key === "POST /v1/attachments").body, { filename: "running late.mp3", content_type: "audio/mpeg", size_bytes: MP3.length });
    assert.deepEqual(calls.find((c) => c.key === "POST /v1/chats/chat_ava/messages").body.message.parts, [{ type: "audio", attachment_id: "att_1" }]);
    assert.match(text, /voice memo/);
});

test("a voice memo can't carry text, an effect or start a group, and voice_memo needs audio", async () => {
    const uploads = fakeUploads();
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn });
    const withText = await call("send_message", { chat_id: "chat_ava", text: "Listen", file_path: tempFile("memo.mp3", MP3) });
    assert.equal(withText.isError, true);
    assert.match(withText.text, /voice memo is sent on its own/);
    const group = await call("send_message", { to: [AVA, SAM], from: OURS, file_path: tempFile("memo.mp3", MP3) });
    assert.match(group.text, /can't start a group/);
    const urlWithText = await call("send_message", { chat_id: "chat_ava", text: "Listen", attachment_url: "https://example.com/memo.mp3", voice_memo: true });
    assert.match(urlWithText.text, /voice memo is sent on its own/);
    const notAudio = await call("send_message", { chat_id: "chat_ava", file_path: tempFile("a.jpg", JPEG), voice_memo: true });
    assert.match(notAudio.text, /isn't an audio file/);
    const nothing = await call("send_message", { chat_id: "chat_ava", text: "hi", voice_memo: true });
    assert.match(nothing.text, /voice_memo needs attachment_url or file_path/);
    assert.equal(calls.filter((c) => c.key.startsWith("POST")).length, 0);
    assert.equal(uploads.puts.length, 0);
});

test("a link goes as a voice memo only when voice_memo is set; a photo file still goes as media", async () => {
    const uploads = fakeUploads();
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn });
    await call("send_message", { chat_id: "chat_ava", attachment_url: "https://example.com/memo.mp3", voice_memo: true });
    await call("send_message", { chat_id: "chat_ava", attachment_url: "https://example.com/memo.mp3" });
    await call("send_message", { chat_id: "chat_ava", file_path: tempFile("a.jpg", JPEG) });
    const parts = calls.filter((c) => c.key === "POST /v1/chats/chat_ava/messages").map((c) => c.body.message.parts);
    assert.deepEqual(parts, [
        [{ type: "audio", url: "https://example.com/memo.mp3" }],
        [{ type: "media", url: "https://example.com/memo.mp3" }],
        [{ type: "media", attachment_id: "att_1" }],
    ]);
});

test("the same voice memo file isn't sent twice within 10 minutes; a different one is", async () => {
    const uploads = fakeUploads();
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn });
    await call("send_message", { chat_id: "chat_ava", file_path: tempFile("a.mp3", MP3) });
    const again = await call("send_message", { chat_id: "chat_ava", file_path: tempFile("copy.mp3", MP3) });
    assert.match(again.text, /Not sent again/);
    const other = await call("send_message", { chat_id: "chat_ava", file_path: tempFile("b.mp3", Buffer.concat([MP3, Buffer.from("more")])) });
    assert.doesNotMatch(other.text, /Not sent again/);
    assert.equal(calls.filter((c) => c.key === "POST /v1/chats/chat_ava/messages").length, 2);
});

test("audio is recognised from its bytes: M4A, MP3, AAC, WAV, CAF, FLAC and Ogg", async () => {
    const { detectFileType } = await import("../dist/files.js");
    const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A \0\0\0\0M4A isom", "latin1"), Buffer.from([0, 0, 0, 8]), Buffer.from("moov", "latin1")]);
    const cases = [
        [m4a, "audio/mp4", ".m4a"],
        [MP3, "audio/mpeg", ".mp3"],
        [Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0]), "audio/mpeg", ".mp3"],
        [Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0]), "audio/aac", ".aac"],
        [Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1"), "audio/wav", ".wav"],
        [Buffer.from("caff\x00\x01\x00\x00", "latin1"), "audio/x-caf", ".caf"],
        [Buffer.from("fLaC\x00\x00\x00\x22", "latin1"), "audio/flac", ".flac"],
        [Buffer.from("OggS\x00\x02\x00\x00", "latin1"), "audio/ogg", ".ogg"],
    ];
    for (const [bytes, contentType, extension] of cases) {
        assert.deepEqual(detectFileType(bytes), { contentType, extension, kind: "audio" }, contentType);
    }
    assert.equal(detectFileType(JPEG).kind, "photo");
});

test("an email address can be texted (iMessage), and find_contacts marks contacts nobody saved", async () => {
    const contact = (id, name, saved) => ({ contact_id: id, name, phone_number: "+15555550142", email: null, tags: [], opted_out: false, saved, created_at: recent(5), updated_at: recent(5) });
    const { call, calls } = await connect({ allowSendTo: ["Ava@Example.com"] }, {
        "GET /v1/contacts/search": () => envelope({ data: [contact("contact_1", "Ava Chen", true), contact("contact_2", null, false)], has_more: false, limit: 10 }),
    });
    const sent = await call("send_message", { to: ["ava@example.com"], text: "Hi Ava" });
    assert.equal(sent.isError, false, sent.text);
    assert.deepEqual(calls.find((c) => c.key === "POST /v1/chats").body.to, ["ava@example.com"]);
    const { text } = await call("find_contacts", { query: "a" });
    assert.doesNotMatch(text.split("\n")[0], /not saved/);
    assert.match(text.split("\n")[1], /not saved/);
});

test("check_imessage explains an email address that isn't on iMessage", async () => {
    const { call } = await connect({}, {
        "POST /v1/capability/evaluate_service": ({ body }) => envelope({ number: body.number, service: null, source: "live", checked_at: recent(0) }),
    });
    const { text } = await call("check_imessage", { phone_number: "nobody@example.com" });
    assert.match(text, /nobody@example.com isn't confirmed on iMessage, so a text to it would fail/);
    assert.doesNotMatch(text, /null/);
});


// ---- Documents -----------------------------------------------------------------------------------

/** A zip (stored, no compression) with these entries, empty unless `contents` gives their text. */
function zipWith(names, contents = {}) {
    const { crc32 } = zlibForTests;
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const name of names) {
        const nameBytes = Buffer.from(name);
        const data = Buffer.from(contents[name] ?? "");
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        locals.push(local, nameBytes, data);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBytes);
        offset += 30 + nameBytes.length + data.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(names.length, 8);
    end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}
const zlibForTests = await import("../dist/files.js");
const OOXML = (main) => zipWith(["[Content_Types].xml", "_rels/.rels", main]);
/**
 * The attack the reviewer found: drop the last entry from the directory and grow the previous
 * entry's directory size (and checksum) so its data "contains" the hidden local record.
 */
function swallowNext(zip) {
    const copy = Buffer.from(zip);
    const end = copy.length - 22;
    const directoryOffset = copy.readUInt32LE(end + 16);
    const entries = [];
    for (let at = directoryOffset; at < end; ) {
        const nameLength = copy.readUInt16LE(at + 28);
        entries.push({ at, local: copy.readUInt32LE(at + 42), length: 46 + nameLength });
        at += 46 + nameLength;
    }
    const [previous, last] = entries.slice(-2);
    const previousNameLength = copy.readUInt16LE(previous.local + 26);
    const dataStart = previous.local + 30 + previousNameLength;
    const swallowed = copy.subarray(dataStart, directoryOffset);
    copy.writeUInt32LE(zlibForTests.crc32(swallowed), previous.at + 16);
    copy.writeUInt32LE(swallowed.length, previous.at + 20);
    copy.writeUInt32LE(swallowed.length, previous.at + 24);
    const directory = Buffer.concat([copy.subarray(directoryOffset, last.at), copy.subarray(last.at + last.length, end)]);
    const record = Buffer.from(copy.subarray(end));
    record.writeUInt16LE(entries.length - 1, 8);
    record.writeUInt16LE(entries.length - 1, 10);
    record.writeUInt32LE(directory.length, 12);
    return Buffer.concat([copy.subarray(0, directoryOffset), directory, record]);
}
/** The same zip with its end record claiming fewer entries (and a shorter directory) than it holds. */
function hideEntries(zip, count) {
    const copy = Buffer.from(zip);
    const end = copy.length - 22;
    const fullSize = copy.readUInt32LE(end + 12);
    copy.writeUInt16LE(count, end + 8);
    copy.writeUInt16LE(count, end + 10);
    copy.writeUInt32LE(fullSize - (46 + 4), end + 12);
    return copy;
}
const OLE = (stream) => Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504), Buffer.from(stream, "utf16le"), Buffer.alloc(64)]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

test("documents are recognised from their bytes: PDF, Word, Excel and PowerPoint", async () => {
    const { detectFileType } = await import("../dist/files.js");
    const cases = [
        [PDF, "application/pdf", ".pdf"],
        [OOXML("word/document.xml"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
        [OOXML("xl/workbook.xml"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
        [OOXML("ppt/presentation.xml"), "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
    ];
    for (const [bytes, contentType, extension] of cases) {
        assert.deepEqual(detectFileType(bytes), { contentType, extension, kind: "document" }, contentType);
    }
    // Office files with media, embeddings and the metadata folders Microsoft 365 adds still pass.
    const full = zipWith(["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/media/image1.png", "word/embeddings/Sheet1.xlsx", "docProps/core.xml", "docMetadata/LabelInfo.xml", "customUI/customUI.xml"]);
    assert.equal(detectFileType(full)?.extension, ".docx");
});

test("keys, secrets, code, plain zips and other programs are never sent as documents", async () => {
    const { detectFileType } = await import("../dist/files.js");
    const refused = [
        Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n"),
        Buffer.from("STRIPE_SECRET_KEY=sk_live_123\nDATABASE_URL=postgres://u:p@h/db\n"),
        Buffer.from("console.log('hi')\n"),
        zipWith(["secrets/id_rsa", "notes.txt"]),
        zipWith(["word/document.xml", "id_rsa"]),
        OLE("SummaryInformation"),
        // Legacy .doc/.xls/.ppt compound files aren't sent: telling them from other compound files safely needs a full parser.
        OLE("WordDocument"),
        OLE("Workbook"),
        // An OOXML-looking zip that hides other files, or holds a non-Office entry, isn't a document.
        hideEntries(zipWith(["[Content_Types].xml", "word/document.xml", ".env"]), 2),
        zipWith(["[Content_Types].xml", "word/document.xml", "word/.env"]),
        zipWith(["[Content_Types].xml", "word/document.xml", "word/id_rsa"]),
        // UTF-16 text starts FF FE, which looks like an MPEG frame sync but isn't an MP3 (Layer I, no valid header).
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("AWS_SECRET_ACCESS_KEY=abc123\r\n", "utf16le")]),
        // Paths that climb out of the package, and Office macros.
        zipWith(["[Content_Types].xml", "word/document.xml", "word/../../.ssh/id_rsa.xml"]),
        zipWith(["[Content_Types].xml", "word/document.xml", "word/vbaProject.bin"]),
        // An entry whose directory size swallows a hidden .env record that tar would still list.
        swallowNext(zipWith(["[Content_Types].xml", "word/document.xml", ".env"], { ".env": "API_KEY=secret\n" })),
        // A PDF end marker followed by a secret.
        Buffer.from("%PDF-1.7\n%%EOF\nAWS_SECRET_ACCESS_KEY=abc123\n"),
        // A text file that only starts like a PDF.
        Buffer.from("%PDF-1.7\nAWS_SECRET_ACCESS_KEY=abc123\n"),
        Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1"),
    ];
    for (const bytes of refused) assert.equal(detectFileType(bytes), null, bytes.subarray(0, 20).toString("latin1"));
});

test("send_message sends a PDF from this computer and says documents go over iMessage or RCS, not SMS", async () => {
    const uploads = fakeUploads();
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn });
    const { text, isError } = await call("send_message", { chat_id: "chat_ava", text: "The lease", file_path: tempFile("Lease 2026", PDF) });
    assert.equal(isError, false, text);
    assert.deepEqual(calls.find((c) => c.key === "POST /v1/attachments").body, { filename: "Lease 2026.pdf", content_type: "application/pdf", size_bytes: PDF.length });
    assert.deepEqual(calls.find((c) => c.key === "POST /v1/chats/chat_ava/messages").body.message.parts, [{ type: "text", text: "The lease" }, { type: "media", attachment_id: "att_1" }]);
    assert.match(text, /Documents go over iMessage or RCS: if this person can only get SMS/);
});

test("a .env, a key or a zip renamed .docx is refused before uploading", async () => {
    const uploads = fakeUploads();
    const { call, calls } = await connect({ uploadFetchFn: uploads.fetchFn });
    for (const [name, bytes] of [[".env", "API_KEY=secret\n"], ["id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n"], ["report.docx", zipWith(["passwords.txt"])]]) {
        const { text, isError } = await call("send_message", { chat_id: "chat_ava", file_path: tempFile(name, bytes) });
        assert.equal(isError, true, name);
        assert.match(text, /none of those/);
    }
    assert.equal(calls.filter((c) => c.key === "POST /v1/attachments").length, 0);
    assert.equal(uploads.puts.length, 0);
});

test("get_message doesn't offer a resend", async () => {
    const { call } = await connect({}, {
        "GET /v1/messages/msg_failed": () => envelope(message("msg_failed", "chat_ava", "outbound", "Hi", recent(1), {
            status: "failed", failure: { code: "delivery_failed", reason: "The message could not be delivered." }, retryable: true,
        })),
    });
    const { text } = await call("get_message", { message_id: "msg_failed" });
    assert.match(text, /could not be delivered/);
    assert.match(text, /To try again, send a new message/);
    assert.doesNotMatch(text, /retried/);
});


test("find_contacts with nothing to search lists saved contacts, or unsaved ones, a page at a time", async () => {
    const contact = (id, name, saved) => ({ contact_id: id, name, phone_number: "+15555550142", email: null, tags: [], opted_out: false, saved, created_at: recent(5), updated_at: recent(5) });
    const { call, calls } = await connect({}, {
        "GET /v1/contacts": ({ url }) => envelope(url.searchParams.get("saved") === "false"
            ? { data: [contact("contact_9", null, false)], next_cursor: "u2", has_more: true, limit: 10 }
            : { data: [contact("contact_1", "Ava Chen", true)], next_cursor: "page2", has_more: true, limit: 10 }),
    });
    const saved = await call("find_contacts", {});
    assert.equal(saved.isError, false, saved.text);
    assert.match(saved.text, /Ava Chen/);
    assert.match(saved.text, /cursor "page2"/);
    const unsaved = await call("find_contacts", { unsaved: true, limit: 5 });
    assert.match(unsaved.text, /not saved/);
    assert.match(unsaved.text, /cursor "u2" and unsaved: true/);
    const lists = calls.filter((c) => c.key === "GET /v1/contacts");
    assert.deepEqual(lists.map((c) => c.query.saved), ["true", "false"]);
    assert.equal(lists[1].query.limit, "5");
});

test("the --enable-invoke-api flag adds invoke_api", async () => {
    const { spawnSync } = await import("node:child_process");
    const help = spawnSync(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname, "--help"], { encoding: "utf8" });
    assert.match(help.stdout, /--enable-invoke-api/);
    assert.match(help.stdout, /invoke_api/);
    assert.doesNotMatch(help.stdout, /call_api|enable-call-api/);
});

// ---- Workflows ----------------------------------------------------------------------------------

const contactAva = { contact_id: "contact_ava", phone_number: AVA, name: "Ava Chen", tags: [], stage: "lead", assigned_team_member: null, opted_out: false, messaging_allowed: true, saved: true, created_at: "2026-10-28T10:00:00.000Z", updated_at: "2026-10-28T10:00:00.000Z" };
const contactSam = { ...contactAva, contact_id: "contact_sam", phone_number: SAM, name: "Sam" };

// A fake enrollments endpoint that, like Blujay, answers a repeated request_id with the first result and a 200.
function enrollmentsApi(result = (body) => ({ enrollment_status: "run_created", workflow_run: { status: "active" } })) {
    const seen = new Map();
    return ({ url, body }) => {
        const workflowId = url.pathname.split("/")[3];
        const key = `${workflowId} ${body.contact_id} ${body.request_id}`;
        const repeat = seen.has(key);
        if (!repeat) seen.set(key, { workflow_id: workflowId, contact_id: body.contact_id, request_id: body.request_id, ...result(body) });
        const data = seen.get(key);
        return envelope(data, repeat || data.enrollment_status === "no_op" ? 200 : 201);
    };
}

test("list_workflows lists each manual workflow's label and ID, and says tag-triggered ones start by tagging", async () => {
    const { call, client } = await connect({}, {
        "GET /v1/workflows": () => envelope({ workflows: [
            { workflow_id: "workflow_demo", label: "Website demo texts" },
            { workflow_id: "workflow_welcome", label: "New customer welcome" },
        ] }),
    });
    const tool = (await client.listTools()).tools.find((t) => t.name === "list_workflows");
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.match(tool.description, /start manually/);
    assert.match(tool.description, /tag is added aren't listed/);
    assert.match(tool.description, /save_contact/);
    const { text, isError } = await call("list_workflows");
    assert.equal(isError, false);
    assert.match(text, /- Website demo texts \(workflow_id: workflow_demo\)/);
    assert.match(text, /- New customer welcome \(workflow_id: workflow_welcome\)/);
    assert.match(text, /tagging the contact with save_contact/);

    const empty = await connect({}, { "GET /v1/workflows": () => envelope({ workflows: [] }) });
    assert.match((await empty.call("list_workflows")).text, /No active, published workflows that start manually/);
});

test("enroll_in_workflow is a write tool that warns it texts a real person and says to look the contact up first", async () => {
    const { client } = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === "enroll_in_workflow");
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.match(tool.description, /This sends a real text to a real person; there is no test mode\./);
    assert.match(tool.description, /find_contacts/);
    assert.deepEqual(tool.inputSchema.required.sort(), ["contact_id", "workflow_id"]);
});

test("enroll_in_workflow starts a run and says so in plain words", async () => {
    const { call, calls } = await connect({}, { "POST /v1/workflows/workflow_demo/enrollments": enrollmentsApi() });
    const { text, isError } = await call("enroll_in_workflow", {
        workflow_id: "workflow_demo",
        contact_id: "contact_ava",
        request_id: "signup-A1042",
        metadata: { source: "claude", external_id: "A-1042" },
    });
    assert.equal(isError, false);
    const sends = calls.filter((c) => c.key === "POST /v1/workflows/workflow_demo/enrollments");
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].body, { contact_id: "contact_ava", request_id: "signup-A1042", metadata: { source: "claude", external_id: "A-1042" } });
    assert.match(text, /^Enrolled: the workflow started/);
    assert.match(text, /The run is active\./);
    assert.match(text, /request_id: signup-A1042/);
});

test("enrolling the same contact twice without a request_id reuses one, so they're never enrolled twice", async () => {
    const { call, calls } = await connect({}, { "POST /v1/workflows/workflow_demo/enrollments": enrollmentsApi() });
    const first = await call("enroll_in_workflow", { workflow_id: "workflow_demo", contact_id: "contact_ava" });
    const second = await call("enroll_in_workflow", { workflow_id: "workflow_demo", contact_id: "contact_ava" });
    const sends = calls.filter((c) => c.key === "POST /v1/workflows/workflow_demo/enrollments");
    assert.equal(sends.length, 2);
    assert.match(sends[0].body.request_id, /^mcp-/);
    assert.equal(sends[1].body.request_id, sends[0].body.request_id, "the retry reuses the request_id");
    assert.match(first.text, /^Enrolled/);
    assert.match(second.text, /^Already enrolled/);
    assert.match(second.text, /won't get the texts twice/);

    // A different contact gets its own request_id.
    await call("enroll_in_workflow", { workflow_id: "workflow_demo", contact_id: "contact_sam" });
    const third = calls.filter((c) => c.key === "POST /v1/workflows/workflow_demo/enrollments")[2];
    assert.notEqual(third.body.request_id, sends[0].body.request_id);
});

test("enroll_in_workflow explains an opted-out contact and one already in the workflow", async () => {
    const { call } = await connect({}, {
        "POST /v1/workflows/workflow_demo/enrollments": enrollmentsApi((body) =>
            body.contact_id === "contact_ava"
                ? { enrollment_status: "no_op", no_op_reason: "contact_opted_out", workflow_run: null }
                : { enrollment_status: "no_op", no_op_reason: "duplicate_non_terminal_run", workflow_run: { status: "waiting" } },
        ),
    });
    const optedOut = await call("enroll_in_workflow", { workflow_id: "workflow_demo", contact_id: "contact_ava" });
    assert.equal(optedOut.isError, false);
    assert.match(optedOut.text, /^Not enrolled: this contact has opted out/);
    const duplicate = await call("enroll_in_workflow", { workflow_id: "workflow_demo", contact_id: "contact_sam" });
    assert.match(duplicate.text, /^Not enrolled again: this contact is already in a run of this workflow/);
    assert.match(duplicate.text, /The run is waiting\./);
});

test("enroll_in_workflow errors come back with the next step", async () => {
    const { call } = await connect({}, {
        "POST /v1/workflows/workflow_tag/enrollments": () => apiError(409, "WORKFLOW_LIFECYCLE_ERROR", "Workflow not accepting enrollments"),
        "POST /v1/workflows/workflow_draft/enrollments": () => apiError(422, "WORKFLOW_VALIDATION_ERROR", "Enrollment invalid"),
        "POST /v1/workflows/workflow_lost/enrollments": () => {
            throw new TypeError("fetch failed");
        },
    });
    const lifecycle = await call("enroll_in_workflow", { workflow_id: "workflow_tag", contact_id: "contact_ava" });
    assert.equal(lifecycle.isError, true);
    assert.match(lifecycle.text, /409 WORKFLOW_LIFECYCLE_ERROR/);
    assert.match(lifecycle.text, /Pick one from list_workflows/);
    const validation = await call("enroll_in_workflow", { workflow_id: "workflow_draft", contact_id: "contact_ava" });
    assert.match(validation.text, /422 WORKFLOW_VALIDATION_ERROR/);
    assert.match(validation.text, /published version/);
    const lost = await call("enroll_in_workflow", { workflow_id: "workflow_lost", contact_id: "contact_ava", request_id: "order-77" });
    assert.equal(lost.isError, true);
    assert.match(lost.text, /may have gone through/);
    assert.match(lost.text, /request_id "order-77" is safe/);
});

test("--allow-send-to only enrolls contacts on the list, before calling the enrollment", async () => {
    const { call, calls } = await connect({ allowSendTo: [AVA] }, {
        "GET /v1/contacts/contact_ava": () => envelope(contactAva),
        "GET /v1/contacts/contact_sam": () => envelope(contactSam),
        "POST /v1/workflows/workflow_demo/enrollments": enrollmentsApi(),
    });
    const blocked = await call("enroll_in_workflow", { workflow_id: "workflow_demo", contact_id: "contact_sam" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /only reaches \+15555550123/);
    assert.equal(calls.filter((c) => c.key.startsWith("POST")).length, 0, "nobody was enrolled");
    const allowed = await call("enroll_in_workflow", { workflow_id: "workflow_demo", contact_id: "contact_ava" });
    assert.equal(allowed.isError, false);
    assert.match(allowed.text, /^Enrolled/);
});
