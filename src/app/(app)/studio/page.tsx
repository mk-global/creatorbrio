import type { Metadata } from "next";
import { Suspense } from "react";

import { StudioApp } from "@/components/studio/StudioApp";

export const metadata: Metadata = {
  title: "Video Studio - CreatorBrio",
};

export default function StudioPage() {
  // StudioApp reads the URL's search parameters, which need a Suspense boundary.
  return (
    <Suspense>
      <StudioApp />
    </Suspense>
  );
}
