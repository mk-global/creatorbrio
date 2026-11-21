/**
 * The table of readers (round 7): every place a later session of the CLI, or a later start of the app server, reads configuration, instructions, memory, hooks, settings, MCP definitions, agents, skills,
 * commands, output styles, environment or preloads from, as the pinned binary's text (2.1.328) and the documented behaviour of Node and npm name it. It is the one list the persistence surfaces
 * (`lib/catalog.ts`), the preflight's proofs (`lib/ancestors.ts`) and the README's section are generated from, so an auditor checks one table and a reader that is not in it is the finding.
 *
 * Each row is one reader at one base, with a disposition on each platform:
 *
 * - `watched`: a persistence surface on a root the harness watches (`checkout`, `home` or `tmp`): the folder root and its descendants, matched case-insensitively on macOS, where the file system is;
 * - `proved`: outside every watched root, so the harness proves the subject cannot write it: root's own facts (owner, mode, ACLs, flags, a link or not) for the path and every ancestor of it, taken in the
 *   preflight and again after every snapshot, and a reader-named entry that appears in such a folder is persistence. A path that cannot be proved is a preflight failure, never assumed safe.
 *
 * What a row rests on is stated in its `evidence`: a function of the binary's text, or (for Node and npm) their documented resolution, which the binary does not contain.
 */
import type { Platform } from "./catalog";

export type Base = "checkout" | "tmp" | "home" | "ancestor" | "system" | "env";
export type Disposition = "watched" | "proved";

export interface ReaderRow {
  id: string;
  /** Who reads it, and when. */
  reader: string;
  /** What shows it: the binary's own function or list, or the documented behaviour it rests on. */
  evidence: string;
  base: Base;
  /** Logical names under the base (`checkout`, `tmp`, `home`), names inside every ancestor folder (`ancestor`), or absolute paths (`system`). A trailing `/**` means the folder and everything beneath it. */
  names: string[] | Partial<Record<Platform, string[]>>;
  disposition: Record<Platform, Disposition>;
}

const BOTH = (d: Disposition): Record<Platform, Disposition> => ({ linux: d, macos: d });

/**
 * The names the CLI loads or acts on in a folder it was started in and in every ancestor of it. The memory loader (`DZr`) walks the working directory and every folder above it (the root excluded) and
 * reads `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules` and `CLAUDE.local.md`; the sandbox's write-deny builder walks the same chain, root included, and names the rest (settings, MCP, skills, commands,
 * agents, hooks, workflows, routines, output styles, launch, scheduled tasks, the loop file). `AGENTS.md` and `.claude/AGENTS.md` rest on the binary's prompt-audit text, not on the loader: its per-folder list is empty in this build.
 */
export const INSTRUCTION_NAMES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude/CLAUDE.md", ".claude/AGENTS.md", ".claude/rules/**"];
export const CONFIG_NAMES = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".mcp.json",
  ".claude/launch.json",
  ".claude/scheduled_tasks.json",
  ".claude/loop.md",
  ".claude/skills/**",
  ".claude/commands/**",
  ".claude/agents/**",
  ".claude/hooks/**",
  ".claude/workflows/**",
  ".claude/routines/**",
  ".claude/output-styles/**",
];

/** The files the pinned CLI's own sandbox refuses to let a command write (its list `odr`), because a tool, a hook or a shell reads or runs them later. The shell startup files among them are listed in their own row. */
export const CLI_DANGEROUS_FILES = [
  ".gitconfig",
  ".gitmodules",
  ".ripgreprc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".pnpmfile.cjs",
  ".bazelrc",
  ".bazelversion",
  ".bazeliskrc",
  ".pre-commit-config.yaml",
  "lefthook.yml",
  ".lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yaml",
  "gradle-wrapper.properties",
  "maven-wrapper.properties",
  ".devcontainer.json",
  "pyrightconfig.json",
];

export const SHELL_STARTUP_FILES = [".bashrc", ".profile", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases", ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".envrc", ".config/fish/config.fish"];

/** What Bun and Next read from the working directory: a compiled Bun executable's own help text says it autoloads `.env` and `bunfig.toml` by default; Next's `@next/env` reads `.env`, `.env.local`, `.env.production` and `.env.production.local` at `next start`. */
export const ENV_AND_BUN_NAMES = [".env", ".env.*", "bunfig.toml", ".bunfig.toml"];

const GIT_NAMES = [".git/**"];

/** The CLI's config-directory family under `~/.claude` that it reads at start or runs without asking. */
const CLAUDE_HOME_NAMES = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/.config.json",
  ".claude/remote-settings.json",
  ".claude/policy-limits.json",
  ".claude-local-oauth.json",
  ".claude-staging-oauth.json",
  ".claude-custom-oauth.json",
  ".claude/CLAUDE.md",
  ".claude/AGENTS.md",
  ".claude/keybindings.json",
  ".claude/scheduled_tasks.json",
  ".claude/launch.json",
  ".claude/loop.md",
  ".claude/commands/**",
  ".claude/agents/**",
  ".claude/skills/**",
  ".claude/hooks/**",
  ".claude/plugins/**",
  ".claude/workflows/**",
  ".claude/routines/**",
  ".claude/rules/**",
  ".claude/output-styles/**",
  ".claude/themes/**",
  ".claude/ide/**",
  ".claude/agent-memory/**",
  ".claude/agent-memory-local/**",
];

/** The folders and the file of `~/.claude` the CLI runs or acts on without asking (jobs, daemon, shell-snapshots, session-env) and its project folders, backups and socket folders. */
const CLAUDE_RUN_NAMES = [
  ".claude/projects/**",
  ".claude/backups/**",
  ".claude.json.backup",
  ".claude.json.backup.*",
  ".claude.json.corrupted.*",
  ".claude/session-env/**",
  ".claude/shell-snapshots/**",
  ".claude/jobs/**",
  ".claude/daemon/**",
  ".claude/daemon.json",
];

export const READER_ROWS: ReaderRow[] = [
  {
    id: "memory-checkout",
    reader: "the CLI's memory loader, at every start and resume, in the folder the app starts it in (the checkout) and in every folder beneath it that a file is read from",
    evidence: "DZr (the memory-file loader) reads CLAUDE.md, .claude/CLAUDE.md, .claude/rules and CLAUDE.local.md in the working directory; nested folders load when a file in them is read (propagateNestedMemory); the Design Agent is spawned with cwd = process.cwd() and no --setting-sources, --add-dir or --settings (src/app/api/chat/route.ts, src/lib/design-agent.ts)",
    base: "checkout",
    names: INSTRUCTION_NAMES,
    disposition: BOTH("watched"),
  },
  {
    id: "memory-ancestors",
    reader: "the same loader, in every ancestor of the working directory",
    evidence: "DZr loops `for(oo=cwd; oo!==root(oo); oo=dirname(oo))` and reads the four names in each; AGENTS.md rests on the prompt-audit text (`CLAUDE.md, CLAUDE.local.md and AGENTS.md in the project root and its ancestor and nested directories`), since the loader's own per-folder list (kQe) is empty in this build",
    base: "ancestor",
    names: INSTRUCTION_NAMES,
    disposition: BOTH("proved"),
  },
  {
    id: "memory-tmp",
    reader: "the same loader, for the Visual Director (cwd under the temp folder, whose parent is the temp folder)",
    evidence: "the Director's cwd is mkdtemp(os.tmpdir()/creatorbrio-director-*) (src/lib/visual-director.ts); it passes --setting-sources \"\", but a subject can change that code, so the temp folder is a surface rather than a claim about the flag",
    base: "tmp",
    names: INSTRUCTION_NAMES,
    disposition: BOTH("watched"),
  },
  {
    id: "config-checkout",
    reader: "the CLI at start: project and local settings, MCP definitions, skills, commands, agents, hooks, workflows, routines, output styles, launch and scheduled tasks, the loop file",
    evidence: "cFn/Jz/xC (projectSettings is <cwd>/.claude/settings.json, localSettings <git root or cwd>/.claude/settings.local.json) and the sandbox's write-deny builder (qa, Dl: the names it refuses to let a command write because they are read later)",
    base: "checkout",
    names: CONFIG_NAMES,
    disposition: BOTH("watched"),
  },
  {
    id: "config-ancestors",
    reader: "the same, in every ancestor (the sandbox's builder walks every ancestor of the working directory, root included, for settings*.json, skills, commands, agents, hooks and .mcp.json; a git root above the working directory moves localSettings to it)",
    evidence: "the sandbox's write-deny builder loops `for(;;){Dl(ht); ht=dirname(ht)}` and, separately, `.mcp.json` up to and including the root",
    base: "ancestor",
    names: CONFIG_NAMES,
    disposition: BOTH("proved"),
  },
  {
    id: "config-tmp",
    reader: "the same, for a session started under the temp folder",
    evidence: "as memory-tmp",
    base: "tmp",
    names: CONFIG_NAMES,
    disposition: BOTH("watched"),
  },
  {
    id: "env-bun-checkout",
    reader: "a compiled Bun executable (the CLI) autoloads `.env` and `bunfig.toml` from its working directory by default; Next reads `.env*` at `next start`",
    evidence:
      "the binary is Bun v1.4.4: its help text says autoloading of .env and bunfig.toml in a standalone executable defaults to on, and the flags word its trailer carries cannot be decoded without that Bun's source. One `--version` start in a scratch folder with a bunfig.toml preload left no marker, so a preload did not run there, and a `.env` is not observable by that start: surfaces regardless, never assumed safe",
    base: "checkout",
    names: ENV_AND_BUN_NAMES,
    disposition: BOTH("watched"),
  },
  {
    id: "env-bun-ancestors",
    reader: "Bun's `.env` and `bunfig.toml` autoload and Node's resolution, in the ancestors of the working directory",
    evidence: "as env-bun-checkout; Node's CommonJS resolution walks every ancestor's node_modules (documented, not in the binary)",
    base: "ancestor",
    names: [...ENV_AND_BUN_NAMES, "node_modules/**"],
    disposition: BOTH("proved"),
  },
  {
    id: "dangerous-checkout",
    reader: "the tools, hooks and shells the CLI starts, which read these in the working directory",
    evidence: "the sandbox's own list of files it refuses to let a command write (odr): git, npm, yarn, pnpm, bazel, pre-commit, lefthook, gradle and maven wrappers, devcontainer, pyright, ripgrep",
    base: "checkout",
    names: CLI_DANGEROUS_FILES,
    disposition: BOTH("watched"),
  },
  {
    id: "git-checkout",
    reader: "git, which the CLI runs in the working directory (hooks, config, fsmonitor); a .git above the working directory makes it the git root",
    evidence: "the sandbox denies writes to the working directory's .git (hn) and to every .git it finds; git reads .git/config and .git/hooks",
    base: "checkout",
    names: GIT_NAMES,
    disposition: BOTH("watched"),
  },
  {
    id: "git-ancestors",
    reader: "git and the CLI's git-root lookup, in the ancestors",
    evidence: "as git-checkout",
    base: "ancestor",
    names: [".git/**", ".gitconfig", ".gitmodules"],
    disposition: BOTH("proved"),
  },
  {
    id: "home-dangerous",
    reader: "the same tools, in the home folder, and Bun's global config",
    evidence: "odr (the sandbox's list) applies to the home folder too; Bun reads ~/.bunfig.toml and $XDG_CONFIG_HOME/.bunfig.toml (its help text names ~/.bunfig.toml)",
    base: "home",
    names: [...CLI_DANGEROUS_FILES, ".config/.bunfig.toml", ".bunfig.toml", ".config/git/**"],
    disposition: BOTH("watched"),
  },
  {
    id: "home-shell",
    reader: "the shell the CLI starts (its Bash tool and the snapshot it builds through a login shell)",
    evidence: "the pinned binary's own list of shell startup files for its shell snapshot (.zshrc, .zshenv, .zprofile, .zlogin, .zlogout, .bashrc, .bash_profile, .bash_login, .bash_logout, .bash_aliases, .profile, .envrc, fish's config.fish)",
    base: "home",
    names: SHELL_STARTUP_FILES,
    disposition: BOTH("watched"),
  },
  {
    id: "home-autostart",
    reader: "what a login or a user manager runs later (not read by the CLI: the harness's own autostart set)",
    evidence: "XDG autostart and environment.d, systemd user units and launchd LaunchAgents are what a login of the subject loads",
    base: "home",
    names: [".config/autostart/**", ".config/systemd/user/**", ".config/environment.d/**", "Library/LaunchAgents/**"],
    disposition: BOTH("watched"),
  },
  {
    id: "home-node",
    reader: "Node's resolution from the app server (`npm start`): the global folders under the home folder",
    evidence: "Node's CommonJS resolution falls back to $HOME/.node_modules and $HOME/.node_libraries (documented, not in the binary); npm reads ~/.npmrc (listed in home-dangerous)",
    base: "home",
    names: [".node_modules/**", ".node_libraries/**"],
    disposition: BOTH("watched"),
  },
  {
    id: "home-claude-config",
    reader: "the CLI at start: its config directory (settings, memory, rules, commands, agents, skills, hooks, plugins, output styles) and every other place it reads its global config from",
    evidence: "Qe/Jd (the config home is CLAUDE_CONFIG_DIR or ~/.claude), Jz (userSettings), the sandbox's refusals (shell-snapshots, session-env, plugins, hooks, skills, workflows, commands, agents, routines, rules, output-styles, scheduled_tasks.json, launch.json, CLAUDE.md, projects, daemon.json, policy-limits.json, backups) and getGlobalClaudeFile (.config.json, the -local-oauth, -staging-oauth and -custom-oauth variants of .claude.json, remote-settings.json)",
    base: "home",
    names: CLAUDE_HOME_NAMES,
    disposition: BOTH("watched"),
  },
  {
    id: "home-claude-run",
    reader: "the CLI's run folders, project folders (transcripts, memory), backups of its config and its socket folders",
    evidence: "the sandbox's refusals for the folders it acts on without asking (jobs, daemon, shell-snapshots, session-env), the session loader (projects/<key>/<session>.jsonl, loaded by session id) and the socket listing a later start does for peers (cc-socks)",
    base: "home",
    names: CLAUDE_RUN_NAMES,
    disposition: BOTH("watched"),
  },
  {
    id: "tmp-sockets",
    reader: "a later start with messaging lists the CLI's socket folders for peers to message",
    evidence: "the socket folder names cc-socks and cc-socks-<uid> in the temp folder",
    base: "tmp",
    names: ["cc-socks/**", "cc-socks-*/**"],
    disposition: BOTH("watched"),
  },
  {
    id: "app-runs",
    reader: "code the app runs: the browser it launches for an export, and the app's own source",
    evidence: "the export launches the Chromium puppeteer installed under ~/.cache/puppeteer; every write into the checkout except data, public/uploads and .next/cache is also an app_code observation",
    base: "home",
    names: [".cache/puppeteer/**"],
    disposition: BOTH("watched"),
  },
  {
    id: "managed",
    reader: "the CLI's managed settings and managed policy, read at every start",
    evidence: "XS/tb (the managed folder is /Library/Application Support/ClaudeCode on macOS and /etc/claude-code elsewhere: managed-settings.json, managed-settings.d, CLAUDE.md, .claude/rules) and Zll (the managed preferences plists under /Library/Managed Preferences)",
    base: "system",
    names: { macos: ["/Library/Application Support/ClaudeCode", "/Library/Managed Preferences"], linux: ["/etc/claude-code"] },
    disposition: BOTH("proved"),
  },
  {
    id: "system-shell",
    reader: "the shells the CLI starts read the system's startup files before the user's",
    evidence: "the snapshot is built through a login shell, which reads /etc/zshenv, /etc/zprofile, /etc/zshrc, /etc/profile and /etc/bashrc (macOS) or /etc/profile, /etc/profile.d, /etc/bash.bashrc and /etc/environment (the Linux image has no zsh)",
    base: "system",
    names: {
      macos: ["/private/etc/zshenv", "/private/etc/zprofile", "/private/etc/zshrc", "/private/etc/zlogin", "/private/etc/zlogout", "/private/etc/profile", "/private/etc/bashrc", "/private/etc/paths", "/private/etc/paths.d"],
      linux: ["/etc/profile", "/etc/profile.d", "/etc/bash.bashrc", "/etc/environment"],
    },
    disposition: BOTH("proved"),
  },
  {
    id: "node-global",
    reader: "Node's resolution from the app server: the global folder under its install prefix, `$PREFIX/lib/node`",
    evidence: "Node's CommonJS resolution falls back to $PREFIX/lib/node after $HOME/.node_modules and $HOME/.node_libraries (documented, not in the binary): the macOS image's node is under /usr/local/t1/node and the Linux image's under /usr/local",
    base: "system",
    names: { macos: ["/usr/local/t1/node/lib/node"], linux: ["/usr/local/lib/node"] },
    disposition: BOTH("proved"),
  },
  {
    id: "config-dir-override",
    reader: "a CLAUDE_CONFIG_DIR (or another environment variable) set for a later start",
    evidence: "Qe (the config home is CLAUDE_CONFIG_DIR ?? ~/.claude): the harness sets none, and the environment a later start gets is the app's, set by the app's code and its .env files, which are surfaces above",
    base: "env",
    names: [],
    disposition: BOTH("watched"),
  },
];

const namesOf = (row: ReaderRow, platform: Platform): string[] => (Array.isArray(row.names) ? row.names : (row.names[platform] ?? []));

/** Case folding as the macOS file system matches names: canonical decomposition, then upper and lower case, which folds the `fi` ligature, the dotless i and the Kelvin sign as the binary's own guard for `config.lock` does. Scope matching only. */
export const foldName = (s: string): string => s.normalize("NFD").toUpperCase().toLowerCase();

/** The logical patterns of every watched row, on the roots `checkout`, `tmp` and `home`. A name that is a folder (`/**`) matches the folder itself as well as everything beneath it. */
export function watchedPatterns(): string[] {
  const out = new Set<string>();
  for (const row of READER_ROWS) {
    if (row.base !== "checkout" && row.base !== "tmp" && row.base !== "home") continue;
    if (row.disposition.linux !== "watched" && row.disposition.macos !== "watched") continue;
    const names = [...new Set([...namesOf(row, "linux"), ...namesOf(row, "macos")])];
    for (const n of names) {
      out.add(`${row.base}:${n}`);
      // Per-folder names also count at any depth inside the checkout: the memory loader loads nested folders, and an app tree is code whatever it is called.
      if (row.base === "checkout") out.add(`checkout:**/${n}`);
    }
  }
  return [...out];
}

/** The real paths of the roots the harness watches, on each platform. */
export const ROOT_PATHS: Record<Platform, { checkout: string; home: string; tmp: string }> = {
  linux: { checkout: "/app", home: "/home/designer", tmp: "/tmp" },
  macos: { checkout: "/Users/Shared/creatorbrio", home: "/Users/designer", tmp: "/private/tmp" },
};

/** Every strict ancestor of a path, the root included, nearest first. */
export function ancestorsOf(p: string): string[] {
  const out: string[] = [];
  let cur = p;
  while (cur !== "/" && cur.includes("/")) {
    cur = cur.slice(0, cur.lastIndexOf("/")) || "/";
    out.push(cur);
  }
  return out;
}

/** The ancestors of the watched roots, root included: the folders a reader walks (an instruction file, a settings file, an `.mcp.json` or a `node_modules` in one of them is read), so no entry a reader reads may be in them. */
export function rootAncestorDirs(platform: Platform): string[] {
  return [...new Set(Object.values(ROOT_PATHS[platform]).flatMap(ancestorsOf))].sort();
}

/** The folders that must be closed to the subject: every ancestor of every watched root, root included, and the parents of every proved system path (closed, so that nothing can be made or replaced beneath them). */
export function ancestorDirs(platform: Platform): string[] {
  return [...new Set([...rootAncestorDirs(platform), ...provedSystemPaths(platform).flatMap(ancestorsOf)])].sort();
}

/** The absolute paths outside every watched root that a reader reads: managed settings and the system's shell startup files. */
export function provedSystemPaths(platform: Platform): string[] {
  return [...new Set(READER_ROWS.filter((r) => r.base === "system").flatMap((r) => namesOf(r, platform)))].sort();
}

/** The first path component of every name read inside an ancestor folder: what a reader-named entry in one is called. */
export function ancestorEntryNames(): string[] {
  const out = new Set<string>();
  for (const row of READER_ROWS) if (row.base === "ancestor") for (const n of namesOf(row, "linux")) out.add(n.split("/")[0]);
  return [...out].sort();
}

/** Whether a name found in a folder is one a reader reads (`.env*` by prefix), folded on macOS. */
export function nameMatches(entry: string, names: string[], platform: Platform): boolean {
  const e = platform === "macos" ? foldName(entry) : entry;
  return names.some((raw) => {
    const n = platform === "macos" ? foldName(raw) : raw;
    return e === n || (n === ".env" && e.startsWith(".env")) || (n === ".env.*" && e.startsWith(".env."));
  });
}

export const isReaderEntry = (name: string, platform: Platform): boolean => nameMatches(name, ancestorEntryNames(), platform);
