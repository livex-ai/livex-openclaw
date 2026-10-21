# Release builds require reviewed name@sha256:digest references for both images.
# A local build check may supply FORK_IMAGE as a same-graph Bake target context.
# SDK_IMAGE remains digest pinned. See README.md.
ARG SDK_IMAGE
ARG FORK_IMAGE
FROM ${SDK_IMAGE} AS sdk
FROM ${FORK_IMAGE}
ARG SOURCE_SHA
LABEL org.opencontainers.image.revision=${SOURCE_SHA}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 git lsof \
    && rm -rf /var/lib/apt/lists/*
# Google Cloud CLI Debian images install the full SDK at this documented path.
COPY --from=sdk /usr/lib/google-cloud-sdk /opt/google-cloud-sdk
COPY oncall/plugins/livex-gcp-readonly /opt/oncall/plugins/livex-gcp-readonly
COPY oncall/workspace/AGENTS.md /opt/oncall/workspace/AGENTS.md
COPY oncall/prompts /opt/oncall/prompts
COPY oncall/scripts/local-gcloud-startup/preflight.mjs /opt/oncall/preflight.mjs
COPY agent-skills /opt/agent-skills
COPY deploy/gcp-vm/start.sh /opt/oncall/start.sh
RUN python3 /opt/agent-skills/scripts/library.py validate \
    && python3 /opt/agent-skills/scripts/library.py export --profile oncall --target /opt/oncall-skills \
    && rm -rf /opt/agent-skills \
    && test -x /opt/google-cloud-sdk/bin/gcloud \
    && test -d /opt/google-cloud-sdk/lib/googlecloudsdk \
    && install -d -m 0700 -o 1000 -g 1000 /home/node/.config/gcloud \
    && chmod -R a+rX /opt/oncall /opt/oncall-skills \
    && cd /opt/oncall-skills \
    && find . -type f -exec sha256sum {} + > /opt/skills.sha256 \
    && sort -o /opt/skills.sha256 /opt/skills.sha256 \
    && chmod a+r /opt/skills.sha256
ENV PATH="/opt/google-cloud-sdk/bin:${PATH}"
USER 1000:1000
