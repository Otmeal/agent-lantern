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

# POSIX sh 沒有陣列，轉發給 reporter 的參數改用換行分隔累積（見 append_arg），
# 而不是像過去那樣直接字串串接：字串串接在展開時會被重新斷字，endpoint 含
# 空白會被拆成多個參數、含 glob 字元有路徑展開風險，空字串甚至會讓旗標整個
# 消失、吃掉下一個旗標當成自己的值。
newline='
'
tarball=""
# 可重複指定 --endpoint，累積成多個值；環境變數只在完全沒給 --endpoint 時
# 才當作預設值，避免和累積的參數混在一起搞不清楚順序。
endpoint_values=""
endpoint_given=0
token="${AGENT_LANTERN_TOKEN:-}"
host_name="${AGENT_LANTERN_HOST_NAME:-}"
install_prefix=""
reporter_arguments=""

# fail 提前到 append_arg 之前定義，讓 append_arg 內的檢查在參數解析階段
# （while 迴圈執行期間）就能直接呼叫，不必等到迴圈跑完才有這個函式可用。
fail() {
  echo "install-remote: $1" >&2
  exit 1
}

# 把值加進以換行分隔的清單變數。$1 是變數名稱、$2 是要加入的值、$3 是出錯時
# 要告訴使用者的旗標名稱；用 eval 做間接賦值，是 POSIX sh 在沒有陣列與 nameref
# 時常見的寫法。值裡若含換行字元，會在後續用 $newline 還原成 argv 時被誤拆成
# 兩個獨立的參數，直接拒絕。
append_arg() {
  case "$2" in
    *"$newline"*)
      fail "${3:-$1} 的值不能包含換行字元。" ;;
  esac
  eval "$1=\"\${$1}\${$1:+\${newline}}\${2}\""
}

usage() {
  cat <<'USAGE'
用法：sh install-remote.sh [選項]

  --endpoint <url>      daemon endpoint，可重複指定以送到多台 daemon，
                        例如 http://100.80.10.15:48123
  --token <token>       與 Windows daemon 相同的 token
  --token-stdin         從標準輸入讀一行當作 token，會套用到本次所有 --endpoint
  --replace             先清空既有的所有目的地，再寫入這次指定的
  --host-name <name>    overlay 上顯示的主機名稱（預設為本機 hostname）
  --tarball <path>      agent-status-reporter-*.tgz 的位置
  --prefix <path>       npm 安裝前綴（預設：可寫就用全域，否則 ~/.local）
  --agent <codex|claude> 只設定其中一個代理程式；可重複指定
  --scope <user|project> 寫入使用者層級或專案層級設定（預設 user）
  --dry-run             只顯示將要變更的內容
  --skip-verify         跳過 /health 與測試事件
  --skip-install        已經安裝過 reporter，只重新寫設定

endpoint 與 token 可在 Windows 的 overlay 視窗按「設定」再按「複製」取得。
多台 daemon 的 token 不同時，--token-stdin／--token 只能套用同一個值給本次
所有 --endpoint，請分兩次執行（第二次加 --skip-install 略過重新安裝）。
USAGE
}

skip_install=0

while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint)
      # 空字串會被 append_arg 靜靜吞掉（等同沒加這個值），但 endpoint_given
      # 已經設成 1，之後環境變數／互動提示的退回也會一併被跳過，結果是
      # 完全沒有傳出任何 --endpoint。與其讓它悄悄消失，不如直接擋下來。
      [ -n "$2" ] || fail "--endpoint 不能是空字串。"
      append_arg endpoint_values "$2" --endpoint
      endpoint_given=1
      shift 2 ;;
    --token) token="$2"; shift 2 ;;
    --token-stdin) IFS= read -r token; shift ;;
    --replace) append_arg reporter_arguments "--replace"; shift ;;
    --host-name) host_name="$2"; shift 2 ;;
    --tarball) tarball="$2"; shift 2 ;;
    --prefix) install_prefix="$2"; shift 2 ;;
    --agent)
      append_arg reporter_arguments "--agent"
      append_arg reporter_arguments "$2" --agent
      shift 2 ;;
    --scope)
      append_arg reporter_arguments "--scope"
      append_arg reporter_arguments "$2" --scope
      shift 2 ;;
    --project-directory)
      append_arg reporter_arguments "--project-directory"
      append_arg reporter_arguments "$2" --project-directory
      shift 2 ;;
    --dry-run) append_arg reporter_arguments "--dry-run"; shift ;;
    --skip-verify) append_arg reporter_arguments "--skip-verify"; shift ;;
    --skip-install) skip_install=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install-remote: 未知選項 $1" >&2; usage >&2; exit 2 ;;
  esac
done

# --- 前置檢查 ---------------------------------------------------------------

command -v node >/dev/null 2>&1 || fail "找不到 node。reporter 需要 Node.js 20.19 以上版本。"
command -v npm >/dev/null 2>&1 || fail "找不到 npm。"

node -e 'const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 19)) {
  console.error(`需要 Node.js 20.19 以上版本，目前是 ${process.versions.node}。`);
  process.exit(1);
}' || exit 1

if [ "$endpoint_given" -eq 0 ]; then
  endpoint="${AGENT_LANTERN_DAEMON_ENDPOINT:-}"
  if [ -z "$endpoint" ] && [ -t 0 ]; then
    printf 'daemon endpoint（例如 http://100.80.10.15:48123）：'
    IFS= read -r endpoint
  fi
  [ -n "$endpoint" ] || fail "缺少 --endpoint。"
  endpoint_values="$endpoint"
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

  # 沒有先 build 就 pnpm pack 的話，tarball 會只剩 package.json 而沒有 dist/，
  # 安裝起來不會報錯但也不會產生任何指令，所以先擋掉。
  if ! tar -tzf "$tarball" 2>/dev/null | grep -q '^package/dist/index\.js$'; then
    fail "$tarball 裡沒有 package/dist/index.js。
這個 tarball 是在尚未建置的情況下打包出來的。請在打包的機器上重新執行
\`pnpm pack:reporter\`（會先跑 build），再把新的 .tgz 複製到這台機器。"
  fi

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
  if ! npm_output=$(npm install --global --prefix "$install_prefix" "$tarball" 2>&1); then
    printf '%s\n' "$npm_output" >&2
    fail "npm install 失敗，詳細訊息如上。"
  fi
  reporter_binary="$install_prefix/bin/agent-status-reporter"
else
  reporter_binary=$(command -v agent-status-reporter || echo "")
  [ -n "$reporter_binary" ] || fail "--skip-install 需要 agent-status-reporter 已在 PATH 上。"
fi

[ -x "$reporter_binary" ] || fail "安裝後找不到可執行的 $reporter_binary。"

# --- 寫入設定（合併，不覆蓋）-------------------------------------------------

# 把換行分隔的參數清單安全地還原成獨立的位置參數：只用換行字元切字（不含
# 空白／tab），並關掉 glob 展開，這樣每個累積進去的值（不論含不含空白或
# glob 字元）都會原封不動地變成一個獨立的 argv 項目。
set -- install
old_ifs=$IFS
IFS=$newline
set -f
for value in $endpoint_values; do
  set -- "$@" --endpoint "$value"
done
IFS=$old_ifs
set +f

set -- "$@" --token-stdin --command-path "$reporter_binary"
if [ -n "$host_name" ]; then
  set -- "$@" --host-name "$host_name"
fi

IFS=$newline
set -f
for value in $reporter_arguments; do
  set -- "$@" "$value"
done
IFS=$old_ifs
set +f

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
