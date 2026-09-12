import { chmod, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";

const INLINE_RESOURCE_BYTES = 32 * 1024;

export type MaterializedPrompt = {
  text: string;
  files: string[];
};

/**
 * `reference` is how a file this wrote is named to Claude. It is that file's own path unless Claude
 * is in a container reading the directory through a mount of its own. What `files` holds stays host
 * paths either way, because cleaning them up afterwards is this side's to do.
 */
export async function materializePrompt(
  content: ContentBlock[],
  directory: string,
  cwd: string,
  reference: (file: string) => string = (file) => file,
): Promise<MaterializedPrompt> {
  const parts: string[] = [];
  const files: string[] = [];
  try {
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index]!;
      switch (block.type) {
        case "text":
          parts.push(block.text);
          break;
        case "image": {
          const file = await writeAttachment(directory, `image-${index}${extensionForMime(block.mimeType)}`, Buffer.from(block.data, "base64"));
          files.push(file);
          parts.push(`@${reference(file)}`);
          break;
        }
        case "audio":
          throw new Error("ACP audio prompt content is not supported by interactive Claude Code");
        case "resource_link": {
          const file = localResourcePath(block.uri, cwd);
          parts.push(`@${file}`);
          break;
        }
        case "resource": {
          const resource = block.resource;
          if ("text" in resource && Buffer.byteLength(resource.text) <= INLINE_RESOURCE_BYTES) {
            parts.push(`<resource uri=${JSON.stringify(resource.uri)}>\n${resource.text}\n</resource>`);
            break;
          }
          const data = "text" in resource ? Buffer.from(resource.text) : Buffer.from(resource.blob, "base64");
          const mimeType = resource.mimeType ?? ("text" in resource ? "text/plain" : "application/octet-stream");
          const file = await writeAttachment(directory, `resource-${index}${extensionForMime(mimeType)}`, data);
          files.push(file);
          parts.push(`@${reference(file)}`);
          break;
        }
      }
    }
    const text = parts.filter((part) => part.length > 0).join("\n");
    if (!text.trim()) throw new Error("Prompt must contain text or an attachment");
    return { text, files };
  } catch (error) {
    await cleanupPromptFiles(files);
    throw error;
  }
}

export async function cleanupPromptFiles(files: string[]): Promise<void> {
  await Promise.allSettled(files.map((file) => rm(file, { force: true })));
}

function localResourcePath(uri: string, cwd: string): string {
  let candidate: string;
  if (uri.startsWith("file:")) candidate = fileURLToPath(uri);
  else if (path.isAbsolute(uri)) candidate = uri;
  else if (!uri.includes(":")) candidate = path.resolve(cwd, uri);
  else throw new Error(`ACP resource ${uri} is not a host-local file`);
  return path.normalize(candidate);
}

async function writeAttachment(directory: string, name: string, data: Buffer): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, data, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

function extensionForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";")[0];
  return (
    {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/svg+xml": ".svg",
      "text/plain": ".txt",
      "text/markdown": ".md",
      "application/json": ".json",
      "application/pdf": ".pdf",
    }[normalized ?? ""] ?? ".bin"
  );
}
