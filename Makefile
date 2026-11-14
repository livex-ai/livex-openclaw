# Operator shortcuts. POSIX make (macOS /usr/bin/make 3.81 is enough).
#
#   make deploy_dev CONFIRM=livex-openclaw-dev
#                        deploy HEAD to the LIVE Slack-serving Gateway on the DEV VM
#   make deploy_dev_dry  same checks, then print every gcloud command and run none
#
#   make repos_pin       fetch each source repo's default branch and write its tip into
#                        livex-native/repos/manifest.json (then review and commit it)
#   make repos_dev CONFIRM=livex-openclaw-dev
#                        build the pinned source snapshots, upload and install them on the DEV VM
#                        (does not restart the Gateway; run make deploy_dev afterwards)
#   make repos_dev_dry   same checks, then print every gcloud command and run none
#
# Optional environment (see livex-native/deploy/README.md): LIVEX_TEST_IAP=0,
# LIVEX_HEALTH_TIMEOUT=<seconds>, LIVEX_MIN_FREE_GIB=<GiB>.

DEPLOY_DIR := livex-native/deploy
DEV_VM := livex-openclaw-dev
DEV_ROOT := /opt/livex-openclaw-native-dev
DEV_PORT := 18790
# The OnCall agent lives in a separate PR; the live Gateway serves it, and a deploy of
# this branch must leave it untouched. Set LIVEX_UNMANAGED_AGENTS= (empty) for strict mode.
LIVEX_UNMANAGED_AGENTS ?= oncall

REPOS_DIR := livex-native/repos

.PHONY: help deploy_dev deploy_dev_dry repos_pin repos_dev repos_dev_dry

help:
	@echo "make deploy_dev CONFIRM=$(DEV_VM)  deploy HEAD to the LIVE Slack-serving Gateway on $(DEV_VM) ($(DEV_ROOT), port $(DEV_PORT))"
	@echo "make deploy_dev_dry  run the same checks and print the gcloud commands without running them"
	@echo "make repos_pin  pin source snapshots; make repos_dev CONFIRM=$(DEV_VM) install them (see $(REPOS_DIR)/README.md)"
	@echo "Requires a clean livex-native/ and a HEAD that is on a remote branch. See $(DEPLOY_DIR)/README.md."

deploy_dev:
	@echo "LIVE deploy of HEAD to $(DEV_VM): $(DEV_ROOT), Slack on, port $(DEV_PORT)"
	CONFIRM="$(CONFIRM)" LIVEX_UNMANAGED_AGENTS="$(LIVEX_UNMANAGED_AGENTS)" LIVEX_DEV_LIVE=1 bash $(DEPLOY_DIR)/deploy_dev.sh

deploy_dev_dry:
	@echo "DRY RUN for the LIVE target $(DEV_VM): $(DEV_ROOT), Slack on, port $(DEV_PORT)"
	LIVEX_UNMANAGED_AGENTS="$(LIVEX_UNMANAGED_AGENTS)" LIVEX_DEV_LIVE=1 bash $(DEPLOY_DIR)/deploy_dev.sh --dry-run

repos_pin:
	bash $(REPOS_DIR)/repos.sh pin

repos_dev:
	@echo "Install pinned source snapshots on $(DEV_VM): $(DEV_ROOT)/repos (the Gateway is not restarted)"
	CONFIRM="$(CONFIRM)" bash $(REPOS_DIR)/repos_dev.sh

repos_dev_dry:
	@echo "DRY RUN for source snapshots on $(DEV_VM): $(DEV_ROOT)/repos"
	bash $(REPOS_DIR)/repos_dev.sh --dry-run
