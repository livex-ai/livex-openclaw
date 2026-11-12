# Test-VM image: the official OpenClaw image plus the Google Cloud CLI and the
# livex-native bundle. Build context is the release directory that contains
# livex-native/. Both ARGs must be reviewed name@sha256:digest references;
# remote.sh checks them (versions.env) before it runs docker build.
ARG OPENCLAW_IMAGE
ARG SDK_IMAGE
FROM ${SDK_IMAGE} AS sdk
FROM ${OPENCLAW_IMAGE}
ARG SOURCE_SHA
ARG SLACK_PLUGIN_SPEC
ARG SLACK_PLUGIN_INTEGRITY
LABEL org.opencontainers.image.revision=${SOURCE_SHA}
USER root
# python3 runs the plugin's log-paging helper. git is for livex_repository_read
# once repositories are configured (see deploy/README.md); unused while empty.
RUN apt-get update && apt-get install -y --no-install-recommends python3 git \
    && rm -rf /var/lib/apt/lists/*
# Google Cloud CLI Debian images install the full SDK at this documented path.
COPY --from=sdk /usr/lib/google-cloud-sdk /opt/google-cloud-sdk
COPY livex-native /opt/livex-native
# Bake the Slack plugin at build time. npm pack downloads the exact version; the
# build verifies the pinned dist.integrity before backporting PR #34. Apply
# installs the resulting local tarball (npm-pack:).
RUN set -eu; test -n "$SLACK_PLUGIN_SPEC" && test -n "$SLACK_PLUGIN_INTEGRITY"; \
    mkdir -p /opt/livex-plugins && cd /opt/livex-plugins \
    && npm pack "$SLACK_PLUGIN_SPEC" --silent --pack-destination /opt/livex-plugins >/dev/null \
    && test "$(ls /opt/livex-plugins | wc -l)" = 1 \
    && mv /opt/livex-plugins/*.tgz /opt/livex-plugins/slack.tgz \
    && node /opt/livex-native/deploy/verify-tarball.mjs /opt/livex-plugins/slack.tgz "$SLACK_PLUGIN_INTEGRITY" \
    && work=$(mktemp -d) \
    && tar -xzf slack.tgz -C "$work" \
    && node /opt/livex-native/deploy/patch-slack-navigation.mjs "$work/package" \
    && node --check "$work/package/dist/.setup/monitor-CNECe8FK.mjs" \
    && tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -czf slack.tgz -C "$work" package \
    && rm -rf "$work" \
    && chmod -R a+rX /opt/livex-plugins
# apply.mjs parses the JSON5 fragment with json5, a runtime dependency of
# openclaw itself (it parses openclaw.json with it); fail the build, not the
# deploy, if the base image stops providing it.
RUN chmod -R a+rX /opt/livex-native \
    && test -x /opt/google-cloud-sdk/bin/gcloud \
    && test -d /opt/google-cloud-sdk/lib/googlecloudsdk \
    && node -e 'require("node:module").createRequire("/app/package.json")("json5")' \
    && node --check /opt/livex-native/deploy/apply.mjs
ENV PATH="/opt/google-cloud-sdk/bin:${PATH}"
# The official image runs as node (uid/gid 1000).
USER 1000:1000
# Build check as the runtime user: the copied SDK must start (python3 is in place).
RUN CLOUDSDK_CONFIG=/tmp/gcloud-build-check /opt/google-cloud-sdk/bin/gcloud --version >/dev/null \
    && rm -rf /tmp/gcloud-build-check
