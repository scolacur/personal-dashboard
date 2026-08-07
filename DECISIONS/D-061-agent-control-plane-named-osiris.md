# D-061: The agent control plane is named **Osiris**

**Decision:** The control plane — the Robot loop, the dispatch/queue model, the agent-state
machine, and the Dev Ops surfaces that drive them — is named **Osiris**. It is the first component
of the personal dashboard to get a proper name; "personal dashboard" remains the name of the whole
widget-hosting project, and Osiris is the system living inside it.

**Reasoning:**

- **The naming vein was already Matrix-universe**, established in the harness project: Tank (the
  dispatcher persona), The Architect (harness engineer), Oracle (the evaluation pass), Dozer, Neo.
  Sortie and Sentinel (both retired names) came from the same instinct. A name from that universe
  is consistent rather than arbitrary.
- **"Matrix" itself was the obvious candidate and is taken.** `/harness` resolves `core`, `matrix`,
  and `harness` to the same project (`Dev/core`), so `matrix` is a live alias for the harness. Using
  it for the pd control plane would collide with something in daily use.
- **The metaphor is structurally right, not decorative.** The Osiris is a Zion hovercraft: the
  vessel a crew is loaded into the Matrix *from*, monitored while inside, and extracted back to.
  That is precisely what the control plane does with a Robot — provision a worktree, dispatch,
  watch for stalls, park on `ask_human`, resume, extract at hand-off.
- **Chosen over Nebuchadnezzar on ergonomics.** Same ship class, same metaphor, but Osiris is six
  letters with one spelling. This name gets typed as a directory, a service, a log prefix, and
  spoken aloud; "Neb" was always going to be a nickname covering for a name nobody can spell.
- **The Egyptian reading is a free bonus.** Osiris is the god of death and resurrection —
  dismembered and reassembled. For a system whose core job is classifying failed runs, killing
  them, and resuming from recorded state, the resonance is apt, and it reads as a sensible system
  name to anyone who doesn't catch the Matrix reference.

**Considered and rejected:** *Matrix* (collides with the `core`/`harness` alias); *Nebuchadnezzar*
(spelling); *Zion* (real-world religious/geopolitical loading on a public repo); *Construct*
("construct" is a generic programming noun — ambiguous in code and conversation); *Mission Control*
(~32 stale references in-repo from the pre-rename board era, D-026 — reviving a name already
migrated away from); *Dispatch* (already the domain verb, ~219 uses — don't make it a proper noun
too).

**Known minor conflicts, accepted:** an obscure banking trojan (a Kronos variant) carries the name;
obscure enough not to shadow the project. The Osiris is also destroyed with all hands in the
source material — as is the Nebuchadnezzar, so there was no safe pick in that universe.

**Scope note:** this names the system, not the resume. Public-facing descriptions of the project
stay descriptive ("self-hosted agent platform / ticket-to-PR coding automation") because a codename
carries no information for a reader who doesn't know the project.

**Revisit if:** the control plane is ever extracted from personal-dashboard into its own repo, at
which point the name should become the repo name rather than an internal label.
