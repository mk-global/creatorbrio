"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useApp } from "@/components/app/AppContext";
import { PageNotice } from "@/components/app/PageNotice";
import { CreateFlow } from "@/components/create/CreateFlow";
import { useProjects, useTemplates } from "@/components/library/useLibrary";

/**
 * New project (#175): format, then details, then the editor. Nothing is
 * designed here; the description becomes the editor's first message, which
 * the person sends themselves.
 */
function CreatePage() {
  const params = useSearchParams();
  const { brands, selectedBrand, defaultBrandId, error } = useApp();
  const templates = useTemplates();
  const projects = useProjects();

  if (error) {
    return <PageNotice tone="alert" title="Your brands couldn't be loaded">{error} Nothing was deleted.</PageNotice>;
  }
  if (!selectedBrand || templates.state.status === "loading") {
    return (
      <p className="text-graphite" aria-busy="true">
        Getting things ready…
      </p>
    );
  }
  return (
    <CreateFlow
      brands={brands}
      initialBrand={selectedBrand}
      defaultBrandId={defaultBrandId}
      templates={templates.state.status === "ready" ? templates.state.items : []}
      templatesError={templates.state.status === "error" ? templates.state.message : null}
      projects={projects.state.status === "ready" ? projects.state.items : []}
      params={{ format: params.get("format"), template: params.get("template"), fromIdea: params.get("from") === "idea" }}
    />
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CreatePage />
    </Suspense>
  );
}
