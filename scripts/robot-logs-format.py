#!/usr/bin/env python3
"""Pretty-print the agent-worker's pino JSON logs (PD-391).

Reads log lines on stdin and writes `HH:MM:SS LEVEL  message  key=value …`. Used by the
`robot-logs` helper in `pd-aliases.sh`; kept as a file rather than inlined in the shell function
because the quoting needed to embed this in `sh` is where these things break.

**Python, not jq, and not node.** The NAS has jq 1.5 (no `strflocaltime`, so no local-time
formatting) and no node on the host at all. python3 is present and handles both the JSON and the
clock.

**Times are printed in America/New_York unless TZ says otherwise, and that is not cosmetic.** The
NAS host clock is a fixed -05 offset with no DST, so in summer its local time is an hour behind
Steve's wall clock — reading a log line as 11:39 when the board says 12:39 is a real
misdiagnosis waiting to happen. An explicit TZ makes the two agree.
"""

import json
import os
import sys

# Before importing time-dependent formatting: default the zone, then apply it.
os.environ.setdefault("TZ", "America/New_York")
import time  # noqa: E402

if hasattr(time, "tzset"):
    time.tzset()

# pino's numeric levels.
LEVELS = {10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL"}

# Fields worth showing inline, in the order an operator scans for them. `msg` and `time` are
# rendered separately; everything else here is noise-to-signal filtered so a wide log line stays
# readable. Unknown keys are dropped rather than dumped — the raw line is one `--raw` away.
INTERESTING = (
    "ticketId",
    "runId",
    "branch",
    "prUrl",
    "verdict",
    "round",
    "tier",
    "signature",
    "reason",
    "error",
    "what",
    "url",
    "until",
    "evaluated",
)

# Keys pino always writes that carry nothing for a human reading a log tail.
SKIP = {"level", "time", "msg", "pid", "hostname", "v"}


def level_name(value):
    if isinstance(value, int):
        return LEVELS.get(value, str(value))
    return str(value).upper() if value else "?"


def clock(value):
    """pino writes epoch milliseconds."""
    try:
        return time.strftime("%H:%M:%S", time.localtime(float(value) / 1000.0))
    except (TypeError, ValueError):
        return "--:--:--"


def flatten_err(record):
    """pino serialises a thrown error under `err` — surface its message, drop the stack."""
    err = record.get("err")
    if isinstance(err, dict):
        message = err.get("message")
        if message:
            return str(message)
    return None


def extras(record):
    parts = []
    err = flatten_err(record)
    if err:
        parts.append("err=%s" % err)
    for key in INTERESTING:
        if key in record and key not in SKIP:
            value = record[key]
            if value is None or value == "":
                continue
            if isinstance(value, (dict, list)):
                continue
            parts.append("%s=%s" % (key, value))
    return parts


def render(line, want_ticket=None, raw=False):
    """One formatted line, or None when the record is filtered out.

    A line that is not JSON is passed through untouched: `docker logs` interleaves the container's
    own startup output and npm's chatter with pino's, and silently swallowing those would hide the
    very failures someone runs this to find.
    """
    stripped = line.rstrip("\n")
    if not stripped.strip():
        return None
    try:
        record = json.loads(stripped)
    except (ValueError, TypeError):
        # Not JSON. If a ticket filter is on, a line with no ticket cannot match it.
        return None if want_ticket is not None else stripped
    if not isinstance(record, dict):
        return None if want_ticket is not None else stripped

    if want_ticket is not None and record.get("ticketId") != want_ticket:
        return None
    if raw:
        return stripped

    head = "%s %-5s %s" % (clock(record.get("time")), level_name(record.get("level")), record.get("msg", ""))
    tail = extras(record)
    return "%s  %s" % (head, "  ".join(tail)) if tail else head


def main():
    want_ticket = None
    raw = False
    args = sys.argv[1:]
    while args:
        arg = args.pop(0)
        if arg == "--ticket":
            if not args:
                sys.stderr.write("robot-logs-format: --ticket needs a ticket id\n")
                return 2
            try:
                want_ticket = int(args.pop(0))
            except ValueError:
                sys.stderr.write("robot-logs-format: --ticket needs a number\n")
                return 2
        elif arg == "--raw":
            raw = True
        else:
            sys.stderr.write("robot-logs-format: unknown argument %s\n" % arg)
            return 2

    for line in sys.stdin:
        out = render(line, want_ticket, raw)
        if out is None:
            continue
        print(out)
        # `robot-logs -f` follows a live container; without this the output sits in a pipe buffer
        # and the operator watches a blank screen while things happen.
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        # `robot-logs … | head` closes the pipe. That is a normal way to stop reading, not an error.
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(130)
