Mission Control Builder

I want to build my own Mission Control dashboard for my multi-agent setup — a single web interface that lets me see and control everything my agents are doing. Help me create a project brief.

I'm going to paste reference screenshots showing the visual style I'm inspired by. Look at them carefully — the brief you write should reference what you actually see (colors, layout, type treatment, agent character design, status indicator patterns) rather than my secondhand description of them.

Ask me 5 questions, ONE AT A TIME, and wait for my answer before asking the next. After my answers, generate a project brief I'll paste to my Claude Code.

The Mission Control is a Svelte app running locally on a Mac Mini M4 Pro, accessible from any personal device via Tailscale. To start, it can include these 7 screens:

1. **Tasks** — Task board for me and my agent. Agent picks up assigned tasks on every heartbeat. I see backlog / in-progress / done so I always know what my agent is actually doing.

2. **Calendar** — Every cron job and scheduled task the agent has set up. Proves proactivity, catches the cases where it said it scheduled something but didn't.

3. **Projects** — Every project I'm working on, with progress. Hooks tasks, memories, and docs to each project so I can ask "what moves Project X forward today?"

4. **Memory** — Journal-style view of daily memory files plus long-term memory. Searchable.

5. **Docs** — Every doc the agent has written (newsletters, content, briefs), indexed and searchable.

6. **Team** — Agents, subagents, roles, org structure, mission statement.

7. **Visual Office** — 2D pixel-art office showing agents at their desks when working, away when idle.

The 5 questions to ask me:

1. **Which screens matter most to me right now?** Pick top 3-5 to build first.

2. **What does my agent crew look like?** How many agents, names, roles, and is there a "chief of staff" routing work?

3. **What's my mission statement?** One or two sentences on what the whole system is FOR. If I'm not sure, ask me 3 follow-ups and synthesize one.

4. **Visual style — match the inspiration screenshots or go custom?**
   - Match the screenshots I pasted (you should describe back what you actually see in them so I can confirm)
   - Match the vibe but with my own color palette / motif (specify)
   - Different style entirely (Linear / Notion / brutalist / glassmorphism / specify)

5. **Which integrations do I need on day one?** Discord webhook, Obsidian sync, Google Calendar, GitHub, file system watcher for docs, or none — keep it self-contained.

After my answers, write a project brief for the agent. Treat it as a brief for a smart collaborator, not a spec for a junior dev. Format:

- **Project name** (short, evocative)
- **What we're building** (3-5 sentences on the intent — what this is for and what it should feel like to use)
- **Why it matters** (1-2 sentences on the human problem — so the agent has context for tradeoffs)
- **Screens to build first** (the ones I picked, with one sentence per screen on what each should accomplish — NOT a feature list)
- **Agent crew + mission statement** (from my Q2 and Q3 answers)
- **Visual direction** (from Q4 — describe the vibe and key reference details from the actual screenshots, leave the rest open to the agent's design judgment)
- **Integrations** (from Q5)
- **Use REAL data from day one** — explicitly tell the agent: do not build with mock data. The dashboard should pull from the actual workspace files (~/workspace/, memory/YYYY-MM-DD.md daily logs, MEMORY.md, USER.md, AGENTS.md, the json config for cron jobs, the agent's actual task and doc files). The whole point of Mission Control is that it reflects the live state of the agent. Mock data defeats the purpose. Discover what data exists in the workspace first, then build the screens around what's actually there.
- **Tech stack** — Svelte.js / SCSS / Node as the base; runs on localhost; SQLite or PostgreSQL; reads/writes to the workspace
- **What I'm NOT going to specify** — One short paragraph telling the agent that the data model, component structure, exact visual treatment, file organization, and screen layouts are its call. It should make smart decisions and ask me about anything genuinely ambiguous.
- **Process I want** — 1. First, explore the workspace and tell me what real data is available for each screen I picked. 2. Ask any clarifying questions. 3. Propose a phased build plan and wait for approval. 4. Build phase 1 wired to real data. 5. Show me, get feedback, iterate. 6. Move to phase 2.
