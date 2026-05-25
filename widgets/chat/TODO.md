# TODO — Chat Widget

## Conversation Persistence

- Store conversation threads in SQLite (`chat_threads`, `chat_messages`)
- Thread list sidebar: browse and resume past conversations
- Auto-title threads from the first user message (or ask the LLM to summarize)

## Bug Reporting Mode

- `/bug` command or "Report a bug" button switches to a structured bug-capture flow
- LLM extracts: title, description, steps to reproduce, affected widget
- Backend writes a task markdown file to `tasks/` for the agent workflow to pick up
- Requires Agent Dashboard (Mission Control) to be built first

## System Prompt Customization

- Editable system prompt in widget settings
- Pre-set "personas": General Assistant, Dashboard Helper (with context about widgets), Code Reviewer

## Multi-Model Switching

- Dropdown to switch between models (Claude Sonnet, Opus, Haiku, local Ollama models)
- Model selection persisted per thread

## Local LLM Support (Ollama)

- Add `CHAT_LLM_PROVIDER=ollama` and `CHAT_OLLAMA_BASE_URL=http://localhost:11434`
- Use Ollama's OpenAI-compatible API — same streaming mechanism as Anthropic
- Model list fetched dynamically from Ollama's `/api/tags` endpoint

## File / Image Attachments

- Attach an image or file to a message
- Images: passed as base64 to vision-capable models
- Files: extract text content server-side, inject into context

## Voice Input

- Web Speech API for dictating messages (same approach as Reminders widget)

## Prompt Caching

- For conversations with a long system prompt or large context, enable Anthropic prompt caching
- Cache the system prompt turn to reduce latency and cost on longer threads
