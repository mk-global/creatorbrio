# Design Agent

The Design Agent is the Claude CLI session that writes a carousel's slides.
It runs after the Visual Director has planned the request ([creative-workflow.md](creative-workflow.md)); this page describes how the chat route runs it and how it reaches the app.

## Running the agent

When you send a chat message, `/api/chat` starts the Claude CLI as a subprocess with `--allowedTools Bash WebFetch Read` and streams its replies back to the browser as Server-Sent Events.
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

`WebFetch` lets the agent research a topic while designing, and `Read` lets it open your reference images.

## Configuration it inherits

The Design Agent runs the `claude` command with your Claude Code sign-in and configuration, from the CreatorBrio folder.
Unlike the Visual Director, which is started with no setting sources, it loads your Claude Code settings and instructions and the repository's `CLAUDE.md`, so they apply to its replies.
