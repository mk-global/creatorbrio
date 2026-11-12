"use client";

import { useEffect, useState } from "react";
import { useStudioApi } from "@/components/studio/workspace";
import { sortProductions } from "@/lib/video/studio/production-ids";
import type { ProductionSummary } from "@/lib/video/studio/types";

export type StudioStatus =
  | { state: "checking" }
  | { state: "unpaired" }
  | { state: "paired"; productions: ProductionSummary[] | null }
  | { state: "unreachable" };

/**
 * Whether this browser is paired with the Video Studio and, only then, its
 * productions (#175). The status form of the session route answers "not
 * paired" without a 401, and nothing else is asked until it says paired, so
 * an unpaired visit to Home or Settings logs no error.
 */
export function useStudioStatus(withProductions: boolean): StudioStatus {
  const api = useStudioApi();
  const [status, setStatus] = useState<StudioStatus>({ state: "checking" });
  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const pairing = await api.pairingStatus();
        if (!current) return;
        if (!pairing.paired) return setStatus({ state: "unpaired" });
        setStatus({ state: "paired", productions: null });
        if (!withProductions) return;
        const productions = sortProductions(await api.listProductions());
        if (current) setStatus({ state: "paired", productions });
      } catch {
        if (current) setStatus((s) => (s.state === "paired" ? { state: "paired", productions: [] } : { state: "unreachable" }));
      }
    })();
    return () => {
      current = false;
    };
  }, [api, withProductions]);
  return status;
}
