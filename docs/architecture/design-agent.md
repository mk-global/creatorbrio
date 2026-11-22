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

The contained profile (#156, #186, #226, #227, #228, #241, #242) gives the agent one carousel and nothing else.

- **Explicit configuration.** The CLI loads no setting sources, no MCP servers and no slash commands.
  A stand-in check with planted personal and project instructions, rules, skills, agents, hooks, a settings model and MCP servers found none of them reaching the agent.
  Whether a personal plugin or advisor setting is also kept out has not been checked yet (#237).
  Personal shell startup files are kept out by the server-owned home (below).
  The model (`claude-opus-5-5`), effort (`medium`), tools (`Bash` and `Read`) and permission mode (`dontAsk`) are fixed by the profile, and auto-memory and the auto-updater are off.
  Thinking is the CLI's own adaptive default for the model, recorded in the profile rather than passed.
- **No web fetch.** The agent has no `WebFetch` or `WebSearch`, so the topic research the legacy agent could do while designing is removed: it works from the request, the plan and the pages linked in the message.
  The server reads linked pages itself, as it does for the Visual Director, and gives the agent their text in its task message inside an untrusted-page block that page text cannot close.
  The pages share what is left of the single command-line argument the task travels in (`MAX_DESIGN_MESSAGE_BYTES`), cut at a character boundary and marked truncated when they do not fit.
  They leave room for a Continue in a new conversation, which repeats the task with the plan's slides, so pages never make a Continue fail to start.
  A retry reads the pages again.
- **Sandbox.** Every shell command runs inside Claude Code's sandbox, which must be available (`failIfUnavailable`) and cannot be bypassed (`allowUnsandboxedCommands: false`).
  The shell can reach only the run's listener, through the sandbox's proxy with a strict allowlist; on macOS the evidence's positive control for an external address used HTTP only.
  On macOS it may write only the conversation's own folder and the run's temporary folder.
  On Linux the shell can also write the shared, world-writable temporary folders: the CLI's sandbox (2.1.328) leaves them writable, and denying writes there also hides the run's own temporary folder beneath them, which breaks the run (measured: writes to its own temporary folder and session resume then fail), so the profile cannot close it.
  So on Linux the property that the shell writes only its own folders does not hold.
  Closing it needs a change in the CLI's sandbox or a stronger boundary, a separate operating system account or a container per run, and Linux is not qualified for that property until then (#237).
  It cannot read the home folder, the repository, the data folder, the CLI's shared temporary folder, the folder that holds every carousel's folder (other than its own conversation's folder and its staged images), the per-user temporary parent (other than the run's own temporary folder) or, on macOS, the per-user temporary folder.
  On macOS a bare `mktemp` ignores the run's temporary folder and tries the per-user temporary folder, so it fails; naming the run's folder (`mktemp "$TMPDIR/name.XXXXXX"`) works.
  A CLI configuration folder kept outside home is denied too, by configuration only: no check has probed it yet.
  Other system locations stay readable, as the sandbox reads them by default, including other programs' files in the shared temporary folders.
- **Read tool.** `Read` is allowed only inside the conversation's folder and its staged images, and refused everywhere else, including the per-user temporary parent.
- **Environment.** The CLI receives an explicit allowlist of variables (sign-in, locale, proxy and the run's own values), with its home folder set to the server-owned one; nothing else in the app's environment reaches it.
  The CLI's environment scrub (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) keeps its sign-in variables out of the agent's shell.
  Measured on 2.1.328 on macOS and Linux with a synthetic value planted in each sign-in variable: the shell found none in its own environment, its ancestors' environments or the process table, while the legacy profile's shell, running the same probe, found them.
  Residual exposure, measured on 2.1.328 on macOS and Linux: the CLI itself still gives the shell its messaging socket's address, whose connections the sandbox refuses, and the sandbox proxy's own username and password, which reach only that proxy.
- **Server-owned home.** The CLI runs with its home folder set to one the server owns, `.home` in the agent folders' root (`~/.creatorbrio/design-agent/.home` by default), never the person's home (#242).
  The CLI prepares each shell command by sourcing the startup files in its home folder, in a shell of its own outside the sandbox.
  With the person's home, every contained launch ran the person's shell startup files outside the sandbox, though the sandbox kept their aliases and functions out of the agent's commands.
  The server-owned home holds no shell startup files, so a contained launch runs none of the person's.
  The server creates it owner-only and never follows it through a link; if it exists as a link, with another owner or with group or other access, a design is refused (`start_failed`) and the server log names the folder by its last component.
  A shell startup file found in it is refused the same way and never deleted, since the server never writes one; the empty files the CLI's sandbox leaves in their place on Linux define nothing and are kept.
  Startup files the operating system itself reads, outside any home folder, still apply, as they do to the legacy profile.
  The home keeps the CLI's own state between runs, its configuration file and the transcripts that a resumed conversation continues, so it survives server restarts and no sweep or carousel deletion removes it.
  The agent's shell is denied reading it, as it is denied the person's home, and its write attempts, including planting a startup file, are refused.
  The profile never gives the CLI the person's configuration folder (`CLAUDE_CONFIG_DIR`), which would move the CLI's state, and on macOS the name of its keychain entry, into the person's folder.
  On macOS the CLI finds the person's sign-in in their login keychain, which it locates through its home folder, so the server-owned home holds one link, `Library/Keychains`, to the person's keychain folder, and nothing else of theirs.
  Measured on 2.1.328: a home without that link does not find the sign-in, including one holding a copy of the CLI's account file or of the person's preferences.
  Any other entry in place of that link is refused.
  On Linux the sign-in is the credentials file in the person's CLI configuration folder (`~/.claude`, or `CLAUDE_CONFIG_DIR` when it is an absolute path), which the CLI reads only from a real file: it refuses a link, and a copy would lose the refreshed sign-in the CLI writes back.
  So the profile names that folder as the sign-in store's location (`CLAUDE_SECURESTORAGE_CONFIG_DIR`), where the CLI reads and refreshes only that file, and the home holds nothing of the person's.
  On macOS the same variable is set only when the person has an absolute `CLAUDE_CONFIG_DIR`, because the CLI derives the keychain entry's name from it.
  This variable is internal to the CLI and undocumented: a version that drops it makes a contained run fail to sign in on Linux, or with a configuration folder of the person's on macOS, rather than exposing anything, and the stand-in qualification's sign-in store check detects that.
  A contained conversation begun before this change kept its transcript in the person's CLI folder, where the CLI no longer looks, so resuming it is reported as not found and the chat starts a fresh conversation; its slides are kept.
- **A folder per conversation.** The agent works in `~/.creatorbrio/design-agent/<carousel id>/<conversation id>`, outside the repository (`CREATORBRIO_DESIGN_AGENT_WORKSPACES` moves it to another absolute path).
  Each new conversation gets a new folder with a random name; a resumed one reopens its own folder, so the CLI's session continues, and a folder that is gone is never recreated.
  Starting a new conversation moves every earlier conversation folder of the carousel into the removal folder whole, and forgets their sessions, so a process an earlier run left behind never shares a folder with a later one.
  The CLI resumes any session it can find, whatever folder it began in.
  So a contained run resumes only a session the server bound to the same carousel and conversation after an earlier contained run (`src/lib/agent-sessions.ts`, `data/design-agent-sessions.json`); any other session id, including one from before the contained profile, one bound before conversation folders existed or one from the person's own Claude Code use, is refused as not found before the agent starts, and the chat starts a fresh conversation.
  A bound session whose conversation folder is gone is refused the same way, before anything is planned or any image is prepared.
  A carousel's bindings are removed with it.
  Reference images are copied into a staging folder beside the conversation's (`<carousel id>/.staged/<conversation id>`), which the agent may read but never write, and the prompt names the copies.
  Every conversation folder and staged image of a carousel is removed with the carousel.
- **Temporary folders.** Each run's temporary folder, and the Visual Director's image copies for a contained design, are created owner-only under one parent per user: `cb` followed by the user id in base 36, under `/tmp` on Linux and `/private/tmp` on macOS.
  The parent must be a real folder owned by the person running the server, with no group or other access, and is never followed through a link; if it fails that check, a contained design is refused rather than sharing it.
  The server log names the folder (its last path component only), and the operator's recovery is to remove it, or to fix its owner and permissions, and start the design again.
  The CLI uses a run's temporary folder only when the folder's path plus `claude-<user id>` fits in 44 bytes, so a run's folder sits directly in the parent, with a random name as long as that budget leaves room for.
  That is 15 characters for user id 501 on macOS and 22 for user id 1000 on Linux.
  The budget shrinks as the user id grows: on macOS, user ids from about 100 million get five characters or fewer, and the floor is three characters, which is all that fits for user ids from about 2.2 billion up (the longest case is exactly 44 bytes).
  A name is refused while its marker or its folder exists, and with names of about ten characters or more a name is not drawn twice in practice, which matters because on macOS a surviving process keeps its sandbox's access to the path it was given.
  With shorter names a later run can draw a name that an earlier run held, so for those user ids the residual below covers a run's temporary folder as well as a conversation's.
  Each server process has its own folder in the parent (`.s` and its process id), which holds the server's start time, the Director's copies and a marker for each run it owns, written before the run's folder exists and removed after it is gone.
  The contained shell is denied reading the parent, and only its own run's folder is re-allowed, so a run never reads another run's files or the Director's copies.
  With the legacy profile the Director keeps using the system's temporary folder.
- **Process lifecycle.** The CLI starts as the leader of its own process group.
  Because the CLI runs each shell command in a process group of its own, the server also stops what those commands started.
  While a run is live the server reads the process table periodically, which is one `ps` on macOS and a scan of `/proc` on Linux, and never a listing of working folders.
  It records the processes descended from the CLI, or from a process it recorded, each with its start time, and their process groups.
  Start times are read in one fixed time zone and locale, so the same process has the same start whichever settings the server runs under.
  A recorded process or group is signalled only while a process with the same id and start time is still there, so a reused process id is not hit, and a group with a member that has a controlling terminal is never signalled whole.
  The one exception is the server's shutdown, which acts at once on what a look only seconds old recorded, because an id could be reused in that time only if the system cycled through every process id.
  That blind kill applies the rule about a member with a controlling terminal as it was when the record was taken, not again.
  When a run ends by itself, is stopped or times out, the server sends SIGTERM and then, after a bounded wait, SIGKILL to the CLI's group, every recorded group and process, what is descended from them, the CLI's other descendants, and every process of the same user without a controlling terminal working in the run's folders (`src/lib/agent-processes.ts`).
  What the stop acts on is confirmed by process id and start time again before the SIGKILL.
  A process found only by its working folder brings its process group only when the run recorded that group or the process leads it; a process with a controlling terminal, such as a person's own shell opened in a conversation folder, is never taken for the run's.
  The run's stop and the start sweep (below) do take a person's own detached process, one without a controlling terminal, that works inside the hidden conversation or run folders; this is rare, because those folders are server-owned and not meant for people.
  The CLI's process id is the run's only while it is the same process, checked by the start time recorded when it was spawned, or by the server not having reaped it yet.
  The server, its own process group and its ancestors are never signalled.
  A look at the system that fails (the process table or the working folders cannot be read) is reported in the log with the carousel and run, because a failed look finds nothing and is not a clean stop.
  The run keeps its carousel's slot until this stop has finished and its session is bound, on every way the CLI can end.
  The legacy profile's process handling is unchanged.
- **Server shutdown and start.** With the contained profile only, when the server receives SIGTERM, SIGINT or SIGHUP (Ctrl-C, or a closed terminal), it stops the runs within the development server's window: that supervisor ends the server process about 100 ms after it forwards the signal, and the CLI no longer receives terminal signals itself because it leads its own process group (`src/instrumentation.ts`).
  First it sends SIGKILL to the CLI's group, before reading anything.
  Then it sends SIGKILL to every process and group recorded by a look only seconds old, without reading the process table first.
  Then it reads the process table once, sends SIGKILL to what older records name that is still the same process (by start time) and to what is descended from them, and aborts the runs, which sends no further signal and reads nothing more.
  It lists no working folders at shutdown.
  So at shutdown the server stops the CLI's group, what its periodic look had recorded and what is descended from those at that moment.
  It cannot stop, within that window, a process it never saw: one that works in the run's folders and has no controlling terminal is stopped by the next start (below), and any other is the residual below.
  The `/stop` command (`scripts/stop-server.mjs`) also stops processes the server started that outlive it, but only those working in the contained profile's folders (the agent workspace root and the per-user temporary parent) without a controlling terminal, each identified by process id and start time.
  Under the contained profile the Visual Director works inside the per-user temporary parent, so `/stop` stops a leftover Director that has no controlling terminal.
  A leftover Director that has one, as it does when the server was started from a terminal and the Director inherited it, is skipped: it keeps running until its CLI exits, because its time limit is a timer in the server, which is gone, and its folder is swept at the next contained start.
  Anything else the server started, such as the legacy Design Agent, the legacy Visual Director or the export browser, is left as before, and a configured agent folder inside or around the repository is never treated as contained.
  At start, before serving requests, and only while no other contained server of this user is running, the server stops leftover processes of this user without a controlling terminal whose working folder is one the contained profile's server makes: a conversation's folder or its staging folder, a run's temporary folder, a server folder, or a removal folder.
  It takes exactly these: processes of the same user, with no controlling terminal, working in such a folder, what is descended from them, and, for any of those that leads its own process group, the other members of that group, provided none of the group's members has a controlling terminal.
  Each is confirmed by process id and start time immediately before each signal, and is sent SIGTERM, then SIGKILL after a bounded wait if it is still there; a group stays to be sent SIGKILL while any member it had at the first look is still the same process and still in it.
  With another contained server running it stops none, because it cannot tell that server's background processes from leftovers.
  If another server starts while the processes are being read, it signals none when that is seen before its first signal, and when it is seen after SIGTERM was sent it sends no SIGKILL; the log says that SIGTERM had already been sent.
  A server counts as running while its process id is alive and, when the start time it recorded is known, still has that start time, so a reused process id does not keep a dead server's leftovers forever.
  Then it moves the run folders and server folders of servers that are no longer running, run folders no server owns, and its own leftovers no live run owns, into a removal folder in the parent, then deletes that and the agent folders' removal folder in the background.
  Only entries named as the removal itself names them are deleted there, and an agent folder setting inside or around the repository is not swept.
  Permissions the agent removed are restored first, through the folder itself and never through a link, and, on macOS, user immutable flags are cleared; anything that still cannot be removed is logged by folder name and retried at the next start.
  A removal folder, or the temporary parent, that is not a real folder of the person running the server with no group or other access is never moved into or deleted from; it is logged by name and left alone.
  With the legacy profile the server installs no shutdown handler and sweeps nothing at start.
- **Removing what the agent could write.** The server never deletes inside a folder the agent can still change, since a process changing a folder while it is deleted could redirect the delete outside it.
  It first moves the folder whole into a removal folder (`.removed`) beside the carousels' folders, or inside the per-user temporary parent for a run's temporary folder, which the agent cannot write, and deletes it there without following links.
  On macOS the sandbox's write rules follow paths, so the move ends a leftover process's writes to the folder, which the stand-in qualification's cleanup check measures (`eval/sandbox-route/qualify.ts`).
  A folder the agent made user-immutable cannot be moved on macOS; the server, which owns its parent, clears the flag and moves it once more.
  A carousel cannot be deleted while its contained run is live, and a run cannot start while its carousel is being deleted: both take the carousel's one slot.
  The slot lives in one server process's memory, so this exclusion holds within one server process, and running more than one contained server over the same data or agent folders is not supported before activation (#237).
  Within that limit, on Linux, where the sandbox's mount follows a moved folder, this is what keeps a live run's processes away from the removal.
- **Residual: processes that evade the stop.** On Linux no background process outlived its run in the stand-in qualification.
  macOS has no process-lifetime containment for an unprivileged server.
  A process is found by the stop only if one of the server's looks saw it as a descendant of the CLI, or of a process it had recorded, or if it works in the run's folders when the stop looks at them.
  A process that was never seen that way and does not work in the run's folders is not found, nor is what it starts: it runs until it exits or the computer restarts.
  A process that acquires a controlling terminal is the same residual: the run's stop, the shutdown stop, `/stop` and the start sweep do not stop it once the look they act on shows it with one.
  Such a process keeps only the run's sandbox rules: the folders it could write are moved away and removed (at the latest by the next start's sweep), and it cannot write a later conversation's folder, whose path is new and was never allowed to it.
  The same holds for a run's temporary folder, whose name is long and random, except where the names are short (see Temporary folders), where a later run can draw the same name and a surviving process could reach its folder.
  The stand-in qualification's survivor check holds its evader to that: on macOS it is inconclusive unless the evader was seen alive, in the process table, after the next conversation's folder existed, and where no evader survives (Linux) it records that the property was not exercised.
  The stronger boundary is a separate operating system account or a virtual machine for the agent.
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

The contained profile's containment has been tested, with a stand-in for the model, on macOS and on Debian 12 Linux (a container in Docker Desktop's Linux virtual machine) with bubblewrap and socat installed, with Claude Code 2.1.328.
Its M1 qualification (real-model runs, the T1 hostile-input run and the creative-quality comparison) is still open, and it stays off until #237 activates it.
Other Linux distributions have not been tested.
It is not available on Windows or WSL2, which have not been tested, and it refuses a Claude Code older than 2.1.219.
Another version from 2.1.219 runs with a warning in Settings, because its sandbox may behave differently.
Install Claude Code 2.1.328 where it does not update itself, and point `CLAUDE_CLI_PATH` at it.
When the contained agent cannot run, a design is refused with `agent_unavailable` before anything is planned, and Home and Settings say what it needs.
