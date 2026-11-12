"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useApp } from "@/components/app/AppContext";
import { PageNotice } from "@/components/app/PageNotice";
import { BrandEditor } from "@/components/brands/BrandEditor";

export default function EditBrandPage() {
  const { id } = useParams<{ id: string }>();
  const { brands, selectedBrandId, error } = useApp();
  if (error) return <PageNotice tone="alert" title="Your brands couldn't be loaded">{error} Nothing was deleted.</PageNotice>;
  // The brands are loaded once a brand has been chosen for new work.
  if (!selectedBrandId) return <p className="text-graphite" aria-busy="true">Reading your brands…</p>;
  const brand = brands.find((b) => b.id === id);
  if (!brand) {
    return (
      <div className="max-w-[56ch]">
        <h1 className="display text-[44px]">Brand not found</h1>
        <p className="mt-2 text-graphite">It may have been removed from this computer&apos;s data.</p>
        <Link href="/brands" className="btn btn-primary mt-6">Back to brands</Link>
      </div>
    );
  }
  return <BrandEditor key={brand.id} existing={brand} />;
}
