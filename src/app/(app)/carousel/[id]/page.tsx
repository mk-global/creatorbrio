"use client";

import { useEffect, useState, useCallback, useRef, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app/AppContext";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { CarouselPreview } from "@/components/editor/CarouselPreview";
import { SlideFilmstrip } from "@/components/editor/SlideFilmstrip";
import { EditorHeader } from "@/components/editor/EditorHeader";
import { ExportButton } from "@/components/editor/ExportButton";
import { duplicateProject, saveProjectAsTemplate } from "@/components/library/useLibrary";
import { FORMATS, formatOf, primaryExportFor } from "@/lib/formats";
import { clearDraft, readDraft } from "@/lib/new-project-handoff";
import { CaptionPanel } from "@/components/editor/CaptionPanel";
import { FullscreenPreview } from "@/components/editor/FullscreenPreview";
import { useGenerationStatus } from "@/components/editor/useGenerationStatus";
import type { Carousel, AspectRatio } from "@/types/carousel";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function CarouselEditorPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();
  const { brands, defaultBrandId, toast } = useApp();
  // Words the New project form left for the message box; read once, cleared once mounted.
  const [initialDraft] = useState(() => readDraft(id));
  useEffect(() => clearDraft(id), [id]);
  const [pane, setPane] = useState<"preview" | "chat">(initialDraft ? "chat" : "preview");
  const [carousel, setCarousel] = useState<Carousel | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeSlide, setActiveSlide] = useState(0);
  const [claudeAvailable, setClaudeAvailable] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showSafeZones, setShowSafeZones] = useState(false);
  const [showFullscreen, setShowFullscreen] = useState(false);
  // This tab's chat stream, or a run the server reports: started from another
  // tab, still running after a reload, or settling after the stream closes.
  // Also whether the last run was interrupted after changing slides.
  const generation = useGenerationStatus(id, isGenerating);
  const generationActive = generation.generating;

  // Confirm dialog state
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    description: string;
    onConfirm: () => void;
  }>({ open: false, title: "", description: "", onConfirm: () => {} });

  // Ref for focusing chat input when + button is clicked
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

  const fetchCarousel = useCallback(async () => {
    try {
      const res = await fetch(`/api/carousels/${id}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        // Report why the carousel could not be read instead of spinning
        // forever. Transient failures while polling are ignored so a blip
        // during generation does not replace a carousel already on screen.
        const body = await res.json().catch(() => ({}));
        const message = (body as { error?: string }).error;
        setLoadError(message || `Request failed with status ${res.status}.`);
        return;
      }
      {
        const data = await res.json();
        setLoadError(null);
        setCarousel((prev) => {
          // If new slides were added during generation, jump to the latest slide
          if (prev && data.slides.length > prev.slides.length) {
            setActiveSlide(data.slides.length - 1);
          } else {
            setActiveSlide((prevIdx) =>
              data.slides.length === 0 ? 0 : Math.min(prevIdx, data.slides.length - 1)
            );
          }
          return data;
        });
      }
    } catch {
      // ignore network errors
    }
  }, [id]);

  // Initial data load
  useEffect(() => {
    const load = async () => {
      await fetchCarousel();
      try {
        const res = await fetch("/api/chat/check");
        const data: { available?: boolean } = await res.json();
        if (data.available === false) setClaudeAvailable(false);
      } catch {
        // assume available
      }
    };
    load();
  }, [fetchCarousel]);

  // Poll for carousel updates while AI is generating slides
  useEffect(() => {
    if (!generationActive) return;
    const interval = setInterval(() => {
      fetchCarousel();
    }, 500);
    return () => {
      clearInterval(interval);
      // One last read once generation ends, so the slides saved last are on
      // screen even when the run was not started from this tab.
      fetchCarousel();
    };
  }, [generationActive, fetchCarousel]);

  const handleAspectChange = async (ratio: AspectRatio) => {
    if (!carousel) return;
    const res = await fetch(`/api/carousels/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aspectRatio: ratio }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      setCarousel(body as Carousel);
      toast(`Size changed to ${ratio}. Slides keep their layout; ask in the chat to adapt them to the new size.`);
    } else {
      toast(`The size wasn't changed: ${(body as { error?: string }).error ?? `status ${res.status}`}`);
    }
  };

  const handleDeleteSlide = (slideId: string) => {
    if (!carousel) return;
    const slideIndex = carousel.slides.findIndex((s) => s.id === slideId);
    setConfirmState({
      open: true,
      title: `Delete slide ${slideIndex + 1}?`,
      description: "This action cannot be undone.",
      onConfirm: async () => {
        const res = await fetch(`/api/carousels/${id}/slides/${slideId}`, {
          method: "DELETE",
        });
        if (res.ok) await fetchCarousel();
      },
    });
  };

  const handleUndoSlide = async (slideId: string) => {
    const res = await fetch(`/api/carousels/${id}/slides/${slideId}/undo`, {
      method: "POST",
    });
    if (res.ok) await fetchCarousel();
  };

  const handleDeleteCarousel = useCallback(() => {
    if (!carousel) return;
    setConfirmState({
      open: true,
      title: `Delete "${carousel.name}"?`,
      description: "The project and its slides are removed from this computer. Exports you already downloaded are not affected.",
      onConfirm: async () => {
        const res = await fetch(`/api/carousels/${id}`, { method: "DELETE" });
        if (res.ok) {
          toast(`Deleted "${carousel.name}".`);
          router.push("/projects");
        } else toast("The project wasn't deleted. Try again.");
      },
    });
  }, [carousel, id, router, toast]);

  const handleStreamStart = useCallback(() => {
    setIsGenerating(true);
  }, []);

  const handleStreamEnd = useCallback(() => {
    setIsGenerating(false);
    fetchCarousel();
  }, [fetchCarousel]);

  const handleReorderSlides = useCallback(
    async (slideIds: string[]) => {
      await fetch(`/api/carousels/${id}/slides`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slideIds }),
      });
      await fetchCarousel();
    },
    [id, fetchCarousel]
  );

  const handleAddSlideRequest = useCallback(() => {
    setChatOpen(true);
    setPane("chat");
    // Focus chat input after a tick (to let panel render)
    setTimeout(() => {
      chatInputRef.current?.focus();
    }, 100);
  }, []);

  if (notFound) {
    return (
      <div className="mx-auto max-w-[640px] overflow-y-auto px-6 py-24">
        <h1 className="display text-[44px]">Project not found</h1>
        <p className="mt-2 text-graphite">It may have been deleted.</p>
        <Link href="/projects" className="btn btn-primary mt-6">
          Back to projects
        </Link>
      </div>
    );
  }

  if (!carousel && loadError) {
    return (
      <div className="mx-auto max-w-[640px] overflow-y-auto px-6 py-24">
        <h1 className="display text-[44px]">Couldn&apos;t open this project</h1>
        <p className="mt-2 break-words text-graphite">{loadError}</p>
        <p className="mt-1 text-[14px] text-graphite">Nothing was deleted. Your data files were left as they are.</p>
        <Link href="/projects" className="btn btn-primary mt-6">
          Back to projects
        </Link>
      </div>
    );
  }

  if (!carousel) {
    return (
      <p className="m-auto text-graphite" aria-busy="true">
        Opening the project…
      </p>
    );
  }

  const format = formatOf(carousel);
  const brand = brands.find((b) => b.id === (carousel.brandId ?? defaultBrandId));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorHeader
        key={carousel.id}
        carousel={carousel}
        format={format}
        brand={brand}
        onRename={async (name) => {
          try {
            const res = await fetch(`/api/carousels/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name }),
            });
            if (res.ok) {
              setCarousel(await res.json());
              return true;
            }
          } catch {
            // reported below
          }
          toast("The new name wasn't saved. Try again.");
          return false;
        }}
        onSize={handleAspectChange}
        safeZones={showSafeZones}
        onSafeZones={setShowSafeZones}
        onFullscreen={() => setShowFullscreen(true)}
        chatOpen={chatOpen}
        onChatOpen={setChatOpen}
        pane={pane}
        onPane={setPane}
        onDuplicate={() =>
          void duplicateProject(carousel.id).then(
            (copy) => {
              toast(`Made a copy: "${copy.name}". Opening it.`);
              router.push(`/carousel/${encodeURIComponent(copy.id)}`);
            },
            (err: unknown) => toast(`Couldn't duplicate: ${err instanceof Error ? err.message : "the app did not answer."}`)
          )
        }
        onSaveTemplate={() =>
          void saveProjectAsTemplate(carousel.id).then(
            (t) => toast(`Saved "${t.name}" as a template.`),
            (err: unknown) => toast(`Couldn't save the template: ${err instanceof Error ? err.message : "the app did not answer."}`)
          )
        }
        onDelete={handleDeleteCarousel}
        exportButton={
          <ExportButton
            carouselId={carousel.id}
            slideCount={carousel.slides.length}
            aspectRatio={carousel.aspectRatio}
            generating={generationActive}
            interrupted={generation.interrupted}
            plannedSlides={generation.continuation?.expected ?? null}
            onAcceptInterrupted={generation.acceptSlides}
            primary={primaryExportFor(format, carousel.slides.length)}
          />
        }
      />

      <FullscreenPreview
        open={showFullscreen}
        onOpenChange={setShowFullscreen}
        slides={carousel.slides}
        aspectRatio={carousel.aspectRatio}
        activeIndex={activeSlide}
        onActiveChange={setActiveSlide}
      />

      <ConfirmDialog
        open={confirmState.open}
        onOpenChange={(open) => setConfirmState((s) => ({ ...s, open }))}
        title={confirmState.title}
        description={confirmState.description}
        confirmLabel="Delete"
        cancelLabel="Keep it"
        variant="destructive"
        onConfirm={confirmState.onConfirm}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* The chat stays mounted while hidden, so a run in progress and its messages are kept. */}
        <div
          className={`${pane === "chat" ? "flex" : "hidden"} min-h-0 w-full shrink-0 flex-col border-r border-rule bg-surface lg:w-[380px] ${chatOpen ? "lg:flex" : "lg:hidden"}`}
        >
          <ChatPanel
            carouselId={id}
            claudeAvailable={claudeAvailable}
            referenceImages={carousel.referenceImages || []}
            onStreamStart={handleStreamStart}
            onStreamEnd={handleStreamEnd}
            chatInputRef={chatInputRef}
            continuation={generation.continuation}
            initialDraft={initialDraft}
          />
        </div>

        <div className={`${pane === "preview" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col lg:flex`}>
          <CarouselPreview
            slides={carousel.slides}
            aspectRatio={carousel.aspectRatio}
            activeIndex={activeSlide}
            onActiveChange={setActiveSlide}
            showSafeZones={showSafeZones}
          />
          <CaptionPanel caption={carousel.caption} hashtags={carousel.hashtags} />
          <SlideFilmstrip
            slides={carousel.slides}
            aspectRatio={carousel.aspectRatio}
            activeIndex={activeSlide}
            onActiveChange={setActiveSlide}
            onDeleteSlide={handleDeleteSlide}
            onUndoSlide={handleUndoSlide}
            onAddSlideRequest={handleAddSlideRequest}
            onReorderSlides={handleReorderSlides}
            isGenerating={isGenerating}
            maxSlides={FORMATS[format].maxSlides}
          />
        </div>
      </div>
    </div>
  );
}
