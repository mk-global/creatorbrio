# CreatorBrio architecture

CreatorBrio is a local, single-user studio for branded social content: you describe a carousel or a reel cover in a chat, and AI agents plan and design it as HTML slides you can preview and export.
This page is the entry point for contributors who want to understand or extend how it works.
It describes only what is merged; anything not shipped is labelled.

## Goals

- **Effective content, not decoration.** Every request starts by deciding what the content is for and who it is for, and only then how it should look.
- **The user stays in charge.** Explicit instructions win over inferences, nothing is silently substituted, and every difference between the plan and the result is shown.
- **Local first.** Everything runs on the user's machine, stores data in plain files, and needs no account or hosted service beyond the Claude CLI.
- **Recoverable.** A crash, restart or cancellation never leaves half-attached images or claims unfinished slides are finished.

## Components

```mermaid
flowchart LR
    U[Browser: chat, preview, filmstrip] -->|POST /api/chat, SSE| R[Chat route]
    R --> CR[Creative run]
    CR --> SR[Source retrieval]
    CR --> VD[Visual Director: Claude CLI, Read only]
    CR --> IS[Image client]
    IS -.->|optional, loopback| SVC[(Local image service, separate)]
    CR --> AS[Asset module]
    R --> DA[Design Agent: Claude CLI session]
    DA -->|curl| API[App API routes]
    API --> ST[(JSON files and uploads)]
    AS --> ST
    U -->|export| EX[Export: Puppeteer to PNG, ZIP or PDF]
    EX --> ST
```

| Component | Responsibility | Where |
|---|---|---|
| Chat route | Owns each carousel's single active run and the event stream; runs the creative run, then the Design Agent; ends the run exactly once | `src/app/api/chat/route.ts` |
| Creative run | Sequences linked pages, planning, images and the handoff; decides when a run is blocked | `src/lib/creative-run.ts` |
| Source retrieval | Reads up to three public pages linked in a message, behind a network boundary | `src/lib/source-retrieval.ts` |
| Visual Director | Decides the visual strategy and returns a validated plan; never designs slides | `src/lib/visual-director.ts`, `src/lib/director-plan.ts` |
| Creative Brief | What a carousel is for, kept across revisions | `src/lib/creative-brief.ts` |
| Image client | Requests and validates one image from the optional local image service | `src/lib/image-service.ts` |
| Asset module | Stages, attaches, recovers and expires generated images | `src/lib/assets.ts` |
| Handoff and conformance | The Design Agent's visual plan section, and the check after design | `src/lib/creative-handoff.ts` |
| Design Agent | Writes the copy and builds every slide in HTML and CSS through the app's API | `src/lib/chat-system-prompt.ts` |
| Storage | JSON files with a per-file lock and atomic writes, plus uploaded files | `src/lib/data.ts`, `data/`, `public/uploads/` |
| Rendering and export | One shared slide document for preview and export; Puppeteer screenshots in one headless browser per server process | `src/lib/slide-html.ts`, `src/lib/export-slides.ts` |

## How a request flows

1. The chat route begins the carousel's run; a second message for the same carousel is refused while it is active.
2. The creative run reads any linked pages, asks the Visual Director for a plan, generates and attaches the plan's images, and then saves the plan's Creative Brief update.
3. The Design Agent receives the user's message followed by the visual plan, resumes the carousel's conversation, and builds the slides.
4. The server checks the slides against the plan and shows any differences.
5. The user previews and exports; export waits until the run has finished.

Any stage before design can stop the run as blocked, with a reason and, when it makes sense, a Retry button.
The details are in [creative-workflow.md](creative-workflow.md).

## Local-first principles

- The app listens on `127.0.0.1` only, and its API refuses requests from other hosts and cross-site origins.
- Data is plain JSON in `data/` and files in `public/uploads/`; backing up means copying those folders.
- There is no database, queue, scheduler, vector store or agent framework; long work runs inside the request that asked for it, within fixed limits.
- Both agents are Claude CLI processes on the user's own Claude account.
- Image generation is optional and separate: a local service with a small public contract (a loopback `POST /generate` with a prompt and aspect ratio, returning a PNG). It is not part of this repository, and without it every other feature works.

## Boundaries

- The Design Agent's system prompt is frozen and pinned by a test; plans reach it only in the task message.
- The Visual Director can read only copies of the carousel's own images in a temporary folder, has no shell or network tools, and returns data the server validates before acting on it.
- No model-provided path, URL, command or ID is acted on without being checked against what the server knows.
- Both agents run as the same operating-system account as the app; their tool restrictions are policy enforced by the Claude CLI, not operating-system isolation.

## Further reading

- [visual-director.md](visual-director.md): how the Director reasons, the Creative Brief, capabilities, the plan and its evaluation.
- [creative-workflow.md](creative-workflow.md): stages, outcomes, retry, cancellation, limits and the generated-image lifecycle.
- [design-decisions.md](design-decisions.md): why the system is shaped this way, and the trade-offs.
- [../PROVENANCE.md](../PROVENANCE.md) and [../MAINTAINING.md](../MAINTAINING.md): origin, licence and maintenance.
