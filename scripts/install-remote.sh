#!/bin/sh
# Agent Lantern：在 WSL 或遠端 Linux 主機上一次做完 reporter 安裝與 hook 設定。
#
# 假設 agent-status-reporter-<version>.tgz 已經放到這台機器上（和本腳本同一個
# 目錄，或用 --tarball 指定）。
#
#   sh install-remote.sh --endpoint http://100.80.10.15:48123 --token <token>
#
# hook 設定一律「合併」寫入既有的 ~/.codex/hooks.json 與 ~/.claude/settings.json，
# 不會覆蓋使用者原有的設定；寫入前會先產生時間戳記備份。
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

tarball=""
endpoint="${AGENT_LANTERN_DAEMON_ENDPOINT:-}"
token="${AGENT_LANTERN_TOKEN:-}"
host_name="${AGENT_LANTERN_HOST_NAME:-}"
install_prefix=""
reporter_arguments=""

usage() {
  cat <<'USAGE'
用法：sh install-remote.sh [選項]

  --endpoint <url>      daemon endpoint，例如 http://100.80.10.15:48123
  --token <token>       與 Windows daemon 相同的 token
  --token-stdin         從標準輸入讀一行當作 token
  --host-name <name>    overlay 上顯示的主機名稱（預設為本機 hostname）
  --tarball <path>      agent-status-reporter-*.tgz 的位置
  --prefix <path>       npm 安裝前綴（預設：可寫就用全域，否則 ~/.local）
  --agent <codex|claude> 只設定其中一個代理程式；可重複指定
  --scope <user|project> 寫入使用者層級或專案層級設定（預設 user）
  --dry-run             只顯示將要變更的內容
  --skip-verify         跳過 /health 與測試事件
  --skip-install        已經安裝過 reporter，只重新寫設定

endpoint 與 token 可在 Windows 的 overlay 視窗按「設定」再按「複製」取得。
USAGE
}

skip_install=0

while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint) endpoint="$2"; shift 2 ;;
    --token) token="$2"; shift 2 ;;
    --token-stdin) IFS= read -r token; shift ;;
    --host-name) host_name="$2"; shift 2 ;;
    --tarball) tarball="$2"; shift 2 ;;
    --prefix) install_prefix="$2"; shift 2 ;;
    --agent) reporter_arguments="$reporter_arguments --agent $2"; shift 2 ;;
    --scope) reporter_arguments="$reporter_arguments --scope $2"; shift 2 ;;
    --project-directory)
      reporter_arguments="$reporter_arguments --project-directory $2"; shift 2 ;;
    --dry-run) reporter_arguments="$reporter_arguments --dry-run"; shift ;;
    --skip-verify) reporter_arguments="$reporter_arguments --skip-verify"; shift ;;
    --skip-install) skip_install=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install-remote: 未知選項 $1" >&2; usage >&2; exit 2 ;;
  esac
done

fail() {
  echo "install-remote: $1" >&2
  exit 1
}

# --- 前置檢查 ---------------------------------------------------------------

command -v node >/dev/null 2>&1 || fail "找不到 node。reporter 需要 Node.js 20.19 以上版本。"
command -v npm >/dev/null 2>&1 || fail "找不到 npm。"

node -e 'const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 19)) {
  console.error(`需要 Node.js 20.19 以上版本，目前是 ${process.versions.node}。`);
  process.exit(1);
}' || exit 1

if [ -z "$endpoint" ]; then
  if [ -t 0 ]; then
    printf 'daemon endpoint（例如 http://100.80.10.15:48123）：'
    IFS= read -r endpoint
  fi
  [ -n "$endpoint" ] || fail "缺少 --endpoint。"
fi

if [ -z "$token" ]; then
  if [ -t 0 ]; then
    printf 'AGENT_LANTERN_TOKEN：'
    stty -echo 2>/dev/null || true
    IFS= read -r token
    stty echo 2>/dev/null || true
    printf '\n'
  fi
  [ -n "$token" ] || fail "缺少 --token。"
fi

# --- 安裝 reporter -----------------------------------------------------------

if [ "$skip_install" -eq 0 ]; then
  if [ -z "$tarball" ]; then
    for candidate in "$script_directory"/agent-status-reporter-*.tgz \
                     ./agent-status-reporter-*.tgz; do
      [ -f "$candidate" ] || continue
      tarball="$candidate"
      break
    done
  fi
  [ -n "$tarball" ] || fail "找不到 agent-status-reporter-*.tgz，請用 --tarball 指定。"
  [ -f "$tarball" ] || fail "找不到檔案：$tarball"

  if [ -z "$install_prefix" ]; then
    global_prefix=$(npm prefix --global 2>/dev/null || echo "")
    if [ -n "$global_prefix" ] && [ -w "$global_prefix/lib" ]; then
      install_prefix="$global_prefix"
    else
      # 預設不動系統目錄，也就不需要 sudo。
      install_prefix="$HOME/.local"
    fi
  fi

  echo "install-remote: 安裝 $tarball 到 $install_prefix"
  npm install --global --prefix "$install_prefix" "$tarball" >/dev/null
  reporter_binary="$install_prefix/bin/agent-status-reporter"
else
  reporter_binary=$(command -v agent-status-reporter || echo "")
  [ -n "$reporter_binary" ] || fail "--skip-install 需要 agent-status-reporter 已在 PATH 上。"
fi

[ -x "$reporter_binary" ] || fail "安裝後找不到可執行的 $reporter_binary。"

# --- 寫入設定（合併，不覆蓋）-------------------------------------------------

set -- install \
  --endpoint "$endpoint" \
  --token-stdin \
  --command-path "$reporter_binary"
if [ -n "$host_name" ]; then
  set -- "$@" --host-name "$host_name"
fi
# shellcheck disable=SC2086
set -- "$@" $reporter_arguments

printf '%s\n' "$token" | "$reporter_binary" "$@"

# --- PATH 提醒 ---------------------------------------------------------------

case ":$PATH:" in
  *":$(dirname -- "$reporter_binary"):"*) ;;
  *)
    cat <<EOF

提醒：$(dirname -- "$reporter_binary") 不在目前的 PATH 上。
hook 內已寫入絕對路徑所以仍能運作，但若想直接手動執行 agent-status-reporter，
請把下面這行加進 ~/.profile 或 ~/.bashrc：

  export PATH="$(dirname -- "$reporter_binary"):\$PATH"
EOF
    ;;
esac
