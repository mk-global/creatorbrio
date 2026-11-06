import type { Metadata } from "next";

import { StudioApp } from "@/components/studio/StudioApp";

export const metadata: Metadata = {
  title: "Video Studio - CreatorBrio",
};

export default function StudioPage() {
  return <StudioApp />;
}
