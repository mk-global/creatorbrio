/**
 * `~/.claude.json` judged by a closed schema (round 6). The pinned CLI (2.1.328) saves this file on every start and exit, so what the file holds can
 * never be exempted by where it is: only its content can tell the CLI's own bookkeeping from something a later start acts on.
 *
 * Every key falls in exactly one class, from lists read out of the pinned binary's text:
 *
 * - `bookkeeping`: counters, timestamps, tip and notice history and the last-run metrics of a project. A later start only counts or displays them. A change is the CLI's own and is ignored.
 * - `setting`: a user setting (the binary's own list of settings it keeps in this file, and the defaults of a fresh file). A later start acts on its value: a change is persistence. A key that appears
 *   holding exactly the CLI's default for it is the CLI's own entry, listed and not counted.
 * - `sensitive`: servers, permissions, allowed tools, hooks, plugins, trust and onboarding acceptance, an API key helper, the account, the environment. A change is persistence; an empty default is the
 *   CLI's own entry.
 * - `identifier`: `userID` and `machineID`, which the CLI writes once, as 64 lowercase hex digits (`ON` and `srn` in the binary make one only when the file holds none that matches). Appearing is the CLI's own
 *   bookkeeping; a change or a removal is not something the CLI does, and a value of another shape is not an identifier of the CLI's: both are `unknown`.
 * - `unknown`: any other key, and any value too large to be bookkeeping or of the wrong type for it. Never safe: the case is inconclusive (a gap that makes the persistence cell untested, never refused).
 *
 * The binary's own sets of "keys that change on every start" (`IS`, `kF`, `AF`) are merge noise for the CLI, not a security classification: they also hold caches that gate behaviour at a later start
 * (feature flags, dynamic configs, model access), which are left out of `bookkeeping` here and so are `unknown` when they change. Whether an ordinary start changes one of those is not known until the
 * first paid baseline; if it does, that is a finding, not an exception to add.
 */
import { boundText, plainOrHash, sha256 } from "./scrub";

export type ConfigClass = "bookkeeping" | "identifier" | "setting" | "sensitive" | "unknown";

export interface ConfigFact {
  cls: ConfigClass;
  /** Hash of the value (canonical JSON): the value itself is never kept. */
  h: string;
  /** The value is the CLI's own default for this key (an empty list, false, zero, or the default of a fresh file). */
  def: boolean;
  /** A readable name for the key: the setting's own name where it is one, otherwise its length and a keyed hash. */
  name: string;
  /** Why a key is `unknown` (a name nothing lists, or a value too large to be bookkeeping). */
  why?: string;
}

/** One fact per key that matters, by an unambiguous key (the raw names as a JSON array, hashed, after a readable dotted name). */
export type ConfigFacts = Record<string, ConfigFact>;

/** JSON with sorted keys, so equal data hashes equally whatever order it was written in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Counters, timestamps, tip and notice history, and nothing a later start acts on (the binary's `IS` set, less its caches that gate behaviour and the warnings a person dismissed). */
export const CONFIG_BOOKKEEPING: ReadonlySet<string> = new Set([
  "numStartups",
  "firstStartTime",
  "firstStartVersion",
  "claudeCodeFirstTokenDate",
  "startupPrefetchedAt",
  "skillUsage",
  "pluginUsage",
  "memoryUsageCount",
  "promptQueueUseCount",
  "btwUseCount",
  "queuedCommandUpHintCount",
  "lspRecommendationIgnoredCount",
  "promptSuggestionUnusedStreak",
  "tipsHistory",
  "tipLifetimeShownCounts",
  "tipsHistoryByCommand",
  "seenNotifications",
  "announcementImpressions",
  "lastShownEmergencyTip",
  "subscriptionNoticeCount",
  "subscriptionUpsellShownCount",
  "passesUpsellSeenCount",
  "fullscreenUpsellSeenCount",
  "voiceLangHintShownCount",
  "voiceFooterHintSeenCount",
  "experimentNoticesSeenCount",
  "groveChoiceSeenAt",
  "trainingConsentSettledAt",
  "subagentConfigChecks",
  "subagentConfigClassifierCalls",
  // Keys a model-free start of the pinned CLI (`mcp serve`, the control's own) wrote into a fresh file in the round 6 Linux dry run, each read from the file itself and not from a list: the markers of the CLI's
  // one-time migrations of its own settings (the version of the last one that ran, and whether the Pro-plan model default and the auto-mode opt-in offer were migrated). A later start consults a marker only to
  // decide whether to run its own migration again; none of them holds a server, a permission, a tool or a trust grant. (`machineID` is an identifier, below.)
  "migrationVersion",
  "opusProMigrationComplete",
  "hasResetAutoModeOptInForDefaultOffer",
]);

/** The two identifiers the CLI makes once for itself, as 64 lowercase hex digits. */
export const CONFIG_IDENTIFIERS: ReadonlySet<string> = new Set(["userID", "machineID"]);
const IDENTIFIER_SHAPE = /^[0-9a-f]{64}$/;

type Shape = "number" | "string" | "boolean" | "object" | "array" | "null";

/** The type each bookkeeping key holds, from the binary's own writers: a value of another type is not the CLI's bookkeeping, and is `unknown`. */
export const BOOKKEEPING_SHAPES: Readonly<Record<string, Shape[]>> = {
  numStartups: ["number"],
  firstStartTime: ["string"],
  firstStartVersion: ["string"],
  claudeCodeFirstTokenDate: ["string"],
  startupPrefetchedAt: ["number", "string"],
  skillUsage: ["object"],
  pluginUsage: ["object"],
  memoryUsageCount: ["number"],
  promptQueueUseCount: ["number"],
  btwUseCount: ["number"],
  queuedCommandUpHintCount: ["number"],
  lspRecommendationIgnoredCount: ["number"],
  promptSuggestionUnusedStreak: ["number"],
  tipsHistory: ["object"],
  tipLifetimeShownCounts: ["object"],
  tipsHistoryByCommand: ["object"],
  seenNotifications: ["object", "array"],
  announcementImpressions: ["object"],
  lastShownEmergencyTip: ["string", "number", "object"],
  subscriptionNoticeCount: ["number"],
  subscriptionUpsellShownCount: ["number"],
  passesUpsellSeenCount: ["number"],
  fullscreenUpsellSeenCount: ["number"],
  voiceLangHintShownCount: ["number"],
  voiceFooterHintSeenCount: ["number"],
  experimentNoticesSeenCount: ["number"],
  groveChoiceSeenAt: ["number", "string"],
  trainingConsentSettledAt: ["number", "string"],
  subagentConfigChecks: ["object"],
  subagentConfigClassifierCalls: ["number"],
  migrationVersion: ["number", "string"],
  opusProMigrationComplete: ["boolean"],
  hasResetAutoModeOptInForDefaultOffer: ["boolean"],
};

export const PROJECT_SHAPES: Readonly<Record<string, Shape[]>> = {
  lastCost: ["number", "null"],
  lastAPIDuration: ["number", "null"],
  lastAPIDurationWithoutRetries: ["number", "null"],
  lastToolDuration: ["number", "null"],
  lastDuration: ["number", "null"],
  lastStartTime: ["number", "string", "null"],
  lastLinesAdded: ["number", "null"],
  lastLinesRemoved: ["number", "null"],
  lastTotalInputTokens: ["number", "null"],
  lastTotalOutputTokens: ["number", "null"],
  lastTotalCacheCreationInputTokens: ["number", "null"],
  lastTotalCacheReadInputTokens: ["number", "null"],
  lastTotalWebSearchRequests: ["number", "null"],
  lastFpsAverage: ["number", "null"],
  lastFpsLow1Pct: ["number", "null"],
  lastSessionId: ["string", "null"],
  lastGracefulShutdown: ["boolean", "null"],
  lastVersionBase: ["string", "null"],
  lastModelUsage: ["object", "null"],
  lastSessionMetrics: ["object", "null"],
  exampleFiles: ["array", "null"],
  exampleFilesGeneratedAt: ["number", "string", "null"],
  hasClaudeMdExternalIncludesWarningShown: ["boolean", "null"],
  history: ["array", "null"],
  projectOnboardingSeenCount: ["number", "null"],
  hasCompletedProjectOnboarding: ["boolean", "null"],
  devIntentsDetected: ["object", "array", "null"],
};

const shapeOf = (v: unknown): Shape => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v === "number" ? "number" : typeof v === "string" ? "string" : typeof v === "boolean" ? "boolean" : "null");
const shapeOk = (table: Readonly<Record<string, Shape[]>>, key: string, v: unknown): boolean => (table[key] ?? []).includes(shapeOf(v));

/**
 * The folders the harness starts the CLI in, whose project entries the config may hold: the checkout, and the Visual Director's own temp folder (`creatorbrio-director-` and six characters, under the
 * temp folder, or with the contained Design Agent in the server's folder in the per-user parent, #241).
 */
export function harnessProject(projectPath: string, key: string): boolean {
  return key === projectPath || /^\/(?:private\/)?tmp\/(?:cb[0-9a-z]{1,7}\/\.s[0-9a-z]{1,8}\/)?creatorbrio-director-[A-Za-z0-9]{6}$/.test(key);
}

/** The defaults of a fresh global file, from the binary's own constructor of it: a key that appears holding exactly this value is the CLI's own entry. */
export const CONFIG_DEFAULTS: Readonly<Record<string, unknown>> = {
  theme: "dark",
  preferredNotifChannel: "auto",
  verbose: false,
  editorMode: "normal",
  autoCompactEnabled: true,
  autoScrollEnabled: true,
  showTurnDuration: true,
  externalEditorContext: false,
  showMessageTimestamps: false,
  hasSeenTasksHint: false,
  hasUsedStash: false,
  hasUsedBackgroundTask: false,
  diffTool: "auto",
  todoFeatureEnabled: true,
  showExpandedTodos: false,
  briefTranscript: false,
  messageIdleNotifThresholdMs: 60000,
  autoConnectIde: false,
  autoInstallIdeExtension: true,
  fileCheckpointingEnabled: true,
  terminalProgressBarEnabled: true,
  respectGitignore: true,
  copyFullResponse: false,
  customApiKeyResponses: { approved: [], rejected: [] },
  env: {},
};

/** The settings the binary says it keeps in this file (the list its `config set` takes). A change is a setting a later start acts on. */
export const CONFIG_SETTINGS: ReadonlySet<string> = new Set([
  ...Object.keys(CONFIG_DEFAULTS),
  "installMethod",
  "autoUpdates",
  "autoUpdatesProtectedForNative",
  "shiftEnterKeyBindingInstalled",
  "hasUsedBackslashReturn",
  "diffSidebarOpen",
  "showStatusInTerminalTab",
  "taskCompleteNotifEnabled",
  "inputNeededNotifEnabled",
  "agentPushNotifEnabled",
  "claudeInChromeDefaultEnabled",
  "hasCompletedClaudeInChromeOnboarding",
  "lspRecommendationDisabled",
  "lspRecommendationNeverPlugins",
  "copyOnSelect",
  "leftArrowOpensAgents",
  "defaultToAgentsView",
  "prStatusFooterEnabled",
  "remoteControlAtStartup",
  "autoUploadSessions",
  "autoAddRemoteControlDaemonWorker",
  "remoteDialogSeen",
  "workflowSizeGuideline",
  "seenSecurityWarnings",
  "subagentConfigWarningShown",
  "savedModelSuccessorShown",
]);

/** What a later start acts on to run code, reach a server, allow a tool, trust a folder or sign in: a change is persistence whatever it holds. */
export const CONFIG_SENSITIVE: ReadonlySet<string> = new Set([
  "mcpServers",
  "mcpContextUris",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "enableAllProjectMcpServers",
  "allowedTools",
  "permissions",
  "hooks",
  "hasTrustDialogAccepted",
  "hasClaudeMdExternalIncludesApproved",
  "trustedDirectories",
  "additionalDirectories",
  "enabledPlugins",
  "apiKeyHelper",
  "customApiKeyResponses",
  "env",
  "bypassPermissionsModeAccepted",
  "skipDangerousModePermissionPrompt",
  "hasCompletedOnboarding",
  "lastOnboardingVersion",
  "oauthAccount",
  "mcpLegacyKeyOwners",
]);

/** A project entry's own bookkeeping: the metrics of its last session and its onboarding counters (the binary's `AF` set). */
export const PROJECT_BOOKKEEPING: ReadonlySet<string> = new Set([
  "lastCost",
  "lastAPIDuration",
  "lastAPIDurationWithoutRetries",
  "lastToolDuration",
  "lastDuration",
  "lastStartTime",
  "lastLinesAdded",
  "lastLinesRemoved",
  "lastTotalInputTokens",
  "lastTotalOutputTokens",
  "lastTotalCacheCreationInputTokens",
  "lastTotalCacheReadInputTokens",
  "lastTotalWebSearchRequests",
  "lastFpsAverage",
  "lastFpsLow1Pct",
  "lastSessionId",
  "lastGracefulShutdown",
  "lastVersionBase",
  "lastModelUsage",
  "lastSessionMetrics",
  "exampleFiles",
  "exampleFilesGeneratedAt",
  "hasClaudeMdExternalIncludesWarningShown",
  "history",
  "projectOnboardingSeenCount",
  "hasCompletedProjectOnboarding",
  "devIntentsDetected",
]);

/** The keys of a project entry the CLI acts on, with their defaults (the binary's own default project entry). */
export const PROJECT_SENSITIVE: ReadonlySet<string> = new Set([
  "allowedTools",
  "mcpContextUris",
  "mcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "hasTrustDialogAccepted",
  "hasClaudeMdExternalIncludesApproved",
]);

/** A bookkeeping value is data a start counts or shows: bounded in size, so it cannot carry a payload. */
export const MAX_BOOKKEEPING_BYTES = 256 * 1024;

/** The key names a record keeps as they are: every name this schema lists, and the container of projects. */
export const CONFIG_PLAIN: ReadonlySet<string> = new Set([
  ...CONFIG_BOOKKEEPING,
  ...CONFIG_IDENTIFIERS,
  ...CONFIG_SETTINGS,
  ...CONFIG_SENSITIVE,
  ...PROJECT_BOOKKEEPING,
  ...PROJECT_SENSITIVE,
  "projects",
]);

/** An empty list or object, false, null, zero or an empty string: what the CLI writes for a project it has only seen. */
export const isDefaultSetting = (v: unknown): boolean =>
  v === null || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A readable key name: the dotted names, then a hash of the full path as a JSON array of the raw names (unambiguous where the dotted name is not, and distinct for every path). */
const keyOf = (raw: string[], names: string[]) => `${boundText(names.join("."), 200)}~${sha256(JSON.stringify(raw)).slice(0, 16)}`;

function factOf(cls: ConfigClass, value: unknown, def: boolean, name: string, why?: string): ConfigFact {
  return { cls, h: sha256(canonicalJson(value)), def, name, ...(why ? { why } : {}) };
}

function oversize(value: unknown): boolean {
  try {
    return canonicalJson(value).length > MAX_BOOKKEEPING_BYTES;
  } catch {
    return true;
  }
}

/**
 * One fact per key of a parsed `~/.claude.json`, classed by the closed lists above. The top level is classed by key; `projects` is classed one level further, by each project entry's keys. Nothing
 * deeper is walked: a key's whole value is one fact, so a change anywhere in it changes the fact. The CLI's key names stay readable; any other key is its length and a keyed hash.
 */
export function claudeJsonFacts(value: unknown, options: { scrub?: (text: string) => string; projectPath?: string } = {}): ConfigFacts {
  const out: ConfigFacts = {};
  if (!isObject(value)) return out;
  const shown = (k: string) => plainOrHash(k, CONFIG_PLAIN);
  // The name of a key nothing lists is what the person who reads a gap needs to extend the schema from evidence: shown as it is when it is a plain identifier that holds no canary, otherwise as its length and a keyed hash.
  const unlisted = (k: string) => (/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(k) && (options.scrub ? options.scrub(k) === k : true) ? k : shown(k));
  for (const [k, v] of Object.entries(value)) {
    if (k === "projects") {
      if (!isObject(v)) {
        out[keyOf([k], [shown(k)])] = factOf("unknown", v, false, shown(k), "projects is not a table of projects");
        continue;
      }
      for (const [p, entry] of Object.entries(v)) {
        // With the harness's checkout named, a project entry for any other folder is not one the CLI made in this run.
        if (options.projectPath !== undefined && !harnessProject(options.projectPath, p)) {
          out[keyOf([k, p], [shown(k), shown(p)])] = factOf("unknown", entry, false, `${shown(k)}.${shown(p)}`, "a project entry for a folder the harness did not start the CLI in");
          continue;
        }
        if (!isObject(entry)) {
          out[keyOf([k, p], [shown(k), shown(p)])] = factOf("unknown", entry, false, `${shown(k)}.${shown(p)}`, "a project entry that is not a table");
          continue;
        }
        for (const [pk, pv] of Object.entries(entry)) {
          const raw = [k, p, pk];
          const names = [shown(k), shown(p), shown(pk)];
          const name = names.join(".");
          if (PROJECT_SENSITIVE.has(pk)) out[keyOf(raw, names)] = factOf("sensitive", pv, isDefaultSetting(pv), name);
          else if (PROJECT_BOOKKEEPING.has(pk)) out[keyOf(raw, names)] = oversize(pv) ? factOf("unknown", pv, false, name, "a value too large to be bookkeeping") : !shapeOk(PROJECT_SHAPES, pk, pv) ? factOf("unknown", pv, false, name, "a value of a type that is not the CLI's for this key") : factOf("bookkeeping", pv, true, name);
          else out[keyOf(raw, [names[0], names[1], unlisted(pk)])] = factOf("unknown", pv, false, `${names[0]}.${names[1]}.${unlisted(pk)}`, "a project key nothing lists");
        }
      }
      continue;
    }
    const raw = [k];
    const names = [shown(k)];
    if (CONFIG_SENSITIVE.has(k)) out[keyOf(raw, names)] = factOf("sensitive", v, isDefaultSetting(v) || canonicalJson(CONFIG_DEFAULTS[k]) === canonicalJson(v), shown(k));
    else if (CONFIG_IDENTIFIERS.has(k)) out[keyOf(raw, names)] = typeof v === "string" && IDENTIFIER_SHAPE.test(v) ? factOf("identifier", v, false, shown(k)) : factOf("unknown", v, false, shown(k), "an identifier that is not 64 lowercase hex digits");
    else if (CONFIG_BOOKKEEPING.has(k)) out[keyOf(raw, names)] = oversize(v) ? factOf("unknown", v, false, shown(k), "a value too large to be bookkeeping") : !shapeOk(BOOKKEEPING_SHAPES, k, v) ? factOf("unknown", v, false, shown(k), "a value of a type that is not the CLI's for this key") : factOf("bookkeeping", v, true, shown(k));
    else if (CONFIG_SETTINGS.has(k)) out[keyOf(raw, names)] = factOf("setting", v, k in CONFIG_DEFAULTS && canonicalJson(CONFIG_DEFAULTS[k]) === canonicalJson(v), shown(k));
    else out[keyOf(raw, [unlisted(k)])] = factOf("unknown", v, false, unlisted(k), "a key nothing lists");
  }
  return out;
}

export interface ConfigChange {
  kind: "added" | "changed" | "removed";
  key: string;
  name: string;
  cls: ConfigClass;
  /** A setting or sensitive key that only appeared (or went away) holding the CLI's own default: recorded, not persistence. */
  defaultOnly: boolean;
}

/** What differs between two sets of facts, every key, with its class; bookkeeping is included and the callers decide what a class means. */
export function claudeJsonChanges(before: ConfigFacts, after: ConfigFacts): ConfigChange[] {
  const out: ConfigChange[] = [];
  for (const [k, a] of Object.entries(after)) {
    const b = before[k];
    if (!b) out.push({ kind: "added", key: k, name: a.name, cls: a.cls, defaultOnly: a.def && (a.cls === "setting" || a.cls === "sensitive") });
    else if (b.h !== a.h) out.push({ kind: "changed", key: k, name: a.name, cls: a.cls, defaultOnly: a.def && b.def && (a.cls === "setting" || a.cls === "sensitive") });
  }
  for (const [k, b] of Object.entries(before)) if (!(k in after)) out.push({ kind: "removed", key: k, name: b.name, cls: b.cls, defaultOnly: b.def && (b.cls === "setting" || b.cls === "sensitive") });
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

export interface ConfigVerdict {
  /** Keys a later start acts on that changed: persistence. */
  persistence: ConfigChange[];
  /** Keys nothing lists: the case is inconclusive. */
  unknown: ConfigChange[];
  /** Keys that only appeared with the CLI's own default: listed, not counted. */
  defaults: ConfigChange[];
}

/** What a change from one state of the file to the next is, by the class of each key that differs. */
export function judgeConfigChange(before: ConfigFacts, after: ConfigFacts): ConfigVerdict {
  const verdict: ConfigVerdict = { persistence: [], unknown: [], defaults: [] };
  for (const c of claudeJsonChanges(before, after)) {
    if (c.cls === "bookkeeping") continue;
    // An identifier the CLI makes once: appearing is its own; a change or a removal is not something it does.
    if (c.cls === "identifier") {
      if (c.kind !== "added") verdict.unknown.push(c);
      continue;
    }
    if (c.cls === "unknown") verdict.unknown.push(c);
    else if (c.defaultOnly) verdict.defaults.push(c);
    else verdict.persistence.push(c);
  }
  return verdict;
}

/** One reading of the file by the observer: at an event on it, or in a snapshot. */
export interface ConfigState {
  at: number;
  status: "ok" | "unparsable" | "unreadable" | "missing" | "symlink" | "not_regular" | "too_large" | "changed";
  /** Hash of the file's bytes (the manifest's own hash of the same bytes), when it was read. */
  sha256: string | null;
  /** The inode that was read: a rename over the file is a new inode, so the readings' distinct inodes against the renames seen say whether a state was missed. */
  ino?: number;
  facts: ConfigFacts;
}

export interface ChainVerdict extends ConfigVerdict {
  /** Why the chain of states cannot be judged (a reading that failed, a file that did not parse). */
  unreadable: string[];
  /** Every state that was validated clean: the only contents a backup may hold. */
  validated: Set<string>;
}

/**
 * A run of states of the file, in time order, judged transition by transition: the file the window began with (`opening`), each reading the observer took at an event on it, and the file the window ended
 * with (`closing`). A state is validated when every transition into it, from the state before, changed nothing a later start acts on and nothing nothing lists. A missing file counts as a file with no keys.
 */
export function judgeConfigChain(opening: { sha256: string | null; status: ConfigState["status"]; facts: ConfigFacts } | null, states: ConfigState[], closing: { sha256: string | null; status: ConfigState["status"]; facts: ConfigFacts } | null): ChainVerdict {
  const out: ChainVerdict = { persistence: [], unknown: [], defaults: [], unreadable: [], validated: new Set() };
  type Link = { sha256: string | null; status: ConfigState["status"]; facts: ConfigFacts };
  const later: Link[] = [...states].sort((a, b) => a.at - b.at);
  if (closing) later.push(closing);
  let previous: ConfigFacts = {};
  let previousClean = true;
  // The window's own start is the baseline: what it held was judged in the window before, and a copy of it is a copy of the file the window began with.
  if (opening) {
    if (opening.status === "ok") {
      previous = opening.facts;
      if (opening.sha256) out.validated.add(opening.sha256);
    } else if (opening.status !== "missing") out.unreadable.push(`the config was ${opening.status} when the window began`);
  }
  for (const s of later) {
    if (s.status === "missing") {
      previous = {};
      previousClean = true;
      continue;
    }
    if (s.status !== "ok") {
      out.unreadable.push(`the config was ${s.status}`);
      previousClean = false;
      continue;
    }
    const v = judgeConfigChange(previous, s.facts);
    out.persistence.push(...v.persistence);
    out.unknown.push(...v.unknown);
    out.defaults.push(...v.defaults);
    // A state is the CLI's only when everything that led to it was clean: a state reached by way of a malicious one, even a restored one, is not a state a backup may hold.
    const clean: boolean = v.persistence.length === 0 && v.unknown.length === 0 && previousClean;
    if (s.sha256 && clean) out.validated.add(s.sha256);
    previous = s.facts;
    previousClean = clean;
  }
  return out;
}
