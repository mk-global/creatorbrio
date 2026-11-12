"use client";

/**
 * The Video Studio page (#150): pairing, then the production list, then the
 * workspace. The open production is kept in the address (`?production=`), so
 * a reload, or a server restart, reopens it where the person left off. The
 * page needs no Claude CLI or AI provider.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { LogOut, MonitorSmartphone } from "lucide-react";

import { StudioApiError } from "@/lib/video/studio/api";
import { PairingPanel } from "./PairingPanel";
import { ProductionPicker } from "./ProductionPicker";
import { StudioIntro } from "./StudioIntro";
import { StudioWorkspace } from "./StudioWorkspace";
import { useStudioApi } from "./workspace";

type Pairing = { status: "checking" } | { status: "unpaired" } | { status: "paired" } | { status: "unreachable"; message: string };


export function StudioApp() {
  const api = useStudioApi();
  const [pairing, setPairing] = useState<Pairing>({ status: "checking" });
  // The open production is the URL's `?production=`, read through the router:
  // a link from Home, Back and Forward, and the pushes below all update it.
  // Reading window.location at first render missed client-side navigation
  // from Home, which writes the URL only after the page renders (#175).
  const productionId = useSearchParams().get("production");

  const check = useCallback(async () => {
    try {
      // The status form answers "not paired" without a 401, so an unpaired
      // visit no longer logs an error in the browser console (#175).
      const status = await api.pairingStatus();
      setPairing({ status: status.paired ? "paired" : "unpaired" });
    } catch (error) {
      if (error instanceof StudioApiError && error.status === 401) setPairing({ status: "unpaired" });
      else setPairing({ status: "unreachable", message: error instanceof Error ? error.message : "The app did not answer." });
    }
  }, [api]);

  useEffect(() => {
    void check();
  }, [check]);

  const open = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("production", id);
    else url.searchParams.delete("production");
    window.history.pushState(null, "", url);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.signOut();
    } finally {
      setPairing({ status: "unpaired" });
    }
  }, [api]);

  const wide = useWideScreen();
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="type-title">Video Studio</h1>
        <span className="tag tag-early h-6 px-2.5 text-[13px]">Early</span>
      </div>
      {pairing.status === "paired" && (
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => void signOut()}>
          <LogOut className="size-3.5" aria-hidden="true" />
          Sign out
        </button>
      )}
    </div>
  );

  // An open production is a workspace that fills the window; it needs a wide
  // screen (#175, docs/architecture/app-shell.md).
  if (pairing.status === "paired" && productionId && wide) {
    return <StudioWorkspace key={productionId} productionId={productionId} onClose={() => open(null)} />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1240px] px-4 pt-6 pb-10 sm:px-6 md:px-10 md:pt-10 xl:px-12">
        {header}
        <p className="mt-2 max-w-[62ch] text-[17px] text-ink/85">
          Edit a short Instagram Reel by hand: bring in your clips and music, cut them on a timeline, add titles and captions, and export an MP4.
        </p>
        {pairing.status === "checking" && <p className="mt-10 text-graphite">Checking this browser&apos;s Studio session…</p>}
        {pairing.status === "unreachable" && (
          <div className="mt-10 flex max-w-lg flex-col items-start gap-3">
            <p>{pairing.message}</p>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => void check()}>
              Try again
            </button>
          </div>
        )}
        {pairing.status === "unpaired" && (
          <div className="mt-10 space-y-10">
            <StudioIntro />
            <PairingPanel onPaired={() => setPairing({ status: "paired" })} />
          </div>
        )}
        {pairing.status === "paired" && productionId && !wide && (
          <div className="mt-10 flex max-w-lg flex-col items-start gap-3">
            <p className="flex items-start gap-2 text-graphite">
              <MonitorSmartphone className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              The timeline needs a larger screen. Open this production on a computer or a tablet held sideways.
            </p>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => open(null)}>
              All productions
            </button>
          </div>
        )}
        {pairing.status === "paired" && !productionId && (
          <div className="mt-6">
            <ProductionPicker onOpen={open} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Whether the window is at least 768 px wide, the Studio workspace's minimum. */
function useWideScreen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(min-width: 48rem)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(min-width: 48rem)").matches,
    () => true
  );
}
