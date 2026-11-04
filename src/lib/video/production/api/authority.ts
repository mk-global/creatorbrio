/**
 * Who is calling the Production API, decided by the server from a credential,
 * never from the request body (WS1 #120).
 *
 * - **Human**: the request carries the local human key in the
 *   `X-CreatorBrio-Human-Key` header. The key is 32 random bytes kept in
 *   `data/video-studio.key`, created with owner-only permissions on first use.
 *   It is never served over HTTP, so a web page, another site, or a process
 *   that can only reach the loopback port cannot obtain it.
 * - **Agent**: the request carries `Authorization: Bearer <run token>`. A run
 *   token is minted when a person begins an agent run, is bound to that one
 *   production and run, and is held only as a hash in this process's memory.
 *   It ends with the run and with the server process, so a restarted server
 *   never honours a token from before the restart.
 * - **Anonymous**: no credential. Reads only.
 *
 * Any `by`, `actor`, `role`, `userId`, `runId` or approval field in a body is
 * refused, not interpreted: the actor and the run come from the credential.
 *
 * Limits: a process running as the same operating-system user with a shell
 * can read the key file, as it can read and edit `data/` directly. The
 * specification gives video agents MCP tools only, with no shell and no
 * access to `data/` (spec 06 §9), and the key is what separates them, and
 * every other caller, from a person.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

export const HUMAN_KEY_HEADER = "x-creatorbrio-human-key";
const KEY_PATTERN = /^[0-9a-f]{64}$/;

export type Authority =
  | { kind: "anonymous" }
  | { kind: "human" }
  | { kind: "agent"; productionId: string; runId: string };

export type AuthorityResult = { ok: true; authority: Authority } | { ok: false; code: "invalid_credential" | "ambiguous_credential"; message: string };

interface Grant {
  productionId: string;
  runId: string;
}

const hash = (token: string) => createHash("sha256").update(token, "utf-8").digest();

function sameSecret(given: string, expected: string): boolean {
  const a = hash(given);
  const b = hash(expected);
  return timingSafeEqual(a, b);
}

export class AuthorityRegistry {
  private readonly keyFile: string;
  private key: string | null = null;
  /** Run tokens by the hex of their SHA-256; the tokens themselves are not kept. */
  private readonly grants = new Map<string, Grant>();

  constructor(keyFile: string) {
    this.keyFile = keyFile;
  }

  /** Reads the human key, creating it with owner-only permissions if it does not exist. */
  async humanKey(): Promise<string> {
    if (this.key) return this.key;
    await mkdir(path.dirname(this.keyFile), { recursive: true });
    try {
      const handle = await open(this.keyFile, "wx", 0o600);
      try {
        await handle.writeFile(randomBytes(32).toString("hex"), "utf-8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const key = (await readFile(this.keyFile, "utf-8")).trim();
    if (!KEY_PATTERN.test(key)) throw new Error("the human key file is not a valid key; delete it to create a new one");
    this.key = key;
    return key;
  }

  /** Mints a token for one agent run on one production. It is returned once and stored only as a hash. */
  mintRunToken(productionId: string, runId: string): string {
    const token = `cbrun_${randomBytes(32).toString("hex")}`;
    this.grants.set(hash(token).toString("hex"), { productionId, runId });
    return token;
  }

  /** Revokes every token for a run, when the run ends or is taken over. */
  revokeRun(productionId: string, runId: string): void {
    for (const [digest, grant] of this.grants) {
      if (grant.productionId === productionId && grant.runId === runId) this.grants.delete(digest);
    }
  }

  async resolve(request: Request): Promise<AuthorityResult> {
    const humanHeader = request.headers.get(HUMAN_KEY_HEADER);
    const authorization = request.headers.get("authorization");
    if (humanHeader !== null && authorization !== null) {
      return { ok: false, code: "ambiguous_credential", message: "send either the human key or a run token, not both" };
    }
    if (humanHeader !== null) {
      const key = await this.humanKey();
      return sameSecret(humanHeader.trim(), key) ? { ok: true, authority: { kind: "human" } } : invalid();
    }
    if (authorization !== null) {
      const match = /^Bearer (cbrun_[0-9a-f]{64})$/.exec(authorization.trim());
      const grant = match && this.grants.get(hash(match[1]).toString("hex"));
      return grant ? { ok: true, authority: { kind: "agent", productionId: grant.productionId, runId: grant.runId } } : invalid();
    }
    return { ok: true, authority: { kind: "anonymous" } };
  }
}

function invalid(): AuthorityResult {
  return { ok: false, code: "invalid_credential", message: "the credential is not valid" };
}
