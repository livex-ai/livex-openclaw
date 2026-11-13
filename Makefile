# Operator shortcuts. POSIX make (macOS /usr/bin/make 3.81 is enough).
#
#   make deploy_dev CONFIRM=livex-openclaw-dev
#                        deploy HEAD to the LIVE Slack-serving Gateway on the DEV VM
#   make deploy_dev_dry  same checks, then print every gcloud command and run none
#
# Optional environment (see livex-native/deploy/README.md): LIVEX_TEST_IAP=0,
# LIVEX_HEALTH_TIMEOUT=<seconds>, LIVEX_MIN_FREE_GIB=<GiB>.

DEPLOY_DIR := livex-native/deploy
DEV_VM := livex-openclaw-dev
DEV_ROOT := /opt/livex-openclaw-native-dev
DEV_PORT := 18790

.PHONY: help deploy_dev deploy_dev_dry

help:
	@echo "make deploy_dev CONFIRM=$(DEV_VM)  deploy HEAD to the LIVE Slack-serving Gateway on $(DEV_VM) ($(DEV_ROOT), port $(DEV_PORT))"
	@echo "make deploy_dev_dry  run the same checks and print the gcloud commands without running them"
	@echo "Requires a clean livex-native/ and a HEAD that is on a remote branch. See $(DEPLOY_DIR)/README.md."

deploy_dev:
	@echo "LIVE deploy of HEAD to $(DEV_VM): $(DEV_ROOT), Slack on, port $(DEV_PORT)"
	CONFIRM="$(CONFIRM)" LIVEX_DEV_LIVE=1 bash $(DEPLOY_DIR)/deploy_dev.sh

deploy_dev_dry:
	@echo "DRY RUN for the LIVE target $(DEV_VM): $(DEV_ROOT), Slack on, port $(DEV_PORT)"
	LIVEX_DEV_LIVE=1 bash $(DEPLOY_DIR)/deploy_dev.sh --dry-run
