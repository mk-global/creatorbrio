"use client";

// Placeholder until its lane lands (#150).
export function ProductionPicker({ onOpen }: { onOpen: (id: string | null) => void }) {
  void onOpen;
  return <section aria-label="Productions" className="p-3 text-xs text-muted-foreground">Productions</section>;
}
