"use client";

// Placeholder until its lane lands (#150).
export function PairingPanel({ onPaired }: { onPaired: () => void }) {
  void onPaired;
  return <section aria-label="Pair this browser" className="p-3 text-xs text-muted-foreground">Pair this browser</section>;
}
