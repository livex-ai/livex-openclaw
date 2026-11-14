#!/usr/bin/env bash
# Source snapshots for livex_repository_read. See livex-native/repos/README.md.
#
#   repos.sh pin       (operator Mac) fetch each default branch and write its tip into manifest.json
#   repos.sh build     (operator Mac) build repositories-<manifestsha12>.tar.gz from the pinned commits
#   repos.sh install ARCHIVE SHA256 MANIFEST   (VM, root, under deploy.lock) verify, extract, switch /repos
#   repos.sh verify    (VM, root) re-verify the active snapshot against manifest.json
#   repos.sh rollback  (VM, root) point `repos` back at the previous snapshot
#
# Compatible with bash 3.2 (macOS /bin/bash). Snapshots come only from the pinned
# commit objects, never from a working tree.
#
# Test knobs (defaults are the real values): LIVEX_REPOS_MANIFEST, LIVEX_REPOS_SOURCES,
# LIVEX_REPOS_BASE, LIVEX_REPOS_OUT, LIVEX_REPOS_SCRATCH, LIVEX_ROOT (a root other than
# the real live root skips the hostname and root-user checks), LIVEX_MIN_FREE_GIB (install:
# require this much free space instead of 2x the archive's uncompressed size),
# LIVEX_REPOS_LOCKED=1 (set by repos_dev.sh, which already holds $root/deploy.lock).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)
manifest=${LIVEX_REPOS_MANIFEST:-$here/manifest.json}
sources=${LIVEX_REPOS_SOURCES:-$here/sources.local.json}
out_dir=${LIVEX_REPOS_OUT:-$here/build}
live_root=/opt/livex-openclaw-native-dev
live_host=livex-openclaw-dev
node_uid=1000
node_gid=1000

die() {
  echo "repos: $*" >&2
  exit 1
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f1
  else
    die "need shasum or sha256sum"
  fi
}

# ---- manifest: one canonical entry per line, parsed with sed (no jq/python) ----
row_re='^ *\{"id": "([A-Za-z0-9][A-Za-z0-9_-]{0,79})", "branch": "([A-Za-z0-9._/-]+)", "commit": "([0-9a-f]{40})?"\},?$'
m_id=()
m_branch=()
m_commit=()

load_manifest() {
  [[ -f $1 ]] || die "manifest not found: $1"
  local total rows id branch commit
  total=$(grep -c '"id"' "$1" || true)
  rows=$(sed -n -E "s|$row_re|\\1 \\2 \\3|p" "$1")
  m_id=()
  m_branch=()
  m_commit=()
  if [[ -n $rows ]]; then
    while read -r id branch commit; do
      m_id+=("$id")
      m_branch+=("$branch")
      m_commit+=("${commit:-}")
    done <<<"$rows"
  fi
  [[ ${#m_id[@]} -eq $total ]] \
    || die "$1 is not in the canonical form (one {\"id\": ..., \"branch\": ..., \"commit\": ...} entry per line)"
  [[ ${#m_id[@]} -le 64 ]] || die "$1 lists more than 64 repositories"
  local i j
  for ((i = 0; i < ${#m_id[@]}; i++)); do
    for ((j = i + 1; j < ${#m_id[@]}; j++)); do
      [[ ${m_id[i]} != "${m_id[j]}" ]] || die "$1 lists ${m_id[i]} twice"
    done
  done
}

manifest_sha12() {
  sha256_of "$1" | cut -c1-12
}

write_manifest() { # $1=file; entries from m_id/m_branch/m_commit
  local i last=$((${#m_id[@]} - 1)) tmp="$1.tmp.$$"
  {
    echo "["
    for ((i = 0; i <= last; i++)); do
      printf '  {"id": "%s", "branch": "%s", "commit": "%s"}' "${m_id[i]}" "${m_branch[i]}" "${m_commit[i]}"
      if ((i < last)); then echo ","; else echo; fi
    done
    echo "]"
  } >"$tmp"
  mv "$tmp" "$1"
}

pinned_count() {
  local i n=0
  for ((i = 0; i < ${#m_id[@]}; i++)); do
    [[ -z ${m_commit[i]} ]] || n=$((n + 1))
  done
  echo "$n"
}

# Quiet, config-isolated git for local reads and the throwaway snapshots. Not for network
# fetches from the operator's origins (see cmd_pin), which need their credential helper.
gitq() {
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
    git -c core.logAllRefUpdates=false -c protocol.file.allow=always "$@"
}

# ---- operator-local source paths ----
source_dir() { # $1=id
  local id=$1 dir="" base=""
  if [[ -f $sources ]]; then
    dir=$(sed -n -E "s/^ *\"$id\" *: *\"([^\"]*)\" *,? *$/\\1/p" "$sources" | head -n1)
    base=$(sed -n -E 's/^ *"base" *: *"([^"]*)" *,? *$/\1/p' "$sources" | head -n1)
  fi
  if [[ -z $dir ]]; then
    base=${LIVEX_REPOS_BASE:-${base:-$HOME/dev}}
    dir=$base/$id
  fi
  [[ $dir == /* ]] || die "source path for $id is not absolute: $dir"
  case $dir in *[\"\\%?#]*) die "source path for $id contains an unsupported character (quote, backslash, % ? #): $dir" ;; esac
  printf '%s\n' "$dir"
}

require_source() { # $1=id -> prints dir
  local dir
  dir=$(source_dir "$1")
  [[ -d $dir ]] || die "source for $1 is missing: $dir (see sources.example.json)"
  gitq -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || die "source for $1 is not a git repository: $dir"
  printf '%s\n' "$dir"
}

# ---- pin ----
cmd_pin() {
  load_manifest "$manifest"
  local i dir commit before
  ((${#m_id[@]} > 0)) || die "manifest lists no repositories"
  for ((i = 0; i < ${#m_id[@]}; i++)); do require_source "${m_id[i]}" >/dev/null; done
  local new=()
  for ((i = 0; i < ${#m_id[@]}; i++)); do
    dir=$(require_source "${m_id[i]}")
    # Plain git, not gitq: the operator's HTTPS origins rely on credential.helper from the
    # global (or system) config. Never prompt.
    GIT_TERMINAL_PROMPT=0 git -C "$dir" fetch --quiet origin "+refs/heads/${m_branch[i]}:refs/remotes/origin/${m_branch[i]}" \
      || die "fetch of origin ${m_branch[i]} failed for ${m_id[i]} ($dir)"
    commit=$(gitq -C "$dir" rev-parse --verify "refs/remotes/origin/${m_branch[i]}^{commit}") \
      || die "origin/${m_branch[i]} not found for ${m_id[i]}"
    [[ $commit =~ ^[0-9a-f]{40}$ ]] || die "unexpected commit '$commit' for ${m_id[i]}"
    new+=("$commit")
  done
  printf '%-28s %-8s %-40s %s\n' ID BRANCH COMMIT STATUS
  for ((i = 0; i < ${#m_id[@]}; i++)); do
    before=${m_commit[i]}
    if [[ -z $before ]]; then status=new; elif [[ $before == "${new[i]}" ]]; then status=same; else status=changed; fi
    printf '%-28s %-8s %-40s %s\n' "${m_id[i]}" "${m_branch[i]}" "${new[i]}" "$status"
    m_commit[i]=${new[i]}
  done
  write_manifest "$manifest"
  echo "repos: wrote $manifest ($(manifest_sha12 "$manifest")). Review and commit it, then: make repos_dev CONFIRM=livex-openclaw-dev"
}

# ---- build ----
count_lines() { wc -l | tr -d ' '; }

cmd_build() {
  load_manifest "$manifest"
  local pinned i
  pinned=$(pinned_count)
  ((pinned > 0)) || die "no pinned commits in $manifest; run: make repos_pin"
  for ((i = 0; i < ${#m_id[@]}; i++)); do
    if [[ -z ${m_commit[i]} ]]; then
      echo "repos: warning: ${m_id[i]} has no pinned commit and is left out" >&2
    else
      require_source "${m_id[i]}" >/dev/null
    fi
  done
  umask 022
  local sha12 scratch stage dir id commit
  sha12=$(manifest_sha12 "$manifest")
  scratch=$(mktemp -d "${LIVEX_REPOS_SCRATCH:-${TMPDIR:-/tmp}}/livex-repos.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$scratch'" EXIT
  stage=$scratch/stage
  mkdir "$stage"
  local ids=()
  for ((i = 0; i < ${#m_id[@]}; i++)); do
    id=${m_id[i]}
    commit=${m_commit[i]}
    [[ -n $commit ]] || continue
    dir=$(require_source "$id")
    echo "== $id @ ${commit:0:12}"
    gitq init --quiet --template= "$stage/$id"
    gitq -C "$stage/$id" fetch --quiet --depth 1 "file://$dir" "$commit" \
      || die "commit $commit is not available in $dir (fetch origin there, or re-run: make repos_pin)"
    gitq -C "$stage/$id" -c advice.detachedHead=false checkout --quiet --detach "$commit"
    rm -f "$stage/$id/.git/FETCH_HEAD" # names the operator's local source path
    rm -rf "$stage/$id/.git/logs"
    [[ $(gitq -C "$stage/$id" rev-parse HEAD) == "$commit" ]] || die "$id: checkout is not at $commit"
    [[ -z $(gitq -C "$stage/$id" status --porcelain) ]] \
      || die "$id: snapshot is not clean after checkout (case-colliding paths or attributes?)"
    [[ -z $(gitq -C "$stage/$id" remote) ]] || die "$id: snapshot has a remote"
    gitq -C "$stage/$id" fsck --connectivity-only --no-dangling >/dev/null 2>&1 || die "$id: fsck failed"
    ids+=("$id")
  done

  local sorted
  sorted=$(printf '%s\n' "${ids[@]}" | LC_ALL=C sort)
  (cd "$stage" && printf '%s\n' "$sorted" | while read -r id; do LC_ALL=C find "$id" -print; done | LC_ALL=C sort >"$scratch/list")
  local own=()
  if tar --version 2>&1 | grep -qi bsdtar; then
    own=(--uid "$node_uid" --gid "$node_gid" --uname "" --gname "" --no-xattrs)
  else
    own=(--owner="$node_uid" --group="$node_gid" --numeric-owner)
  fi
  mkdir -p "$out_dir"
  local archive="$out_dir/repositories-$sha12.tar.gz"
  echo "== archive $archive"
  (cd "$stage" && COPYFILE_DISABLE=1 tar --no-recursion -T "$scratch/list" "${own[@]}" -cf -) | gzip -n >"$archive.tmp"
  mv "$archive.tmp" "$archive"
  local asha abytes
  asha=$(sha256_of "$archive")
  abytes=$(wc -c <"$archive" | tr -d ' ')

  local receipt="$out_dir/repositories.receipt.json" first=1 files links subs kib
  {
    echo "{"
    printf '  "manifestSha256": "%s",\n' "$(sha256_of "$manifest")"
    printf '  "manifestSha12": "%s",\n' "$sha12"
    printf '  "archive": "repositories-%s.tar.gz",\n' "$sha12"
    printf '  "archiveSha256": "%s",\n' "$asha"
    printf '  "archiveBytes": %s,\n' "$abytes"
    echo '  "repos": ['
    for ((i = 0; i < ${#m_id[@]}; i++)); do
      [[ -n ${m_commit[i]} ]] || continue
      id=${m_id[i]}
      files=$(gitq -C "$stage/$id" ls-files | count_lines)
      links=$(gitq -C "$stage/$id" ls-files -s | awk '$1 == "120000"' | count_lines)
      subs=$(gitq -C "$stage/$id" ls-files -s | awk '$1 == "160000"' | count_lines)
      kib=$(du -sk "$stage/$id" | cut -f1)
      if ((first)); then first=0; else echo ","; fi
      printf '    {"id": "%s", "branch": "%s", "commit": "%s", "files": %s, "symlinks": %s, "submodules": %s, "sizeKiB": %s}' \
        "$id" "${m_branch[i]}" "${m_commit[i]}" "$files" "$links" "$subs" "$kib"
    done
    echo
    echo "  ]"
    echo "}"
  } >"$receipt.tmp"
  mv "$receipt.tmp" "$receipt"
  echo "repos: built $archive ($((abytes / 1024 / 1024)) MiB, sha256 $asha)"
  echo "repos: receipt $receipt"
}

# ---- VM side: install / verify / rollback ----
resolve_root() {
  root=${LIVEX_ROOT:-$live_root}
  test_root=0
  if [[ $root != "$live_root" ]]; then
    test_root=1
    case $root in
      /opt/livex-openclaw-stage | /opt/livex-openclaw-test | /opt/livex-openclaw-dev | /opt/livex-openclaw)
        die "refusing $root" ;;
    esac
  fi
  if ((!test_root)); then
    [[ $(hostname) == "$live_host" ]] || die "refusing: host is '$(hostname)', expected $live_host"
    [[ $(id -u) == 0 ]] || die "run as root (sudo)"
  fi
  [[ -d $root ]] || die "$root does not exist"
}

# Run a command as the runtime user (uid 1000), as the repository tool does.
as_node() {
  if [[ $(id -u) != 0 ]]; then
    "$@" # only reachable under a test root: the files belong to the caller
  elif command -v setpriv >/dev/null 2>&1; then
    setpriv --reuid="$node_uid" --regid="$node_gid" --clear-groups "$@"
  else
    die "setpriv (util-linux) is required to verify as uid $node_uid"
  fi
}

node_git() { # $1=dir, rest = git args; sanitized like the tool's git
  local dir=$1
  shift
  as_node env -i "PATH=$PATH" HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 git -C "$dir" "$@"
}

# verify_tree DIR: every pinned manifest entry is present and exact; nothing else.
verify_tree() {
  local dir=$1 i id commit d listed expected
  command -v git >/dev/null 2>&1 || die "git is required on this host (sudo apt-get install -y git)"
  expected=""
  for ((i = 0; i < ${#m_id[@]}; i++)); do
    [[ -n ${m_commit[i]} ]] && expected="$expected${m_id[i]}"$'\n'
  done
  listed=$(ls -A "$dir" | LC_ALL=C sort)
  expected=$(printf '%s' "$expected" | LC_ALL=C sort)
  [[ $listed == "$expected" ]] || die "$dir does not hold exactly the pinned repositories"
  for ((i = 0; i < ${#m_id[@]}; i++)); do
    id=${m_id[i]}
    commit=${m_commit[i]}
    [[ -n $commit ]] || continue
    d=$dir/$id
    [[ -d $d/.git && ! -L $d ]] || die "$id: not a git checkout in $dir"
    [[ $(node_git "$d" rev-parse HEAD) == "$commit" ]] || die "$id: HEAD is not $commit"
    [[ -z $(node_git "$d" status --porcelain) ]] || die "$id: working tree is not clean"
    [[ -z $(node_git "$d" remote) ]] || die "$id: has a remote"
    node_git "$d" fsck --connectivity-only --no-dangling >/dev/null 2>&1 || die "$id: fsck --connectivity-only failed"
    node_git "$d" cat-file -e "$commit^{commit}" || die "$id: $commit is not readable as uid $node_uid"
  done
}

switch_link() { # $1=target dir, $2=link path (atomic replace)
  ln -sfn "$1" "$2.tmp.$$" && mv -T "$2.tmp.$$" "$2" || {
    rm -f "$2.tmp.$$"
    die "could not repoint $2"
  }
}

write_previous() { # $1=target
  printf '%s\n' "$1" >"$root/repos.previous.tmp.$$" && mv "$root/repos.previous.tmp.$$" "$root/repos.previous"
}

# Take deploy.lock unless the caller (repos_dev.sh) already holds it.
take_deploy_lock() {
  if [[ ${LIVEX_REPOS_LOCKED:-} == 1 ]]; then
    # Trust the marker only if the lock really is held by someone else.
    if flock -n "$root/deploy.lock" true; then
      die "LIVEX_REPOS_LOCKED=1 but $root/deploy.lock is not held"
    fi
    return 0
  fi
  command -v flock >/dev/null 2>&1 || die "flock (util-linux) is required to take $root/deploy.lock"
  exec 9>"$root/deploy.lock" || die "cannot open $root/deploy.lock"
  flock -n 9 || die "a deploy or another repos change holds $root/deploy.lock; retry when it finishes"
}

# tar flags that keep extracted files from taking the archive's owner or modes (GNU tar on
# the VM; bsdtar on a Mac test run). Probed, because the option sets differ.
extract_flags=()
detect_extract_flags() {
  extract_flags=()
  local f
  for f in --no-same-owner --no-same-permissions; do
    if tar "$f" -cf /dev/null --files-from /dev/null >/dev/null 2>&1; then extract_flags+=("$f"); fi
  done
}

# Archive listing checks (one `tar -tvzf` pass): only regular files, directories and
# symlinks; prints the total uncompressed size in bytes of the regular files.
archive_size_checked() { # $1=archive
  local listing bad total
  listing=$(tar -tvzf "$1") || die "cannot list $1"
  bad=$(printf '%s\n' "$listing" | awk '{ t = substr($0, 1, 1); if (t != "-" && t != "d" && t != "l") { print $0; exit } }')
  [[ -z $bad ]] || die "archive holds a member that is not a regular file, directory or symlink ($bad); nothing extracted"
  # GNU: "-rw-r--r-- uid/gid SIZE date time name"; bsdtar: "-rw-r--r-- 0 uid gid SIZE date ...".
  total=$(printf '%s\n' "$listing" | awk '$1 ~ /^-/ { n += ($2 ~ /\//) ? $3 : $5 } END { printf "%.0f", n }')
  if [[ ! $total =~ ^[0-9]+$ ]] || ((total == 0)); then
    total=$(gzip -l "$1" 2>/dev/null | awk 'NR == 2 { print $2 }')
  fi
  [[ $total =~ ^[0-9]+$ ]] || total=0
  ((total > 0)) || die "cannot determine the uncompressed size of $1; nothing extracted"
  printf '%s\n' "$total"
}

inode_of() { # $1=path; GNU stat, then BSD stat
  stat -c %i "$1" 2>/dev/null || stat -f %i "$1" 2>/dev/null
}

# Inode of the directory the live Gateway has mounted at /repos (read inside the running
# container: Docker re-resolves the `repos` symlink at every container start, so the
# symlink and repos.mounted can both be stale). Prints nothing when it cannot be read.
mounted_inode() {
  local out
  out=$(docker exec "${LIVEX_GATEWAY_CONTAINER:-livex-openclaw-native-dev-gateway-1}" stat -c %i /repos 2>/dev/null) || return 0
  [[ $out =~ ^[0-9]+$ ]] && printf '%s\n' "$out"
  return 0
}

install_new=""
cmd_install() {
  [[ $# -eq 3 ]] || die "usage: repos.sh install ARCHIVE SHA256 MANIFEST"
  local archive=$1 want=$2 mf=$3
  [[ $want =~ ^[0-9a-f]{64}$ ]] || die "SHA256 must be 64 hex characters"
  [[ -f $archive && -f $mf ]] || die "archive or manifest not found"
  resolve_root
  load_manifest "$mf"
  ((10#$(pinned_count) > 0)) || die "manifest has no pinned commits"
  take_deploy_lock
  umask 022
  local sha12 dest new have base old i
  sha12=$(manifest_sha12 "$mf")
  base=$(basename "$archive")
  if [[ $base =~ ^repositories-([0-9a-f]{12})\.tar\.gz$ && ${BASH_REMATCH[1]} != "$sha12" ]]; then
    die "$base was built from a different manifest than $mf ($sha12)"
  fi
  have=$(sha256_of "$archive")
  [[ $have == "$want" ]] || die "archive sha256 mismatch (have $have, expected $want); nothing extracted"
  if [[ -e $root/repos || -L $root/repos ]] && [[ ! -L $root/repos ]]; then
    die "$root/repos is a real directory; move it aside (sudo mv $root/repos $root/repos.old) and retry"
  fi
  dest=$root/repos-$sha12
  new=$dest.new
  local ids=""
  for ((i = 0; i < ${#m_id[@]}; i++)); do
    [[ -z ${m_commit[i]} ]] || ids="$ids ${m_id[i]}"
  done
  # Only <id>/... entries, no absolute or parent paths.
  tar -tzf "$archive" | awk -v ids="$ids" 'BEGIN { n = split(ids, a, " "); for (i = 1; i <= n; i++) ok[a[i]] = 1 }
    { top = $0; sub(/\/.*/, "", top); sub(/\/$/, "", top)
      if (!(top in ok) || $0 ~ /^\// || $0 ~ /(^|\/)\.\.(\/|$)/) { print $0; bad = 1; exit 1 } }' >/dev/null \
    || die "archive holds entries outside the manifest's repositories; nothing extracted"

  local usize
  usize=$(archive_size_checked "$archive")

  if [[ -d $dest ]]; then
    echo "repos: $dest already exists; re-verifying it"
    verify_tree "$dest"
  else
    # Free space: at least 2x the uncompressed size, or LIVEX_MIN_FREE_GIB if set.
    local need free_kib
    if [[ -n ${LIVEX_MIN_FREE_GIB:-} ]]; then
      [[ $LIVEX_MIN_FREE_GIB =~ ^[0-9]+$ ]] || die "LIVEX_MIN_FREE_GIB must be a whole number"
      need=$((LIVEX_MIN_FREE_GIB * 1024 * 1024 * 1024))
    else
      need=$((usize * 2))
    fi
    free_kib=$(df -Pk "$root" | awk 'NR == 2 { print $4 }')
    [[ $free_kib =~ ^[0-9]+$ ]] || die "cannot read the free space of $root"
    ((free_kib * 1024 >= need)) \
      || die "not enough free space on $root: $((free_kib / 1024)) MiB free, $((need / 1024 / 1024)) MiB required; nothing extracted"
    detect_extract_flags
    rm -rf "$new"
    mkdir "$new"
    install_new=$new
    trap 'rm -rf "$install_new"' EXIT # a failed extraction or verification leaves nothing behind
    tar ${extract_flags[@]+"${extract_flags[@]}"} -xzf "$archive" -C "$new"
    chown -R "$node_uid:$node_gid" "$new"
    chmod 0750 "$new"
    verify_tree "$new"
    mv "$new" "$dest"
    trap - EXIT
  fi
  old=$(readlink "$root/repos" 2>/dev/null || true)
  if [[ $old != "$dest" ]]; then
    switch_link "$dest" "$root/repos"
    if [[ $old =~ ^$root/repos-[0-9a-f]{12}$ ]]; then write_previous "$old"; fi
  fi
  # Keep the current and previous snapshots and whatever the running container has
  # mounted; drop older ones and leftovers. The mounted directory is identified by the
  # inode of /repos inside the running container. If that cannot be read (container
  # stopped, no docker), nothing is pruned. $root/repos.mounted (written by the deploy)
  # is an extra keep on top of the inode check.
  local prev="" rec="" live_inode="" d
  [[ -s $root/repos.previous ]] && prev=$(<"$root/repos.previous")
  [[ -s $root/repos.mounted ]] && rec=$(<"$root/repos.mounted")
  live_inode=$(mounted_inode)
  if [[ -n $live_inode ]]; then
    for d in "$root"/repos-*; do
      [[ -e $d ]] || continue
      [[ $d =~ ^"$root"/repos-([0-9a-f]{12})(\.new)?$ ]] || continue
      [[ $d == "$dest" || $d == "$prev" || $d == "$rec" ]] && continue
      [[ $(inode_of "$d") == "$live_inode" ]] && continue
      rm -rf "$d"
    done
  else
    echo "repos: cannot read the running Gateway's /repos mount (container not running?); keeping every snapshot"
  fi
  echo "repos: installed $dest (previous: ${prev:-none}); $root/repos -> $(readlink "$root/repos")"
  echo "repos: the running Gateway keeps its old /repos mount until the container is recreated: run make deploy_dev"
}

cmd_verify() {
  resolve_root
  load_manifest "$manifest"
  ((10#$(pinned_count) > 0)) || die "manifest has no pinned commits"
  [[ -L $root/repos ]] || die "$root/repos is not a symlink to a snapshot"
  local target
  target=$(cd "$root/repos" && pwd -P) || die "$root/repos does not resolve"
  verify_tree "$target"
  echo "repos: OK $target ($(pinned_count) repositories match the manifest)"
}

cmd_rollback() {
  resolve_root
  take_deploy_lock
  local prev cur
  [[ -s $root/repos.previous ]] || die "no previous snapshot recorded"
  prev=$(<"$root/repos.previous")
  [[ $prev =~ ^$root/repos-[0-9a-f]{12}$ && -d $prev ]] || die "previous snapshot $prev is missing"
  [[ -n $(ls -A "$prev") ]] || die "$prev is empty"
  cur=$(readlink "$root/repos" 2>/dev/null || true)
  switch_link "$prev" "$root/repos"
  if [[ $cur =~ ^$root/repos-[0-9a-f]{12}$ ]]; then write_previous "$cur"; fi
  echo "repos: $root/repos -> $prev. Recreate the Gateway to use it: make deploy_dev (or docker compose up -d --force-recreate)"
}

case ${1:-} in
  pin) shift; [[ $# -eq 0 ]] || die "usage: repos.sh pin"; cmd_pin ;;
  build) shift; [[ $# -eq 0 ]] || die "usage: repos.sh build"; cmd_build ;;
  install) shift; cmd_install "$@" ;;
  verify) shift; [[ $# -eq 0 ]] || die "usage: repos.sh verify"; cmd_verify ;;
  rollback) shift; [[ $# -eq 0 ]] || die "usage: repos.sh rollback"; cmd_rollback ;;
  *) echo "Usage: repos.sh pin | build | install ARCHIVE SHA256 MANIFEST | verify | rollback" >&2; exit 2 ;;
esac
