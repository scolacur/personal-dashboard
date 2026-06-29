# Sortie + Claude Code image for the Personal Dashboard autonomous loop.
#
# Sortie ships a distroless image containing only the binary, so we layer it on
# top of a node base and add: the Claude Code CLI (the coding agent), plus `git`
# and `gh` — both REQUIRED by the workspace hooks (clone / branch / push / PR)
# and NOT present in node:slim by default.
#
# Build (on the NAS, or build elsewhere and push to a registry the NAS can pull):
#   docker build -f ops/sortie/Dockerfile -t sortie-dashboard .
#
# Pin versions for reproducibility once the pilot is green.

FROM ghcr.io/sortie-ai/sortie:latest AS sortie

FROM node:24-slim

# git + gh for the workspace hooks; ca-certificates for HTTPS git/gh.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Coding agent. Pin @latest -> a fixed version after the pilot.
RUN npm install -g @anthropic-ai/claude-code@latest

RUN useradd --create-home --uid 1000 sortie

COPY --from=sortie /usr/bin/sortie /usr/bin/sortie

USER sortie
WORKDIR /home/sortie
EXPOSE 7678

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS -o /dev/null http://localhost:7678/readyz || exit 1

# WORKFLOW.md is passed as the config argument and mounted read-only at runtime.
ENTRYPOINT ["/usr/bin/sortie", "--host", "0.0.0.0", "--log-format", "json"]
CMD ["/home/sortie/WORKFLOW.md"]
