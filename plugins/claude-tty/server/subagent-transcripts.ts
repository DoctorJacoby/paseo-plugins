import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { newScan, readNewLines, readWhole, type FileScan } from "./transcript-scan.ts";

const FILE_PREFIX = "agent-";
const FILE_SUFFIX = ".jsonl";
const META_SUFFIX = ".meta.json";

/** A subagent's whole run is one Claude turn, so what it says is worth showing at length. */
const TEXT_CHARS = 4_000;

export function agentIdFromFileName(name: string): string | null {
  if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) return null;
  const agentId = name.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
  return agentId === "" ? null : agentId;
}

/**
 * The sidecar Claude writes beside every subagent transcript. `toolUseId` is the whole reason it is
 * read: it names the tool call in the session's own conversation that launched this agent, which is
 * the only handle the two sides share, and the only thing that says when the agent has stopped.
 */
export type SubagentSidecar = {
  agentId: string;
  toolUseId: string | null;
  agentType: string | null;
  description: string | null;
  /** Launched by another subagent rather than by the session, whose spawner nothing here names. */
  nested: boolean;
};

export function parseSidecar(agentId: string, contents: string | null): SubagentSidecar | null {
  const record = parseObject(contents);
  if (record === null) return null;
  return {
    agentId,
    toolUseId: text(record.toolUseId),
    agentType: text(record.agentType),
    description: text(record.description),
    nested: typeof record.spawnDepth === "number" && record.spawnDepth > 1,
  };
}

/** Every subagent a session has on disk, named by the sidecar Claude wrote beside its transcript. */
export async function readSidecars(directory: string): Promise<SubagentSidecar[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    // A session that has never run a subagent has no directory of them, which is not a failure.
    if (isMissing(error)) return [];
    throw error;
  }
  const sidecars: SubagentSidecar[] = [];
  for (const name of names.sort()) {
    const agentId = agentIdFromFileName(name);
    if (agentId === null) continue;
    const sidecar = parseSidecar(agentId, await readWhole(path.join(directory, `${FILE_PREFIX}${agentId}${META_SUFFIX}`)));
    if (sidecar !== null) sidecars.push(sidecar);
  }
  return sidecars;
}

/**
 * Follows one subagent's transcript. It is appended to for as long as the agent runs and reaches
 * megabytes, so it is read the way the adapter reads the session's own: once from the start, then
 * only what is new. Nothing rewrites a subagent's transcript, so a rewind can only be a truncation,
 * and the tool calls already sent are forgotten with it.
 */
export class SubagentTranscript {
  private readonly file: string;
  private readonly scan: FileScan = newScan();
  /** The tool calls already sent as running, so a result knows which item to close. */
  private readonly pending = new Map<string, ProviderTimelineItem>();
  private index = 0;

  constructor(directory: string, agentId: string) {
    this.file = path.join(directory, `${FILE_PREFIX}${agentId}${FILE_SUFFIX}`);
  }

  /** What the agent has done since the last read, as the timeline items a subsession carries. */
  async read(): Promise<ProviderTimelineItem[]> {
    return readNewLines(this.file, this.scan, (lines) => {
      if (lines.rewritten) this.pending.clear();
      return this.translate(parseRecords(lines.text));
    }).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
  }

  /** The tool calls still shown as running when the agent stopped, which nothing else will close. */
  settle(): ProviderTimelineItem[] {
    const items = [...this.pending.values()].map((item) =>
      item.type === "tool_call" ? { ...item, status: "canceled" as const, error: null } : item,
    );
    this.pending.clear();
    return items;
  }

  private translate(records: readonly Record<string, unknown>[]): ProviderTimelineItem[] {
    const items: ProviderTimelineItem[] = [];
    for (const record of records) {
      const content = asRecord(record.message)?.content;
      // The prompt a subagent was handed is a plain string rather than a list of blocks.
      if (record.type === "user" && typeof content === "string") {
        items.push({ id: this.nextId(), type: "user_message", text: truncate(content, TEXT_CHARS) });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const value of content) {
        const block = asRecord(value);
        if (block === null) continue;
        const item = this.translateBlock(record, block);
        if (item !== null) items.push(item);
      }
    }
    return items;
  }

  private translateBlock(record: Record<string, unknown>, block: Record<string, unknown>): ProviderTimelineItem | null {
    if (record.type === "user" && block.type === "text" && typeof block.text === "string") {
      return { id: this.nextId(), type: "user_message", text: truncate(block.text, TEXT_CHARS) };
    }
    if (record.type === "assistant" && block.type === "text" && typeof block.text === "string") {
      const text = block.text.trim();
      return text === "" ? null : { id: this.nextId(), type: "assistant_message", text: truncate(text, TEXT_CHARS) };
    }
    if (record.type === "assistant" && block.type === "tool_use" && typeof block.id === "string") {
      const item: ProviderTimelineItem = {
        id: block.id,
        type: "tool_call",
        callId: block.id,
        name: typeof block.name === "string" && block.name !== "" ? block.name : "Tool",
        detail: toolDetail(typeof block.name === "string" ? block.name : "", asRecord(block.input) ?? {}),
        status: "running",
        error: null,
      };
      this.pending.set(block.id, item);
      return item;
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const started = this.pending.get(block.tool_use_id);
      if (started === undefined || started.type !== "tool_call") return null;
      this.pending.delete(block.tool_use_id);
      const output = resultText(block.content);
      return block.is_error === true
        ? { ...started, status: "failed", error: output ?? "The tool call failed." }
        : { ...started, status: "completed", error: null, detail: withOutput(started.detail, output) };
    }
    return null;
  }

  /** Timeline identity is per subsession, and a text block carries none of Claude's own. */
  private nextId(): string {
    this.index += 1;
    return `message-${this.index}`;
  }
}

type ToolDetail = Extract<ProviderTimelineItem, { type: "tool_call" }>["detail"];

/**
 * The shape the host has a renderer for, where the tool is one it knows. Everything else is a line
 * of plain text, which is what a card with no renderer of its own would have shown anyway.
 */
function toolDetail(name: string, input: Record<string, unknown>): ToolDetail {
  const filePath = text(input.file_path) ?? text(input.notebook_path);
  if (name === "Bash" && text(input.command) !== null) {
    return { type: "shell", command: text(input.command) ?? "", cwd: text(input.cwd) ?? undefined };
  }
  if ((name === "Read" || name === "NotebookEdit") && filePath !== null) return { type: "read", filePath };
  if (name === "Write" && filePath !== null) return { type: "write", filePath, content: text(input.content) ?? undefined };
  if (name === "Edit" && filePath !== null) {
    return {
      type: "edit",
      filePath,
      oldString: text(input.old_string) ?? undefined,
      newString: text(input.new_string) ?? undefined,
    };
  }
  if (name === "Grep" || name === "Glob") {
    return { type: "search", query: text(input.pattern) ?? "", toolName: name === "Grep" ? "grep" : "glob" };
  }
  if ((name === "WebFetch" || name === "WebSearch") && (text(input.url) ?? text(input.query)) !== null) {
    return name === "WebFetch"
      ? { type: "fetch", url: text(input.url) ?? "", prompt: text(input.prompt) ?? undefined }
      : { type: "search", query: text(input.query) ?? "", toolName: "web_search" };
  }
  return {
    type: "plain_text",
    label: name === "" ? undefined : name,
    text: text(input.description) ?? text(input.command) ?? filePath ?? text(input.pattern) ?? text(input.query) ?? undefined,
  };
}

/** Only the details with somewhere to put it carry what a tool call came back with. */
function withOutput(detail: ToolDetail, output: string | null): ToolDetail {
  if (output === null) return detail;
  if (detail.type === "shell") return { ...detail, output };
  if (detail.type === "read") return { ...detail, content: output };
  if (detail.type === "search") return { ...detail, content: output };
  if (detail.type === "fetch") return { ...detail, result: output };
  if (detail.type === "plain_text") return { ...detail, text: detail.text ?? output };
  return detail;
}

const OUTPUT_CHARS = 8_000;

function resultText(content: unknown): string | null {
  const blocks = typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
  const parts: string[] = [];
  for (const value of blocks) {
    const part = typeof value === "string" ? value : asRecord(value)?.type === "text" ? asRecord(value)?.text : null;
    if (typeof part === "string" && part.trim() !== "") parts.push(part);
  }
  return parts.length === 0 ? null : truncate(parts.join("\n"), OUTPUT_CHARS);
}

export function parseRecords(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // A half-written final line is the normal state of a transcript being appended to.
    }
  }
  return records;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseObject(contents: string | null): Record<string, unknown> | null {
  if (contents === null) return null;
  try {
    return asRecord(JSON.parse(contents));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
