"use client";

import Link from "next/link";
import { useAppStatus, type DesignAgentStatus } from "@/components/app/useAppStatus";
import { useStudioStatus } from "@/components/app/useStudioStatus";

function Row({ id, title, status, children }: { id?: string; title: string; status?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div id={id} className="grid scroll-mt-28 grid-cols-[minmax(0,1fr)] gap-2 border-t border-rule py-6 first:border-0 sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-8">
      <div className="flex flex-wrap items-center gap-2 sm:block">
        <h2 className="text-[16px] font-semibold">{title}</h2>
        {status && <div className="sm:mt-2">{status}</div>}
      </div>
      <div className="max-w-[64ch] min-w-0 space-y-2 text-[15px] text-ink/85">{children}</div>
    </div>
  );
}

/** The Design Agent's profile (#227): contained, with its CLI version and any warning, or why it cannot run. */
function DesignAgentTag({ status }: { status: DesignAgentStatus }) {
  if (status.profile !== "contained") return <span className="tag tag-neutral">{status.profile === "invalid" ? "Setting invalid" : "Not contained"}</span>;
  if (!status.available) return <span className="tag tag-alert">Unavailable</span>;
  return status.versionWarning ? <span className="tag tag-alert">Untested version</span> : <span className="tag tag-ok">Contained</span>;
}

function DesignAgentDetail({ status }: { status?: DesignAgentStatus }) {
  if (!status) return <p>Whether the Design Agent runs inside Claude Code&apos;s sandbox, with only its own carousel in reach.</p>;
  if (status.profile !== "contained") {
    return status.profile === "invalid" ? (
      <p>CREATORBRIO_DESIGN_AGENT_PROFILE in .env.local is neither legacy nor contained, so designs are refused until it is corrected.</p>
    ) : (
      <p>The Design Agent runs with your own Claude Code configuration and without the sandbox. The contained profile is off by default, optional and not qualified.</p>
    );
  }
  if (!status.available) {
    return (
      <>
        <p>{status.reason} Designing by chat is unavailable until it is fixed; existing work can still be opened, arranged and exported.</p>
        <p>{status.guidance}</p>
      </>
    );
  }
  return (
    <>
      <p>
        The Design Agent runs inside Claude Code&apos;s sandbox on Claude Code {status.cliVersion}. It is set up to reach only its own carousel through CreatorBrio, write only its own
        folders, and not read your home folder or CreatorBrio&apos;s files.
      </p>
      <p>This is not qualified. On Linux, its shell can also write the shared temporary folders.</p>
      {status.versionWarning && <p>{status.versionWarning} Run <code>npm run doctor</code> to check it.</p>}
    </>
  );
}

function Command({ children }: { children: string }) {
  return <code className="mt-2 block overflow-x-auto rounded-lg bg-ink px-4 py-3 font-mono text-[13.5px] whitespace-nowrap text-white">{children}</code>;
}

/**
 * Whether everything is working, and where work is kept (#175). Read-only:
 * the statuses come from the app itself, and nothing here shows a path, a
 * key or a token.
 */
export default function SettingsPage() {
  const status = useAppStatus();
  const studio = useStudioStatus(false);
  const checking = <span className="tag tag-neutral">Checking</span>;

  return (
    <div>
      <h1 className="type-title">Settings</h1>
      <p className="mt-2 max-w-[62ch] text-graphite">Whether everything is working, and where your work is kept.</p>

      <div className="panel mt-8 px-6">
        <Row
          id="claude"
          title="Claude Code"
          status={!status ? checking : status.claude.available ? <span className="tag tag-ok">Found</span> : <span className="tag tag-alert">Not found</span>}
        >
          {status?.claude.available === false ? (
            <>
              <p>CreatorBrio couldn&apos;t find Claude Code. You can still open, arrange and export existing work.</p>
              <p>Install Claude Code, sign in once in a terminal, then restart CreatorBrio.</p>
              {status.designAgent?.profile === "contained" && <p>The Design Agent also needs a token of its own, described under Design Agent protection below.</p>}
            </>
          ) : status?.designAgent?.profile === "contained" ? (
            <>
              <p>
                Designing by chat runs Claude Code on this computer. Planning (the Visual Director) uses your own Claude Code sign-in, which it shares with your normal Claude Code, including its sign-in storage and locks, so you still sign in once in a terminal.
              </p>
              <p>
                The Design Agent signs in with a separate token made from your Claude account, which counts against its usage. CreatorBrio checks that Claude Code can be found and that the token file is there and private, not that you are signed in or that the token is
                still valid.
              </p>
            </>
          ) : (
            <p>Designing by chat runs Claude Code on this computer, with your own Claude account. CreatorBrio checks that it can be found, not that you are signed in.</p>
          )}
        </Row>
        <Row
          id="design-agent"
          title="Design Agent protection"
          status={!status?.designAgent ? (status ? null : checking) : <DesignAgentTag status={status.designAgent} />}
        >
          <DesignAgentDetail status={status?.designAgent} />
        </Row>
        <Row
          title="Image generation"
          status={!status ? checking : status.imageGeneration.configured ? <span className="tag tag-ok">Set up</span> : <span className="tag tag-neutral">Not set up</span>}
        >
          <p>
            Optional. When an image service is set up, designs can generate or edit images on this computer.
            {status?.imageGeneration.configured && " Whether it is running is only known when a design asks it for an image."}
          </p>
        </Row>
        <Row
          title="Video Studio"
          status={
            studio.state === "checking" ? (
              checking
            ) : studio.state === "paired" ? (
              <span className="tag tag-ok">This browser is paired</span>
            ) : (
              <span className="tag tag-neutral">{studio.state === "unreachable" ? "Didn't answer" : "Not paired"}</span>
            )
          }
        >
          {studio.state === "paired" ? (
            <p>
              Sign this browser out from the{" "}
              <Link href="/studio" className="font-semibold underline underline-offset-4">
                Video Studio
              </Link>
              .
            </p>
          ) : (
            <p>
              <Link href="/studio" className="font-semibold underline underline-offset-4">
                Pair this browser
              </Link>{" "}
              from the Video Studio page. A pairing lasts 12 hours.
            </p>
          )}
          <div>
            <p>To sign out every browser at once, run this in the CreatorBrio folder:</p>
            <Command>npm run studio:pair -- --revoke-all</Command>
          </div>
          <p>The Studio needs FFmpeg 6 or later, with ffprobe.</p>
        </Row>
        <Row title="Your data">
          <p>
            Everything you make is saved as files on this computer: projects, brands, templates and videos in the{" "}
            <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-[13px] text-ink">data</code> folder inside CreatorBrio, and uploaded images and fonts in{" "}
            <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-[13px] text-ink">public/uploads</code>.
          </p>
          <p>To back up your work, copy both folders while CreatorBrio is stopped.</p>
        </Row>
        <Row title="What leaves this computer">
          <p>When you design by chat, your message, your brand and the project go to Claude through Claude Code. Links you paste are fetched while designing.</p>
          <p>The Video Studio sends nothing out. Fonts for slides load from Google Fonts.</p>
        </Row>
        <Row title="About">
          <p>CreatorBrio, a local-first creative studio. Derived from Open Carrusel, MIT licence.</p>
        </Row>
      </div>
    </div>
  );
}
