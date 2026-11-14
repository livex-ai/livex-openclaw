# Source snapshots for `livex_repository_read`

The Debugger reads source through `livex_repository_read`. It reads git objects at a
pinned commit, read-only, with no network. This directory pins one commit per
repository, builds read-only snapshots from exactly those commits, installs them on
the DEV VM and mounts them at `/repos`.

| File | Purpose |
| --- | --- |
| `manifest.json` | Committed. `[{id, branch, commit}]`, one entry per line. An empty `commit` is not pinned yet. |
| `sources.example.json` | Documents where the repositories live on the operator's Mac. |
| `sources.local.json` | Your copy of the example (gitignored). Keep the one-key-per-line layout. |
| `repos.sh` | `pin`, `build` (Mac); `install`, `verify`, `rollback` (VM, root). |
| `repos_dev.sh` | What `make repos_dev` runs: build, upload, install. |
| `test_repos.py` | Tests with throwaway local git repositories. |

The pin policy is the tip of each repository's default branch at pin time: `origin/main`,
except `device-ops` (`origin/prod`).

## Flow

```sh
cp livex-native/repos/sources.example.json livex-native/repos/sources.local.json   # once; edit paths
make repos_pin                                   # fetch each default branch, write the tips
git diff livex-native/repos/manifest.json        # review
git add livex-native/repos/manifest.json && git commit && git push
make repos_dev CONFIRM=livex-openclaw-dev        # build, upload, install on the VM
make deploy_dev CONFIRM=livex-openclaw-dev       # activate: recreates the container
```

- `make repos_pin` runs `git fetch origin <branch>` in each local source checkout with
  your own git setup: your global and system git config stay in effect (so a
  `credential.helper` or `url.*.insteadOf` for private HTTPS origins works), and it never
  prompts (`GIT_TERMINAL_PROMPT=0`). Nothing stores credentials. It writes `git rev-parse origin/<branch>`
  into the manifest. It refuses if a source directory is missing or is not a git
  repository. It does not touch your working trees or branches.
- `make repos_dev_dry` runs the same checks and prints the gcloud commands without
  building or running anything. `LIVEX_TEST_IAP=0` selects direct SSH as for `deploy_dev`.
- `make repos_dev` does not restart anything. The running container keeps the `/repos`
  mount it started with (Docker re-resolves the `repos` symlink at every container start,
  including a restart or a failed-deploy rollback, never while it runs), so the
  new snapshot is used after `make deploy_dev` or
  `docker compose up -d --force-recreate gateway`.
- `deploy_dev` refuses (Gateway untouched, "run make repos_dev first") when a pinned
  commit is not readable under `$root/repos` as uid 1000. Deploy the manifest commit
  only after `repos_dev` has installed it, and push the manifest commit before
  `deploy_dev` (which requires HEAD to be on an origin branch).

## How a snapshot is made

Many local checkouts sit on feature branches with uncommitted changes. Snapshots come
only from the pinned commit object, never from a working tree:

1. a fresh `git init --template=` (no hooks, no templates, no global/system config);
2. `git fetch --depth 1 file://<source> <commit>` over the local file transport;
3. a detached checkout of that commit; `FETCH_HEAD` and reflogs are removed, so the
   operator's local paths and identity are not in the archive; no remote is configured;
4. checks: `HEAD == commit`, `git status --porcelain` empty, no remote, `fsck`;
5. `repositories-<manifestsha12>.tar.gz` with relative paths, uid/gid 1000 and sorted
   member order, plus `repositories.receipt.json` (per-repo commit, file, symlink and
   submodule counts, size, archive sha256). Output goes to `livex-native/repos/build/`
   (gitignored). Submodules are not fetched: they appear as empty directories.

The VM install (`repos.sh install`, root, under `deploy.lock`, hostname must be
`livex-openclaw-dev`) checks the archive sha256, rejects entries outside the manifest's
ids, extracts to `repos-<sha12>.new`, `chown -R 1000:1000`, verifies every repository as
uid 1000 (`HEAD`, clean status, no remote, `fsck --connectivity-only`,
`cat-file -e <commit>^{commit}`, and no extra directories), renames it to
`repos-<sha12>`, then repoints the `repos` symlink atomically.

Before extracting, install lists the archive (`tar -tvzf`) and refuses any member that is
not a regular file, a directory or a symlink, and requires free space of at least 2x the
archive's uncompressed size on `$root` (override the requirement with
`LIVEX_MIN_FREE_GIB=<n>`). Extraction uses `--no-same-owner --no-same-permissions` where
tar supports them, then `chown -R 1000:1000` and `chmod 0750` on the snapshot root. The
uploaded archive and manifest are mode 0600.

Pruning keeps the current snapshot, the previous one (`repos.previous`), the one named in
`$root/repos.mounted` and any directory whose inode equals that of `/repos` inside the
running Gateway (`docker exec <gateway> stat -c %i /repos`). The inode check is the
authority: the symlink and the record can be stale, because Docker re-resolves the symlink
at each container start (a failed-deploy rollback restarts the container on whatever
`repos` points to then). `make deploy_dev` rewrites `repos.mounted` after the new container
is up and after a successful rollback start. If the container is not running or its mount
cannot be read, install prunes nothing and says so.

Locking: `repos_dev.sh` runs install under `flock -n $root/deploy.lock` and sets
`LIVEX_REPOS_LOCKED=1` so `repos.sh` does not take the lock again (it checks that the lock
really is held and refuses otherwise). Run by hand,
`repos.sh install` and `repos.sh rollback` take `$root/deploy.lock` themselves (non-blocking:
they fail when a deploy holds it). `verify` only reads and takes no lock. It needs `git` and
`setpriv` on the VM host. If `$root/repos` is a real directory (a hand-made layout), move
it aside first; the installer refuses to replace it.

## Disk

About 2.5 GiB extracted per snapshot and about 1.5 GiB for the archive. During an install
the VM holds current + previous (+ the mounted one, if older) + the `.new` extraction + the
uploaded archive: plan for about 2.5 x 4 + 1.5 = 11.5 GiB peak. Install refuses to extract
with less than 2x the uncompressed size free.
The Mac needs the same again as scratch space while building.

## Privacy

Source from these repositories can surface in Slack answers. The tool redacts secrets
on a best-effort basis and excludes environment, key, credential and config files, but
it cannot recognize every secret committed in source. Pin only repositories the Slack
audience of the Debugger may see.

## Refresh, verify, rollback

- Refresh: run the flow again. A new manifest gives a new `repos-<sha12>`; the
  previous snapshot is kept for rollback and older ones are pruned.
- Verify the active snapshot on the VM (uses the manifest shipped in the current release):
  `sudo bash /opt/livex-openclaw-native-dev/current-release/livex-native/repos/repos.sh verify`
- Roll back to the previous snapshot (takes `deploy.lock`), then recreate the container (a deploy of the
  matching manifest, or `docker compose up -d --force-recreate gateway`):
  `sudo bash /opt/livex-openclaw-native-dev/current-release/livex-native/repos/repos.sh rollback`
  The deployed config pins the manifest's commits, so after a rollback deploy the
  manifest commit that matches that snapshot, or the tool will report unreadable commits.

## Tests

```sh
python3 -B livex-native/repos/test_repos.py
```

They use local git repositories with a feature branch and dirty files, a temporary VM
root and stubbed `chown`, `mv -T` and `gcloud`. They never touch the network or real
VM paths.
