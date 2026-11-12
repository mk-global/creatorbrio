"use client";

import { useEffect, useState } from "react";

export interface AppStatus {
  claude: { available: boolean };
  imageGeneration: { configured: boolean };
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
