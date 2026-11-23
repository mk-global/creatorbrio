/**
 * The contained Design Agent's own sign-in token file (#246): only a private
 * regular file of this user, outside the repository, the data folder and the
 * agent's folders, read without following a link; every refusal says what to
 * do and names neither the file's path nor the token.
 */
import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_TOKEN_FILE_ENV, agentSignIn, agentTokenFile, DEFAULT_TOKEN_FILE_SHOWN, defaultAgentTokenFile, readAgentToken, type AgentSignIn } from "@/lib/agent-sign-in";

const TOKEN = "sk-ant-oat01-synthetic-0123456789abcdef";
const uid = process.getuid?.() ?? 0;
let base: string;
let file: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "cb-sign-in-")));
  file = path.join(base, "secrets", "design-agent-token");
  await mkdir(path.dirname(file), { mode: 0o700 });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const read = (overrides: Partial<Parameters<typeof readAgentToken>[0]> = {}) => readAgentToken({ file, configured: true, uid, forbidden: [], ...overrides });
const refusal = (result: AgentSignIn) => {
  expect(result.ok).toBe(false);
  const text = JSON.stringify(result);
  // Never the path, never the token.
  expect(text).not.toContain(base);
  expect(text).not.toContain(TOKEN);
  return result as Extract<AgentSignIn, { ok: false }>;
};

describe("the token file the settings name", () => {
  it("is ~/.creatorbrio/design-agent-token by default, beside the agent folders' default root", () => {
    expect(agentTokenFile({}, "/Users/designer")).toEqual({ ok: true, file: "/Users/designer/.creatorbrio/design-agent-token", configured: false });
    expect(defaultAgentTokenFile("/home/designer")).toBe("/home/designer/.creatorbrio/design-agent-token");
    expect(DEFAULT_TOKEN_FILE_SHOWN).toBe("~/.creatorbrio/design-agent-token");
  });

  it("is the absolute path the setting names, and a relative one is refused", () => {
    expect(agentTokenFile({ [AGENT_TOKEN_FILE_ENV]: " /srv/secrets/token " }, "/Users/designer")).toEqual({ ok: true, file: "/srv/secrets/token", configured: true });
    expect(agentTokenFile({ [AGENT_TOKEN_FILE_ENV]: "token" }, "/Users/designer")).toMatchObject({ ok: false, reason: expect.stringMatching(/must be an absolute path/) });
  });
});

describe("reading the token", () => {
  it("reads a private regular file's one line, dropping one trailing newline only", async () => {
    for (const [text, expected] of [
      [TOKEN, TOKEN],
      [`${TOKEN}\n`, TOKEN],
      [`${TOKEN}\r\n`, TOKEN],
    ]) {
      await writeFile(file, text, { mode: 0o600 });
      expect(await read()).toEqual({ ok: true, token: expected, file });
    }
    for (const text of [`${TOKEN}\n\n`, "", "\n", `${TOKEN} extra`, `${TOKEN}\nsecond`, `\t${TOKEN}`, "x".repeat(4097)]) {
      await writeFile(file, text, { mode: 0o600 });
      expect(refusal(await read()).reason).toMatch(/does not hold one token/);
    }
  });

  it("says how to make one when there is none, naming the default as ~/ and a configured file by its setting", async () => {
    const absent = refusal(await read({ configured: false }));
    expect(absent.reason).toMatch(/no sign-in token of its own/);
    expect(absent.guidance).toMatch(/claude setup-token.*~\/\.creatorbrio\/design-agent-token.*chmod 600.*CREATORBRIO_DESIGN_AGENT_TOKEN_FILE.*lasts a year.*npm run doctor/);
    expect(refusal(await read()).guidance).toMatch(/the file CREATORBRIO_DESIGN_AGENT_TOKEN_FILE names/);
    expect(refusal(await read({ file: path.join(base, "missing-folder", "token") })).reason).toMatch(/no sign-in token of its own/);
  });

  it("refuses a file other accounts can read or change, or that belongs to another account", async () => {
    await writeFile(file, TOKEN, { mode: 0o600 });
    for (const mode of [0o640, 0o604, 0o620, 0o602, 0o644]) {
      await chmod(file, mode);
      const refused = refusal(await read());
      expect(refused.reason).toMatch(/can be read or changed by other accounts/);
      expect(refused.guidance).toMatch(/chmod 600/);
    }
    await chmod(file, 0o400);
    expect(await read()).toMatchObject({ ok: true });
    expect(refusal(await read({ uid: uid + 1 })).reason).toMatch(/belongs to another account/);
  });

  it("refuses a file with more than one hard link, without naming either path, and accepts it again once it has one name (#246)", async () => {
    await writeFile(file, TOKEN, { mode: 0o600 });
    const other = path.join(base, "another-name");
    await link(file, other);
    const refused = refusal(await read());
    expect(refused.reason).toMatch(/more than one name \(a hard link\)/);
    expect(refused.guidance).toMatch(/new file of its own.*claude setup-token/);
    expect(refusal(await read({ configured: false })).reason).toContain(DEFAULT_TOKEN_FILE_SHOWN);
    // Whichever name is configured, the other one is just as much a path to the token.
    expect(refusal(await read({ file: other })).reason).toMatch(/more than one name/);
    await rm(other);
    expect(await read()).toEqual({ ok: true, token: TOKEN, file });
  });

  it("refuses a link, never reading or changing what it points to", async () => {
    const target = path.join(base, "target");
    await writeFile(target, TOKEN, { mode: 0o600 });
    await symlink(target, file);
    expect(refusal(await read()).reason).toMatch(/is a link/);
    expect(await readFile(target, "utf8")).toBe(TOKEN);
  });

  it("refuses a folder or a FIFO without waiting on it", async () => {
    await mkdir(file, { mode: 0o700 });
    expect(refusal(await read()).reason).toMatch(/not a regular file/);
    await rm(file, { recursive: true });
    execFileSync("mkfifo", ["-m", "600", file]);
    expect(refusal(await read()).reason).toMatch(/not a regular file/);
  });

  it("refuses a file inside the CreatorBrio folder, the data folder, the agent's folders or its temporary folder, by its real path", async () => {
    const repo = path.join(base, "repo");
    const data = path.join(base, "elsewhere-data");
    const agents = path.join(base, "agents");
    const temp = path.join(base, "temp");
    for (const dir of [repo, data, agents, temp]) await mkdir(dir, { mode: 0o700 });
    const input = { uid, home: base, repoDir: repo, dataDir: data, workspaceRoot: agents, tempRoot: temp };
    for (const [dir, what] of [
      [repo, "the CreatorBrio folder"],
      [data, "the data folder"],
      [agents, "the Design Agent's folders"],
      [temp, "the Design Agent's temporary folder"],
    ]) {
      const inside = path.join(dir, "token");
      await writeFile(inside, TOKEN, { mode: 0o600 });
      const refused = refusal(await agentSignIn({ ...input, env: { [AGENT_TOKEN_FILE_ENV]: inside } }));
      expect(refused.reason).toContain(`inside ${what}`);
      // Through a link to the folder, too.
      const linked = path.join(base, `link-${path.basename(dir)}`);
      await symlink(dir, linked);
      expect(refusal(await agentSignIn({ ...input, env: { [AGENT_TOKEN_FILE_ENV]: path.join(linked, "token") } })).reason).toContain(`inside ${what}`);
    }
    await writeFile(file, TOKEN, { mode: 0o600 });
    expect(await agentSignIn({ ...input, env: { [AGENT_TOKEN_FILE_ENV]: file } })).toEqual({ ok: true, token: TOKEN, file });
    // The default, under the home folder.
    await mkdir(path.join(base, ".creatorbrio"), { mode: 0o700 });
    await writeFile(path.join(base, ".creatorbrio", "design-agent-token"), `${TOKEN}\n`, { mode: 0o600 });
    expect(await agentSignIn({ ...input, env: {} })).toMatchObject({ ok: true, token: TOKEN });
  });
});
