/**
 * The contained Design Agent's own sign-in (#246).
 *
 * The contained CLI signs in with a long-lived token of its own, created by
 * `claude setup-token`, which, as documented, the CLI neither refreshes nor
 * stores. The server
 * reads it from one owner-only file outside the repository, the data folder
 * and the agent's folders, and passes it to the CLI as
 * `CLAUDE_CODE_OAUTH_TOKEN` (`containedEnv`); the CLI's environment scrub
 * keeps it out of the agent's shell, and the profile denies the shell and the
 * `Read` tool the file by name. Nothing else signs the contained CLI in: no
 * credential from the server's environment, and neither the person's keychain
 * nor their credentials file, so a contained run is designed never to share,
 * refresh or change the person's own Claude Code sign-in. Planning (the Visual Director)
 * is not contained and still uses that sign-in, with its storage and locks.
 *
 * The file is `~/.creatorbrio/design-agent-token`, beside the agent folders'
 * default root and inside the home folder the profile read-denies, or the
 * absolute path `CREATORBRIO_DESIGN_AGENT_TOKEN_FILE` names. It must be a
 * regular file with one name only (no other hard link, which would be a second
 * path to the token that no check here covers), never a symbolic link, owned by
 * the person running the server, with no group or other access; it is read
 * without following a link, and one trailing newline is dropped. The token is never logged, printed or placed in
 * a message: every refusal names the file only as the person configured it.
 */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const AGENT_TOKEN_FILE_ENV = "CREATORBRIO_DESIGN_AGENT_TOKEN_FILE";

/** The default file, as messages show it: home-relative, never the absolute path. */
export const DEFAULT_TOKEN_FILE_SHOWN = "~/.creatorbrio/design-agent-token";

/** A token is one line of printable characters; the setup token is far shorter than this. */
const MAX_TOKEN_BYTES = 4096;
const TOKEN = /^[\x21-\x7e]+$/;

/** The default file under a home folder. */
export function defaultAgentTokenFile(home: string = os.homedir()): string {
  return path.join(home, ".creatorbrio", "design-agent-token");
}

/** Why the contained Design Agent cannot sign in, in words for Home, Settings and the chat; never the token. */
export interface SignInRefusal {
  ok: false;
  reason: string;
  guidance: string;
}

/** The sign-in, or why there is none. `file` is the token file's real path, which the profile denies the agent by name. */
export type AgentSignIn = { ok: true; token: string; file: string } | SignInRefusal;

/** A launch refused because the contained CLI has no usable sign-in; its message names no path and no token. */
export class AgentSignInError extends Error {
  readonly reason: string;
  readonly guidance: string;

  constructor(refusal: SignInRefusal) {
    super(refusal.reason);
    this.name = "AgentSignInError";
    this.reason = refusal.reason;
    this.guidance = refusal.guidance;
  }
}

/** How a message names the file: the default as `~/...`, a configured one by its setting, never by its path. */
function shown(configured: boolean): string {
  return configured ? `the file ${AGENT_TOKEN_FILE_ENV} names` : DEFAULT_TOKEN_FILE_SHOWN;
}

/** What to do about a missing or unusable token, shared by every refusal so the steps are always the same. */
export function tokenGuidance(configured: boolean): string {
  return (
    `Run \`claude setup-token\` in a terminal, then save the token it prints, alone, in ${shown(configured)}, readable only by you (\`chmod 600\`)` +
    (configured ? "" : `, or set ${AGENT_TOKEN_FILE_ENV} to another absolute path`) +
    ". The token lasts a year: replace it the same way before it expires, then run `npm run doctor`."
  );
}

/** The token file the settings name: the absolute path in the setting, or the default. */
export function agentTokenFile(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir()
): { ok: true; file: string; configured: boolean } | SignInRefusal {
  const configured = env[AGENT_TOKEN_FILE_ENV]?.trim();
  if (!configured) return { ok: true, file: defaultAgentTokenFile(home), configured: false };
  if (!path.isAbsolute(configured)) {
    return { ok: false, reason: `${AGENT_TOKEN_FILE_ENV} must be an absolute path.`, guidance: `Set it to the absolute path of the token file, or remove it to use ${DEFAULT_TOKEN_FILE_SHOWN}.` };
  }
  return { ok: true, file: path.resolve(configured), configured: true };
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** A folder's real path, or its resolved spelling when it does not exist yet. */
async function realOrResolved(dir: string): Promise<string> {
  return realpath(dir).catch(() => path.resolve(dir));
}

/**
 * Reads the token from `file`, refusing anything but a private regular file
 * of `uid` outside the folders named in `forbidden` (each with how a message
 * names it). The file is opened without following a link (and without
 * blocking on a FIFO), and checked through the open handle, so a link or
 * another file swapped in after a check is never read.
 */
export async function readAgentToken(input: {
  file: string;
  configured: boolean;
  uid: number;
  forbidden: readonly { dir: string; what: string }[];
}): Promise<AgentSignIn> {
  const where = shown(input.configured);
  const guidance = tokenGuidance(input.configured);
  const refuse = (reason: string, extra = guidance): SignInRefusal => ({ ok: false, reason, guidance: extra });
  // The folder's real path with the file's own name: the file itself is never followed.
  const dir = await realpath(path.dirname(input.file)).catch(() => null);
  if (dir === null) return refuse("The contained Design Agent has no sign-in token of its own.");
  const file = path.join(dir, path.basename(input.file));
  for (const { dir: forbidden, what } of input.forbidden) {
    if (isInside(file, await realOrResolved(forbidden))) {
      return refuse(`The Design Agent's sign-in token file, ${where}, is inside ${what}, where it must not be.`, `Move it outside ${what}. ${guidance}`);
    }
  }
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return refuse("The contained Design Agent has no sign-in token of its own.");
    if (code === "ELOOP" || code === "EMLINK") return refuse(`The Design Agent's sign-in token file, ${where}, is a link.`, `Replace the link with the file itself. ${guidance}`);
    return refuse(`The Design Agent's sign-in token file, ${where}, could not be read.`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return refuse(`The Design Agent's sign-in token file, ${where}, is not a regular file.`);
    if (info.nlink !== 1) {
      return refuse(
        `The Design Agent's sign-in token file, ${where}, has more than one name (a hard link), so the token can also be reached by another path.`,
        `Save the token in a new file of its own and remove the other names. ${guidance}`
      );
    }
    if (info.uid !== input.uid) return refuse(`The Design Agent's sign-in token file, ${where}, belongs to another account.`);
    if ((info.mode & 0o077) !== 0) {
      return refuse(`The Design Agent's sign-in token file, ${where}, can be read or changed by other accounts.`, `Make it readable only by you (\`chmod 600\`), then run \`npm run doctor\`.`);
    }
    const buffer = Buffer.alloc(MAX_TOKEN_BYTES + 3);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (text.endsWith("\r\n")) text = text.slice(0, -2);
    else if (text.endsWith("\n")) text = text.slice(0, -1);
    if (text.length === 0 || Buffer.byteLength(text) > MAX_TOKEN_BYTES || !TOKEN.test(text)) {
      return refuse(`The Design Agent's sign-in token file, ${where}, does not hold one token.`, `Save only the token \`claude setup-token\` printed, on one line. ${guidance}`);
    }
    return { ok: true, token: text, file };
  } catch {
    return refuse(`The Design Agent's sign-in token file, ${where}, could not be read.`);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * The contained CLI's sign-in under the current settings: the token file the
 * settings name, read as `readAgentToken` reads it, refused inside the
 * repository, the data folder, the agent folders' root and the per-user
 * temporary parent.
 */
export async function agentSignIn(input: {
  env?: Record<string, string | undefined>;
  home?: string;
  uid?: number;
  repoDir: string;
  dataDir: string;
  workspaceRoot: string | null;
  tempRoot: string;
}): Promise<AgentSignIn> {
  const located = agentTokenFile(input.env ?? process.env, input.home ?? os.homedir());
  if (!located.ok) return located;
  const forbidden = [
    { dir: input.repoDir, what: "the CreatorBrio folder" },
    { dir: input.dataDir, what: "the data folder" },
    ...(input.workspaceRoot === null ? [] : [{ dir: input.workspaceRoot, what: "the Design Agent's folders" }]),
    { dir: input.tempRoot, what: "the Design Agent's temporary folder" },
  ];
  return readAgentToken({ file: located.file, configured: located.configured, uid: input.uid ?? process.getuid?.() ?? 0, forbidden });
}
