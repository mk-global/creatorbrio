/**
 * The Design Agent's Claude CLI arguments, shared by the chat route and the
 * acceptance harness's Design-Agent-only comparison, so both run the agent
 * exactly the same way. The task message is the user's message, followed by
 * the visual plan when there is one; the system prompt never carries the plan.
 */
export function designAgentArgs(options: {
  taskMessage: string;
  systemPrompt: string;
  resumeSessionId: string | null;
}): string[] {
  return [
    "-p",
    options.taskMessage,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--append-system-prompt",
    options.systemPrompt,
    "--allowedTools",
    "Bash",
    "--allowedTools",
    "WebFetch",
    "--allowedTools",
    "Read",
    "--max-budget-usd",
    "1.00",
    "--name",
    "creatorbrio-chat",
    ...(options.resumeSessionId ? ["--resume", options.resumeSessionId] : []),
  ];
}
