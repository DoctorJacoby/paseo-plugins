import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Where an `owner/repo#123` reference in Claude's prose points.
 * Claude Code's terminal links these itself, so the model writes them bare and the transcript carries no URL.
 */
export type IssueForge = {
  /** Scheme and host, such as `https://github.com`. */
  origin: string;
  gitlab: boolean;
};

const GITHUB: IssueForge = { origin: "https://github.com", gitlab: false };

/** Code, links and URLs already say what they mean, so a reference inside one is left as written. */
const PROTECTED = /(```|~~~)[\s\S]*?(?:\1|$)|(`+)[^`][\s\S]*?\2|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\s]+>|\bhttps?:\/\/\S+/g;

/** GitHub names a repository by owner and name only; GitLab nests it under any depth of groups. */
const GITHUB_REFERENCE = /(?<![\w./@:#-])([A-Za-z0-9-]+\/[\w.-]+)#(\d+)(?![\w-])/g;
const GITLAB_REFERENCE = /(?<![\w./@:#-])([\w-]+(?:\/[\w.-]+)+)#(\d+)(?![\w-])/g;

export async function readIssueForge(cwd: string): Promise<IssueForge> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 2_000 });
    return forgeFromRemote(stdout.trim());
  } catch {
    return GITHUB;
  }
}

export function forgeFromRemote(remote: string): IssueForge {
  const host = remoteWebHost(remote);
  if (!host) return GITHUB;
  return { origin: `https://${host}`, gitlab: host.toLowerCase().includes("gitlab") };
}

/** The host a remote's web pages are on: an SSH remote's port is the SSH server's, an HTTPS remote's is the web server's. */
function remoteWebHost(remote: string): string | null {
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/.exec(remote);
  if (scp) return scp[1]!;
  try {
    const url = new URL(remote);
    if (url.protocol === "http:" || url.protocol === "https:") return url.host || null;
    return url.hostname || null;
  } catch {
    return null;
  }
}

export function linkIssueReferences(markdown: string, forge: IssueForge): string {
  const reference = forge.gitlab ? GITLAB_REFERENCE : GITHUB_REFERENCE;
  const issuePath = forge.gitlab ? "-/issues" : "issues";
  const link = (prose: string) =>
    prose.replace(reference, (match, repository: string, number: string) => `[${match}](${forge.origin}/${repository}/${issuePath}/${number})`);
  let result = "";
  let last = 0;
  for (const match of markdown.matchAll(PROTECTED)) {
    result += link(markdown.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return result + link(markdown.slice(last));
}
