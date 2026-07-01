# SKILLS.md — Personal Dashboard

Custom skills for this project. Skill files live in `.claude/commands/`.

---

## Custom Skills

| Skill                   | Command                | Description                                                                                                 |
| ----------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Wrap-Up**             | `/wrap-up`             | Session wrap-up: captures memory, tidies backlog. Extends the global wrap-up.                               |
| **Project Maintenance** | `/project-maintenance` | Audits project health: skills, dead refs, orphaned files, README drift. Extends global project-maintenance. |
| **To Sortie Issues**    | `/to-sortie-issues`    | Turn a board ticket or description into atomic, Sortie-ready GitHub issues; draft → approve → create + `sortie:queued`. |

---

## When adding a new custom skill:

- Create the command file in `.claude/commands/`
- Add a row to the Custom Skills table above
