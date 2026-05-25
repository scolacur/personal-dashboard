# Chat — PROJECT.md

A chat interface embedded in the dashboard for conversing with an LLM. Useful as a quick-access assistant without switching apps, and as a future entry point for reporting bugs or issuing tasks to automated agents.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- Standard chat UI: message history, user input, submit on Enter or button
- Streams responses token-by-token (feels fast, like Claude.ai / ChatGPT)
- Backend proxies requests to the configured LLM (Claude API via Anthropic SDK for MVP)
- Conversation history kept in-memory on the frontend (no persistence in MVP — refresh = new conversation)
- Model and API key configured via env vars
- Markdown rendering in assistant messages (code blocks, lists, etc.)

### Explicitly NOT in MVP

- Conversation history persistence (DB, saved threads)
- System prompt customization
- Multi-model switching
- File / image attachments
- Bug reporting integration (see TODO.md)
- Tool use / function calling
- Voice input

---

## 2. Backend

### Routes (under `/api/widgets/chat`)

- `POST /message` — `{ messages: { role, content }[] }` — proxies to LLM, streams response back via SSE or chunked transfer

The backend exists solely to keep the API key server-side. No DB tables needed for MVP.

### Streaming

Use Fastify's `reply.raw` (or a reply stream) to forward the LLM's streaming response directly to the client. On the frontend, consume via `EventSource` or `fetch` with `ReadableStream`.

### Configuration

```
CHAT_LLM_PROVIDER=anthropic          # 'anthropic' only for MVP
CHAT_ANTHROPIC_API_KEY=sk-ant-...
CHAT_MODEL=claude-sonnet-4-6         # model ID
CHAT_MAX_TOKENS=4096
```

---

## 3. Frontend

```
┌──────────────────────────────────────────┐
│  CHAT                          [New ✕]   │
│                                          │
│  ┌──────────────────────────────────┐   │
│  │ assistant: How can I help you?   │   │
│  └──────────────────────────────────┘   │
│  ┌──────────────────────────────────┐   │
│  │ you: explain fuzzy matching      │   │
│  └──────────────────────────────────┘   │
│  ┌──────────────────────────────────┐   │
│  │ assistant: Fuzzy matching is...  │   │
│  │ ▌ (streaming)                    │   │
│  └──────────────────────────────────┘   │
│                                          │
│  [                            ] [Send]   │
└──────────────────────────────────────────┘
```

- "New" button clears the conversation
- Auto-scroll to bottom on new messages
- Input: `<textarea>` that grows with content, submits on Shift+Enter (newline) / Enter (send)
- Assistant messages render Markdown (use a lightweight renderer like `marked` or `markdown-it`)

---

## 4. Bug Reporting Integration (future design, not MVP)

The longer-term vision: a "Report a bug" mode where the user describes an issue in the chat, and the system packages it up as a task file (see `pages/agent-dashboard/PROJECT.md` task schema) that agents can pick up and work on.

Flow:
1. User selects "Report a bug" mode (or types `/bug`)
2. The system prompt shifts to a structured bug-capture mode
3. On completion, the LLM produces a structured task description
4. Backend writes a task markdown file to `tasks/` and optionally triggers the agent fan-out workflow
5. Confirmation shown in the chat: "Task created: task-042-fix-radio-stream.md"

This depends on the Agent Dashboard / Mission Control page being built first.

---

## 5. Open Questions

- Should the widget be a fixed-size card on a page, or a larger full-width chat view at `/chat`?
- Is there a useful system prompt to set by default (e.g., "You are an assistant embedded in Steve's personal dashboard. You have context about his projects...")?
- Conversation persistence: even a simple "last N conversations" history would be useful — worth adding early rather than retrofitting.
