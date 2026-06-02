#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE="$ROOT_DIR/.env.hephaestus"

say() {
  printf '%s\n' "$*"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

prompt_default() {
  prompt_label=$1
  default_value=$2
  printf '%s [%s]: ' "$prompt_label" "$default_value" >&2
  read -r user_value || true
  if [ -z "${user_value:-}" ]; then
    printf '%s' "$default_value"
  else
    printf '%s' "$user_value"
  fi
}

prompt_yes_no() {
  prompt_label=$1
  default_value=$2
  default_hint="Y/n"
  if [ "$default_value" = "no" ]; then
    default_hint="y/N"
  fi

  while true; do
    printf '%s [%s]: ' "$prompt_label" "$default_hint" >&2
    read -r answer || true
    normalized=$(printf '%s' "${answer:-}" | tr '[:upper:]' '[:lower:]')

    if [ -z "$normalized" ]; then
      if [ "$default_value" = "yes" ]; then
        return 0
      fi
      return 1
    fi

    case "$normalized" in
      y|yes|д|да) return 0 ;;
      n|no|н|нет) return 1 ;;
    esac
  done
}

detect_os() {
  kernel_name=$(uname -s 2>/dev/null || printf 'unknown')
  case "$kernel_name" in
    Linux) printf 'linux' ;;
    Darwin) printf 'macos' ;;
    MINGW*|MSYS*|CYGWIN*) printf 'windows' ;;
    *) printf 'unknown' ;;
  esac
}

detect_package_manager() {
  if command_exists brew; then
    printf 'brew'
    return
  fi

  if command_exists apt-get; then
    printf 'apt'
    return
  fi

  if command_exists dnf; then
    printf 'dnf'
    return
  fi

  if command_exists pacman; then
    printf 'pacman'
    return
  fi

  if command_exists winget.exe || command_exists winget; then
    printf 'winget'
    return
  fi

  if command_exists choco.exe || command_exists choco; then
    printf 'choco'
    return
  fi

  printf 'unknown'
}

install_missing_dependencies() {
  package_manager=$1
  os_name=$2
  missing_list=$3

  if [ -z "$missing_list" ]; then
    return
  fi

  case "$package_manager" in
    brew)
      for dependency in $missing_list; do
        case "$dependency" in
          docker) brew install --cask docker ;;
          node) brew install node ;;
          *) brew install "$dependency" ;;
        esac
      done
      ;;
    apt)
      sudo apt-get update
      apt_packages=""
      needs_ollama="no"
      for dependency in $missing_list; do
        case "$dependency" in
          git) apt_packages="$apt_packages git" ;;
          node) apt_packages="$apt_packages nodejs npm" ;;
          go) apt_packages="$apt_packages golang" ;;
          docker) apt_packages="$apt_packages docker.io docker-compose-plugin" ;;
          ollama) needs_ollama="yes" ;;
        esac
      done
      if [ -n "$apt_packages" ]; then
        # shellcheck disable=SC2086
        sudo apt-get install -y $apt_packages
      fi
      if [ "$needs_ollama" = "yes" ]; then
        curl -fsSL https://ollama.com/install.sh | sh
      fi
      ;;
    dnf)
      dnf_packages=""
      for dependency in $missing_list; do
        case "$dependency" in
          git) dnf_packages="$dnf_packages git" ;;
          node) dnf_packages="$dnf_packages nodejs npm" ;;
          go) dnf_packages="$dnf_packages golang" ;;
          docker) dnf_packages="$dnf_packages docker docker-compose-plugin" ;;
          ollama) dnf_packages="$dnf_packages ollama" ;;
        esac
      done
      if [ -n "$dnf_packages" ]; then
        # shellcheck disable=SC2086
        sudo dnf install -y $dnf_packages
      fi
      ;;
    pacman)
      pacman_packages=""
      for dependency in $missing_list; do
        case "$dependency" in
          git) pacman_packages="$pacman_packages git" ;;
          node) pacman_packages="$pacman_packages nodejs npm" ;;
          go) pacman_packages="$pacman_packages go" ;;
          docker) pacman_packages="$pacman_packages docker docker-compose" ;;
          ollama) pacman_packages="$pacman_packages ollama" ;;
        esac
      done
      if [ -n "$pacman_packages" ]; then
        # shellcheck disable=SC2086
        sudo pacman -Sy --noconfirm $pacman_packages
      fi
      ;;
    winget)
      for dependency in $missing_list; do
        case "$dependency" in
          git) winget_cmd="Git.Git" ;;
          node) winget_cmd="OpenJS.NodeJS.LTS" ;;
          go) winget_cmd="GoLang.Go" ;;
          docker) winget_cmd="Docker.DockerDesktop" ;;
          ollama) winget_cmd="Ollama.Ollama" ;;
          *) winget_cmd="" ;;
        esac
        if [ -n "$winget_cmd" ]; then
          winget install --accept-package-agreements --accept-source-agreements -e --id "$winget_cmd"
        fi
      done
      ;;
    choco)
      for dependency in $missing_list; do
        case "$dependency" in
          git) choco install -y git ;;
          node) choco install -y nodejs-lts ;;
          go) choco install -y golang ;;
          docker) choco install -y docker-desktop ;;
          ollama) choco install -y ollama ;;
        esac
      done
      ;;
    *)
      say "Не найден поддерживаемый пакетный менеджер. Установи зависимости вручную: $missing_list"
      ;;
  esac

  if [ "$os_name" = "linux" ] && command_exists systemctl && printf '%s' "$missing_list" | grep -q 'docker'; then
    say "Проверь, что Docker daemon запущен: sudo systemctl enable --now docker"
  fi
}

write_env_file() {
  bot_token=$1
  projects_dir=$2
  state_dir=$3
  available_models=$4
  bot_mode=$5
  ollama_url=$6
  poll_interval_ms=$7

  cat >"$ENV_FILE" <<EOF
export TELEGRAM_BOT_TOKEN="$bot_token"
export HEPHAESTUS_PROJECTS_DIR="$projects_dir"
export HEPHAESTUS_BOT_STATE_DIR="$state_dir"
export HEPHAESTUS_AVAILABLE_MODELS="$available_models"
export HEPHAESTUS_BOT_MODE="$bot_mode"
export HEPHAESTUS_OLLAMA_BASE_URL="$ollama_url"
export HEPHAESTUS_JOB_POLL_INTERVAL_MS="$poll_interval_ms"
EOF
}

say "Hephaestus host setup"
say "Репозиторий: $ROOT_DIR"

OS_NAME=$(detect_os)
PACKAGE_MANAGER=$(detect_package_manager)
MISSING_DEPENDENCIES=""

if ! command_exists git; then
  MISSING_DEPENDENCIES="$MISSING_DEPENDENCIES git"
fi

if ! command_exists node; then
  MISSING_DEPENDENCIES="$MISSING_DEPENDENCIES node"
fi

if ! command_exists npm; then
  MISSING_DEPENDENCIES="$MISSING_DEPENDENCIES node"
fi

if ! command_exists docker; then
  MISSING_DEPENDENCIES="$MISSING_DEPENDENCIES docker"
fi

if ! command_exists go; then
  MISSING_DEPENDENCIES="$MISSING_DEPENDENCIES go"
fi

if ! command_exists ollama; then
  MISSING_DEPENDENCIES="$MISSING_DEPENDENCIES ollama"
fi

if [ -n "$MISSING_DEPENDENCIES" ]; then
  say "Не хватает зависимостей:$MISSING_DEPENDENCIES"
  if prompt_yes_no "Попробовать установить недостающие зависимости автоматически?" "yes"; then
    install_missing_dependencies "$PACKAGE_MANAGER" "$OS_NAME" "$MISSING_DEPENDENCIES"
  fi
else
  say "Основные зависимости уже установлены."
fi

if prompt_yes_no "Запустить npm install в репозитории?" "yes"; then
  (cd "$ROOT_DIR" && npm install)
fi

default_model=$(prompt_default "Модель Ollama по умолчанию" "qwen2.5-coder:14b")
additional_model=$(prompt_default "Дополнительная модель для выбора в боте" "qwen2.5-coder:7b")
projects_dir=$(prompt_default "Директория для проектов" "$HOME/hephaestus-projects")
state_dir=$(prompt_default "Директория для состояния бота" "$HOME/hephaestus-bot-state")
bot_mode=$(prompt_default "Режим запуска бота (all, poll, worker)" "all")
ollama_url=$(prompt_default "URL локального Ollama API" "http://127.0.0.1:11434")
poll_interval_ms=$(prompt_default "Интервал опроса очереди worker в мс" "3000")

available_models="$default_model|Primary Model|Модель по умолчанию"
if [ -n "$additional_model" ] && [ "$additional_model" != "$default_model" ]; then
  available_models="$available_models,$additional_model|Secondary Model|Дополнительная модель"
fi

say ""
say "Сейчас открой @BotFather, выполни /newbot и вставь сюда выданный токен."
bot_token=""
while [ -z "$bot_token" ]; do
  printf 'TELEGRAM_BOT_TOKEN: ' >&2
  read -r bot_token || true
done

if command_exists ollama && prompt_yes_no "Скачать модель $default_model через ollama pull?" "yes"; then
  ollama pull "$default_model"
fi

mkdir -p "$projects_dir" "$state_dir"
write_env_file "$bot_token" "$projects_dir" "$state_dir" "$available_models" "$bot_mode" "$ollama_url" "$poll_interval_ms"

say ""
say "Готово. Конфигурация сохранена в $ENV_FILE"
say ""
say "Следующие команды:"
say "1. source \"$ENV_FILE\""
say "2. npm run build"
say "3. npm run telegram-bot            # единый процесс"
say "   или"
say "   npm run telegram-bot-poll       # только Telegram UI"
say "   npm run telegram-bot-worker     # только worker"
say ""
say "После запуска открой Telegram и используй команды /start, /new, /status."
