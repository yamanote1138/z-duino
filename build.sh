#!/bin/bash
set -e

# Colours
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Config
FRONTEND_DIR="frontend"
BUILD_DIR="build"
DATA_DIR="$BUILD_DIR/data"

info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; }

check_deps() {
  if ! command -v pio &>/dev/null; then
    error "PlatformIO not found. Install with: brew install platformio"
    info "See: https://docs.platformio.org/en/latest/core/installation/index.html"
    exit 1
  fi
}

detect_port() {
  # Reuse previously selected port
  if [ -n "$SELECTED_PORT" ]; then
    return 0
  fi

  local ports=()
  if [[ "$OSTYPE" == "darwin"* ]]; then
    while IFS= read -r p; do ports+=("$p"); done < <(ls /dev/cu.*usb* 2>/dev/null || true)
  else
    while IFS= read -r p; do ports+=("$p"); done < <(ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true)
  fi

  if [ ${#ports[@]} -eq 0 ]; then
    error "No USB serial device found. Plug in the Wemos D1 Mini."
    return 1
  elif [ ${#ports[@]} -eq 1 ]; then
    SELECTED_PORT="${ports[0]}"
    info "Using port: $SELECTED_PORT"
  else
    echo "Multiple serial devices found:"
    for i in "${!ports[@]}"; do
      echo "  $((i+1))) ${ports[$i]}"
    done
    read -rp "Select port [1]: " choice
    choice=${choice:-1}
    SELECTED_PORT="${ports[$((choice-1))]}"
    info "Using port: $SELECTED_PORT"
  fi
}

build_frontend() {
  info "Building frontend..."
  cd "$FRONTEND_DIR"
  npm run build
  cd ..
  success "Frontend built → $DATA_DIR/"
}

frontend_needs_build() {
  [ ! -f "$DATA_DIR/index.html" ] && return 0
  find "$FRONTEND_DIR/src" "$FRONTEND_DIR/public" "$FRONTEND_DIR/index.html" \
       "$FRONTEND_DIR/vite.config.ts" "$FRONTEND_DIR/package.json" "$FRONTEND_DIR/package-lock.json" \
       -type f -newer "$DATA_DIR/index.html" 2>/dev/null | grep -q .
}

build_frontend_if_needed() {
  if frontend_needs_build; then
    build_frontend
  else
    info "Frontend unchanged, skipping build ($DATA_DIR/ is up to date)"
  fi
}

build_firmware() {
  check_deps
  info "Compiling firmware..."
  pio run
  success "Firmware compiled"
}

upload_firmware() {
  check_deps
  detect_port || return 1
  info "Uploading firmware..."
  if ! pio run -t upload --upload-port "$SELECTED_PORT"; then
    error "Firmware upload failed. Check the connection and try again."
    return 1
  fi
  success "Firmware uploaded"
}

upload_littlefs() {
  check_deps
  detect_port || return 1

  if [ ! -d "$DATA_DIR" ]; then
    error "No data directory found. Build the frontend first."
    return 1
  fi

  info "Packing and flashing LittleFS image..."
  if ! pio run -t uploadfs --upload-port "$SELECTED_PORT"; then
    error "LittleFS upload failed. Check the connection and try again."
    return 1
  fi
  success "LittleFS uploaded"
}

# Menu
echo ""
echo -e "${CYAN}╔══════════════════════════════╗${NC}"
echo -e "${CYAN}║       Z-Duino Builder        ║${NC}"
echo -e "${CYAN}╠══════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}  1) Build All                ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  2) Build Frontend           ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  3) Build Firmware           ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  4) Upload Firmware          ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  5) Upload LittleFS          ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  6) Upload All               ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  7) Build + Upload All       ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════╝${NC}"
echo ""
read -rp "Select option [7]: " option
option=${option:-7}

case $option in
  1) build_frontend_if_needed; build_firmware ;;
  2) build_frontend ;;
  3) build_firmware ;;
  4) upload_firmware ;;
  5) upload_littlefs ;;
  6) upload_firmware; upload_littlefs ;;
  7) build_frontend_if_needed; build_firmware; upload_firmware; upload_littlefs ;;
  *) error "Invalid option" ;;
esac

echo ""
success "Done!"
