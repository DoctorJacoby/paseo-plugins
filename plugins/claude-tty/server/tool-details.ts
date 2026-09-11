import type { AcpTransformer } from "@getpaseo/plugin/server/acp";
import type { ProviderConnection, ProviderEvent, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

/** Mirrors the adapter's own `TOOL_CALL_MIRROR_METHOD`; the plugin runs in the daemon and cannot import it. */
export const TOOL_CALL_MIRROR_METHOD = "_claude_tty/tool_call";

/** The JSON the host's own types are written in. The package that names it is not a dependency here. */
type Json = Extract<ProviderToolCallDetail, { type: "unknown" }>["input"];

type JsonRecord = { [key: string]: Json };

/** As much of an ACP tool call as a card is made of, gathered from every update about that one call. */
type Snapshot = {
  title: string;
  kind: string | null;
  content: JsonRecord[] | null;
  locations: string[] | null;
  rawInput: Json;
  rawOutput: Json;
};

/**
 * Rebuilds the tool-call cards the plugin's ACP bridge cannot.
 *
 * The bridge renders a call as an edit or as raw JSON and keeps nothing but `rawInput` and
 * `rawOutput` to do it with; the `kind`, the `content` blocks and the `locations` that say what the
 * call actually was are dropped before its `toolCall` hook runs, and its `notification` hook never
 * sees a `session/update` at all. So the adapter sends a copy of each update over a vendor method,
 * the transformer below keeps it, and the connection wrapper puts the card it describes onto the
 * item the bridge emits for the same call.
 *
 * It is a wrapper rather than the `{ type: "timeline", item }` a transformer can return, because a
 * transformer runs where its notification sits in the stream while an update runs on a lane of its
 * own: measured, an item returned from the hook is emitted *before* the bridge's own item for that
 * call and is then overwritten by it. Reading the copy on the way in and rewriting the item on the
 * way out settles the order instead of racing it.
 *
 * The mapping is the daemon's own `mapToolDetail`, so a session on this provider shows what the same
 * session shows on the daemon's built-in bridge. The one branch left out is the terminal content
 * block, which needs ACP terminals the adapter does not implement.
 */
export function toolCallDetails(): { transformer: AcpTransformer; wrap(connection: ProviderConnection): ProviderConnection } {
  // Per session, because a call is only named within one and because a session ending is then the
  // whole of the bookkeeping. What is held is a second copy of what the bridge holds for itself.
  const snapshots = new Map<string, Map<string, Snapshot>>();

  const decorate = (event: ProviderEvent): ProviderEvent => {
    if (event.type === "session.closed" || event.type === "session.runtime_failed") {
      snapshots.delete(event.sessionId);
      return event;
    }
    if (event.type !== "timeline.item" || event.item.type !== "tool_call") return event;
    const snapshot = snapshots.get(event.sessionId)?.get(event.item.callId);
    return snapshot === undefined ? event : { ...event, item: { ...event.item, detail: toolCallDetail(snapshot) } };
  };

  return {
    transformer: {
      notification({ method, params }, context) {
        if (method !== TOOL_CALL_MIRROR_METHOD) return null;
        const update = asRecord(asRecord(params)?.update);
        const toolCallId = update === null ? null : asString(update.toolCallId);
        if (update === null || toolCallId === null) return null;
        const session = snapshots.get(context.sessionId) ?? new Map<string, Snapshot>();
        snapshots.set(context.sessionId, session.set(toolCallId, merge(update, session.get(toolCallId))));
        // Nothing is emitted here: the wrapper below is what carries this onto the card.
        return null;
      },
    },
    wrap(connection: ProviderConnection): ProviderConnection {
      return {
        version: connection.version,
        capabilities: connection.capabilities,
        send: (input) => connection.send(input),
        // Rewriting an item is a pure mapping, so every listener may have its own subscription.
        onEvent: (listener) => connection.onEvent((event) => listener(decorate(event))),
        async close() {
          snapshots.clear();
          await connection.close();
        },
      };
    },
  };
}

/** ACP replaces a tool call's content and locations rather than adding to them, and so does this. */
function merge(update: JsonRecord, previous: Snapshot | undefined): Snapshot {
  return {
    title: asString(update.title) ?? previous?.title ?? "",
    kind: asString(update.kind) ?? previous?.kind ?? null,
    content: asRecords(update.content) ?? previous?.content ?? null,
    locations: asLocations(update.locations) ?? previous?.locations ?? null,
    rawInput: update.rawInput !== undefined ? update.rawInput : (previous?.rawInput ?? null),
    rawOutput: update.rawOutput !== undefined ? update.rawOutput : (previous?.rawOutput ?? null),
  };
}

function toolCallDetail(snapshot: Snapshot): ProviderToolCallDetail {
  const text = contentText(snapshot.content);
  const diff = contentDiff(snapshot.content);
  const input = asRecord(snapshot.rawInput);
  const output = asRecord(snapshot.rawOutput);
  const filePath = snapshot.locations?.[0] ?? readString(input, ["path", "filePath", "file"]) ?? snapshot.title;
  switch (snapshot.kind) {
    case "read":
      return {
        type: "read",
        filePath,
        content: text ?? readString(output, ["content", "text"]),
        offset: readNumber(input, ["offset", "line"]),
        limit: readNumber(input, ["limit"]),
      };
    case "edit":
    case "delete":
      return {
        type: "edit",
        filePath,
        oldString: diff?.oldText ?? readString(input, ["oldText", "oldString"]),
        newString: snapshot.kind === "delete" ? "" : (diff?.newText ?? readString(input, ["newText", "newString"])),
        unifiedDiff: text,
      };
    case "search":
      return {
        type: "search",
        query: readString(input, ["query", "pattern"]) ?? snapshot.title,
        toolName: "search",
        content: text ?? readString(output, ["content", "text"]),
        filePaths: snapshot.locations ?? undefined,
      };
    case "execute":
      return {
        type: "shell",
        command: shellCommand(input) ?? snapshot.title,
        cwd: readString(input, ["cwd"]),
        output: text ?? readString(output, ["output", "text"]),
        exitCode: readNumber(output, ["exitCode"]),
      };
    case "fetch":
      return {
        type: "fetch",
        url: readString(input, ["url"]) ?? snapshot.title,
        prompt: readString(input, ["prompt"]),
        result: text ?? readString(output, ["result", "text", "content"]),
        code: readNumber(output, ["status", "code"]),
      };
    default:
      // Where the tool is one nothing here has a card for, the text it produced is the card. That is
      // what carries a subagent's running log, which the adapter sends as content and nothing else.
      if (text !== undefined) return { type: "plain_text", label: snapshot.title, text, icon: "wrench" };
      return { type: "unknown", input: snapshot.rawInput, output: snapshot.rawOutput };
  }
}

function contentText(content: JsonRecord[] | null): string | undefined {
  const parts: string[] = [];
  for (const item of content ?? []) {
    if (item.type !== "content") continue;
    const text = blockText(asRecord(item.content));
    if (text !== null && text !== "") parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function blockText(block: JsonRecord | null): string | null {
  if (block === null) return null;
  switch (block.type) {
    case "text":
      return asString(block.text);
    case "resource_link":
      return asString(block.title) ?? asString(block.uri);
    case "resource": {
      const resource = asRecord(block.resource);
      const text = resource === null ? null : asString(resource.text);
      return text ?? `[resource:${(resource === null ? null : asString(resource.mimeType)) ?? "binary"}]`;
    }
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    default:
      return null;
  }
}

function contentDiff(content: JsonRecord[] | null): { oldText: string | undefined; newText: string | undefined } | null {
  const diff = (content ?? []).find((item) => item.type === "diff");
  return diff === undefined ? null : { oldText: asString(diff.oldText) ?? undefined, newText: asString(diff.newText) ?? undefined };
}

function shellCommand(input: JsonRecord | null): string | undefined {
  const command = readString(input, ["command"]);
  if (command === undefined) return undefined;
  const args = Array.isArray(input?.args) ? input.args.filter((value) => typeof value === "string") : [];
  return args.length > 0 ? `${command} ${args.join(" ")}` : command;
}

function readString(record: JsonRecord | null, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function readNumber(record: JsonRecord | null, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function asLocations(value: Json | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const path = asString(asRecord(entry)?.path);
    return path === null ? [] : [path];
  });
}

function asRecords(value: Json | undefined): JsonRecord[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    return record === null ? [] : [record];
  });
}

function asRecord(value: Json | undefined): JsonRecord | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asString(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}
