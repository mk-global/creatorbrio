"use client";

import { useEffect, useState } from "react";

export type DesignAgentStatus =
  | { profile: "legacy" | "invalid" }
  | { profile: "contained"; available: true; cliVersion: string; versionWarning: string | null; qualifiedCliVersion: string }
  | { profile: "contained"; available: false; reason: string; guidance: string };

export interface AppStatus {
  claude: { available: boolean };
  imageGeneration: { configured: boolean };
  designAgent?: DesignAgentStatus;
  /**
   * Topic research: whether a Brave Search key is set (#252), and which web
   * search research tries first (#256): Brave, Claude's own web search, or
   * none. Research from the person's links needs neither.
   */
  research?: { search: { configured: boolean; provider?: "brave" | "claude" | null } };
}

/** What `/api/status` says about this computer, or null until it answers (#175). */
export function useAppStatus(): AppStatus | null {
  const [status, setStatus] = useState<AppStatus | null>(null);
  useEffect(() => {
    let current = true;
    fetch("/api/status")
      .then((r) => (r.ok ? (r.json() as Promise<AppStatus>) : null))
      .then((s) => current && s && setStatus(s))
      .catch(() => {
        // Unknown is shown as nothing, never as "not found".
      });
    return () => {
      current = false;
    };
  }, []);
  return status;
}
