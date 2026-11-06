"use client";

/**
 * The Video Studio page (#150): pairing, then the production list, then the
 * workspace. The open production is kept in the address (`?production=`), so
 * a reload, or a server restart, reopens it where the person left off. The
 * page needs no Claude CLI or AI provider.
 */
import { useCallback, useEffect, useState } from "react";
import { LogOut } from "lucide-react";

import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/button";
import { StudioApiError } from "@/lib/video/studio/api";
import { PairingPanel } from "./PairingPanel";
import { ProductionPicker } from "./ProductionPicker";
import { StudioWorkspace } from "./StudioWorkspace";
import { useStudioApi } from "./workspace";

type Pairing = { status: "checking" } | { status: "unpaired" } | { status: "paired" } | { status: "unreachable"; message: string };

function readProductionParam(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("production");
}

export function StudioApp() {
  const api = useStudioApi();
  const [pairing, setPairing] = useState<Pairing>({ status: "checking" });
  const [productionId, setProductionId] = useState<string | null>(readProductionParam);

  const check = useCallback(async () => {
    try {
      await api.session();
      setPairing({ status: "paired" });
    } catch (error) {
      if (error instanceof StudioApiError && error.status === 401) setPairing({ status: "unpaired" });
      else setPairing({ status: "unreachable", message: error instanceof Error ? error.message : "The app did not answer." });
    }
  }, [api]);

  useEffect(() => {
    void check();
    const onPop = () => setProductionId(readProductionParam());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [check]);

  const open = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("production", id);
    else url.searchParams.delete("production");
    window.history.pushState(null, "", url);
    setProductionId(id);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.signOut();
    } finally {
      setPairing({ status: "unpaired" });
    }
  }, [api]);

  return (
    <div className="flex h-full flex-col bg-background">
      <TopBar title="Video Studio" showBack>
        {pairing.status === "paired" && (
          <div className="ml-auto">
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              <LogOut className="h-3.5 w-3.5" aria-hidden />
              Sign out
            </Button>
          </div>
        )}
      </TopBar>
      <main className="flex min-h-0 flex-1 flex-col">
        {pairing.status === "checking" && <p className="m-auto text-sm text-muted-foreground">Checking this browser&apos;s Studio session…</p>}
        {pairing.status === "unreachable" && (
          <div className="m-auto flex max-w-sm flex-col items-center gap-3 text-center">
            <p className="text-sm text-foreground">{pairing.message}</p>
            <Button variant="outline" size="sm" onClick={() => void check()}>
              Try again
            </Button>
          </div>
        )}
        {pairing.status === "unpaired" && <PairingPanel onPaired={() => setPairing({ status: "paired" })} />}
        {pairing.status === "paired" && !productionId && <ProductionPicker onOpen={open} />}
        {pairing.status === "paired" && productionId && <StudioWorkspace key={productionId} productionId={productionId} onClose={() => open(null)} />}
      </main>
    </div>
  );
}
