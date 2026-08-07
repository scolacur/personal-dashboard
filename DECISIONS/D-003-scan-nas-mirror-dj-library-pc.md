# D-003: Scan the NAS mirror of the DJ library, not the PC directly

**Decision:** rsync pushes from PC → NAS on a schedule (configured separately on the NAS). The app reads only the NAS copy.

**Reasoning:**

- The app already runs on the NAS — local filesystem reads are fast, no SMB auth in the container.
- No dependency on the PC being on when the app wants to scan.
- A stale mirror is acceptable: worst case is a false "not in library," which becomes a manual review.
- Reaching back from a Docker container on the NAS to the PC is fragile (SMB mount in container, credentials, network changes).

**Revisit if:** The lag between adding a track on the PC and the app seeing it becomes annoying. The fix is to tighten the rsync interval, not to change this decision.
