# TODO Index

- [Dashboard Shell](Shell/TODO.md)

## Pages

- [Agent Dashboard (Mission Control)](pages/agent-dashboard/TODO.md)

## Widgets

- [Music Tracker](widgets/music-tracker/TODO.md)


## Sortie Integration

**Test the egress work** Also, see if this means that the bots can't do research or read docs, and whether this is an issue. Maybe need some sort of way for it to ask permission to view a certain domain, via the ask_human command when we build that. And I can 1-time or permanently allowlist stuff. Basically re-creating the permissions check from Claude code but moving it to Discord (or wherever that communication happens) in a way that I get notified so that I don't block.

**Token exposure reduction**

**ask_human functionality**

**Discord Integration** - both for `ask_human` but also as a way for me to submit issues

**Ensure bots write tests** Most likely needs to be done via the Issue Generation Template

**Ensure bots actually use the harness** Instruct them to run the `/core-session-start` command on start and the `/wrap-up` command on end. If needed, create special variants of these skills that are meant to be used only by bots operating in a swarm. For example, the "1 memory entry per day" paradigm doesn't work great if bots are continuously merging and deploying, since only the first one of the day would get added.

**GUI for Issue Generation** Do after we have Discord set up. The process won't feel complete until I can use the dashboard's GUI itself to submit issues. Possible that the easiest thing is that writing out my issue in Github actually just sends a Discord message on my behalf, after we have discord set up. That way the Dashboard itself may not need to have any knowledge of / access to agents. It just posts a message, that message gets picked up by Sortie.


## Infra

**CI/CD Pipeline** - Don't require me to manually pull from `main` and re-create the container each time there's a code push.

**RAM & CPU Monitor / usage limits** - The NAS is not that powerful of a machine. Ensure the operation doesn't grow boundlessly and impact other processes of the machine. May need to set limits on the container or image/process itself from within Synology.

## Future Improvements

**Abstract out any infra and design decisions that can be abstracted for easy integration into future projects & websites** This includes the Sortie integration, CI/CD pipeline, model integration, Memory System

