# Design Agent

The Design Agent is the Claude CLI session that writes a carousel's slides.
It runs after the Visual Director has planned the request ([creative-workflow.md](creative-workflow.md)); this page describes how the chat route runs it and how it reaches the app.

## Running the agent

When you send a chat message, `/api/chat` starts the Claude CLI as a subprocess and streams its replies back to the browser as Server-Sent Events.
How it is started depends on the Design Agent profile, `legacy` or `contained` ([Profiles](#profiles)).
Each carousel's chat is one continuing conversation: the browser keeps that carousel's Claude session ID next to its transcript and sends it with the next message, so the agent resumes with everything said before.
Clear starts a new conversation, and a session Claude Code can no longer find is reset automatically, with a message asking you to send again.
If the agent fails after it has started replying, the chat panel keeps the partial reply and says what went wrong; diagnostic details stay in the server log.
The agent's system prompt includes the open carousel's brand configuration, its slide list (IDs and notes), its reference images, and the address of this running app.
A reference image is always an uploaded image stored as `public/uploads/<uuid>.png`; the server derives its path itself and lists only references that are still readable PNG files inside `public/uploads/`, so a reference can never point the agent at another file.
That path exists only on the server: a reference is stored as its URL, name and date, and no API response carries a server file path, including the `absPath` that records stored before #62 still hold (`carouselResponse()` in `src/lib/carousels.ts`).
Carousels created before multiple brands existed belong to the default brand, the original one.
The agent reads and writes slide content through the app's API.

The agent then works through the app's own API:

1. It writes each slide as body-level HTML and CSS.
2. It saves the slide by calling `/api/carousels/[id]/slides` with `curl`, through its `Bash` tool.
3. The editor refreshes while the agent works, so new and changed slides appear in the filmstrip.

## Profiles

`CREATORBRIO_DESIGN_AGENT_PROFILE` in `.env.local` selects the profile, read on every request.
It is `legacy` when unset, or `contained`; any other value refuses designs with `profile_setting_invalid` until it is corrected.
The contained profile is dark: it is switched on only after it qualifies under #237, which then removes the legacy profile.
`src/lib/design-agent-profile.ts` owns the contained profile; Settings shows which profile runs and whether it can run on this computer.

### Legacy

The agent runs `claude` with `--allowedTools Bash WebFetch Read`, from the CreatorBrio folder, with your Claude Code sign-in and configuration.
Unlike the Visual Director, which is started with no setting sources, it loads your Claude Code settings and instructions and the repository's `CLAUDE.md`, so they apply to its replies.
`WebFetch` lets it research a topic while designing, and `Read` lets it open your reference images.
It curls the app's own API at the origin the request arrived on.

### Contained

The contained profile (#156, #186, #226, #227, #228) gives the agent one carousel and nothing else.

- **Explicit configuration.** The CLI loads no setting sources, no MCP servers and no slash commands, so no personal instructions, tools, plugins, hooks or memory reach it.
  The model (`claude-opus-5-5`), effort (`medium`), tools (`Bash` and `Read`) and permission mode (`dontAsk`) are fixed by the profile, and auto-memory and the auto-updater are off.
  Thinking is the CLI's own adaptive default for the model, recorded in the profile rather than passed.
- **No web fetch.** The agent has no `WebFetch` or `WebSearch`.
  The server reads linked pages itself, as it does for the Visual Director, and gives the agent their text in its task message inside an untrusted-page block that page text cannot close.
  The pages share what is left of the single command-line argument the task travels in (`MAX_DESIGN_MESSAGE_BYTES`), cut at a character boundary and marked truncated when they do not fit.
  A retry reads the pages again.
- **Sandbox.** Every shell command runs inside Claude Code's sandbox, which must be available (`failIfUnavailable`) and cannot be bypassed (`allowUnsandboxedCommands: false`).
  The shell can reach only the run's listener, through the sandbox's proxy with a strict allowlist.
  It may write only the carousel's own folder and the run's temporary folder.
  It cannot read the home folder, the repository, the data folder, the CLI's shared temporary folder, the folder that holds every carousel's folder (other than its own), a CLI configuration folder kept outside home or, on macOS, the per-user temporary folder.
  Other system locations stay readable, as the sandbox reads them by default.
- **Read tool.** `Read` is allowed only inside the carousel's folder, and refused everywhere else.
- **Environment.** The CLI receives an explicit allowlist of variables (sign-in, locale, proxy and the run's own values); nothing else in the app's environment reaches it.
  The CLI's environment scrub (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) keeps its sign-in variables out of the agent's shell.
  Measured on 2.1.328 on macOS and Linux with a synthetic value planted in each sign-in variable: the shell found none in its own environment, its ancestors' environments or the process table, while the legacy profile's shell, running the same probe, found them.
  Residual exposure, measured on 2.1.328 on macOS and Linux: the CLI itself still gives the shell its messaging socket's address, whose connections the sandbox refuses, and the sandbox proxy's own username and password, which reach only that proxy.
- **Its own folder.** The agent works in `~/.creatorbrio/design-agent/<carousel id>`, outside the repository (`CREATORBRIO_DESIGN_AGENT_WORKSPACES` moves it to another absolute path). A new conversation starts from an empty folder; a resumed one keeps it, so the CLI's session continues.
  The CLI resumes any session it can find, whatever folder it began in.
  So a contained run resumes only a session the server bound to the same carousel after an earlier contained run (`src/lib/agent-sessions.ts`, `data/design-agent-sessions.json`); any other session id, including one from before the contained profile or from the person's own Claude Code use, is refused as not found before the agent starts, and the chat starts a fresh conversation.
  A carousel's bindings are removed with it.
  Reference images are copied into the folder, and the prompt names the copies.
  The server rebuilds that copy folder for every run and creates each copy exclusively, so it never writes through a link the agent left there.
  The folder is removed with its carousel.
- **Run-scoped authority.** Each run gets a random token, passed only in the agent's environment (as `CREATORBRIO_AGENT_GRANT`, a name the scrub keeps) and accepted only by the agent-only listener for that run's carousel.
  It expires a minute after the run's deadline and is revoked when the run ends, however it ends; it is redacted from the chat stream and the server log, and stored in no run record.

#### The agent-only listener

`src/lib/agent-listener.ts` is a separate HTTP listener on an ephemeral loopback port, started with the first contained run.
It serves exactly six operations, each for the token's own carousel: read the carousel, add a slide, reorder slides, update a slide, delete a slide, and save the caption.
It forwards an allowed request to the app's own route with only the method, path and a JSON content type, so the main routes validate it as they validate any request.
Like those routes, it accepts a JSON body whatever content type it declares.
If another program holds its port on the IPv6 loopback, it does not start, so `localhost` never reaches that program.
It refuses with a JSON `error` naming the reason:

| Status | `error` | When |
| --- | --- | --- |
| 400 | `body_refused` | A body that is not JSON, larger than 4 MiB, or sent to an operation without one |
| 401 | `token_refused` | No token, or one that is unknown, expired or revoked |
| 403 | `browser_request` | An `Origin` or any `Sec-Fetch-*` header |
| 403 | `host_refused` | A `Host` other than the listener's own loopback address |
| 403 | `carousel_refused` | A token for another carousel |
| 404 | `operation_not_served` | Any other method or path, including style presets, brands, templates, uploads, export and every Video Studio route |
| 502 | `forward_failed` | The app did not answer |

Tokens are never logged.

#### Where it runs

The contained profile's containment has been tested, with a stand-in for the model, on macOS and on Debian 12 Linux with bubblewrap and socat installed, with Claude Code 2.1.328.
Its M1 qualification (real-model runs, the T1 hostile-input run and the creative-quality comparison) is still open, and it stays off until #237 activates it.
Other Linux distributions have not been tested.
It is not available on Windows or WSL2, which have not been tested, and it refuses a Claude Code older than 2.1.219.
Another version from 2.1.219 runs with a warning in Settings, because its sandbox may behave differently.
Install Claude Code 2.1.328 where it does not update itself, and point `CLAUDE_CLI_PATH` at it.
When the contained agent cannot run, a design is refused with `agent_unavailable` before anything is planned, and Home and Settings say what it needs.
