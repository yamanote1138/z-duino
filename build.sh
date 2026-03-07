#!/bin/bash
set -e

# Colours
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Config
FQBN="esp8266:esp8266:d1_mini:xtal=80,vt=flash,exception=disabled,ssl=all,eesz=4M2M,ip=lm2f,dbg=Disabled,lvl=None____,wipe=none,baud=921600"
SKETCH_DIR="firmware/z-duino"
FRONTEND_DIR="frontend"
BUILD_DIR="build"
DATA_DIR="$BUILD_DIR/data"

info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; }

detect_port() {
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
    echo "Multiple ports found:"
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

build_firmware() {
  info "Compiling firmware..."
  mkdir -p "$BUILD_DIR"
  arduino-cli compile --fqbn "$FQBN" --output-dir "$BUILD_DIR" "$SKETCH_DIR"
  success "Firmware compiled"
}

upload_firmware() {
  detect_port || return 1
  info "Uploading firmware..."
  arduino-cli upload --fqbn "$FQBN" --port "$SELECTED_PORT" --input-dir "$BUILD_DIR" "$SKETCH_DIR"
  success "Firmware uploaded"
}

upload_littlefs() {
  detect_port || return 1

  if [ ! -d "$DATA_DIR" ]; then
    error "No data directory found. Build the frontend first."
    return 1
  fi

  info "Packing LittleFS image..."

  # Find mklittlefs
  MKLITTLEFS=$(find ~/.arduino15 -name "mklittlefs" -type f 2>/dev/null | head -1)
  if [ -z "$MKLITTLEFS" ]; then
    error "mklittlefs not found. Install the ESP8266 board package."
    return 1
  fi

  # 4M2M layout: 2MB filesystem at offset 0x200000
  "$MKLITTLEFS" -c "$DATA_DIR" -b 4096 -p 256 -s 2031616 "$BUILD_DIR/littlefs.bin"
  success "LittleFS image created"

  # Find esptool
  ESPTOOL=$(find ~/.arduino15 -name "esptool" -type f 2>/dev/null | head -1)
  if [ -z "$ESPTOOL" ]; then
    ESPTOOL=$(which esptool.py 2>/dev/null || which esptool 2>/dev/null || true)
  fi
  if [ -z "$ESPTOOL" ]; then
    error "esptool not found."
    return 1
  fi

  info "Flashing LittleFS to ESP8266..."
  "$ESPTOOL" --chip esp8266 --port "$SELECTED_PORT" --baud 460800 write_flash 0x200000 "$BUILD_DIR/littlefs.bin"
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
  1) build_frontend; build_firmware ;;
  2) build_frontend ;;
  3) build_firmware ;;
  4) upload_firmware ;;
  5) upload_littlefs ;;
  6) upload_firmware; upload_littlefs ;;
  7) build_frontend; build_firmware; upload_firmware; upload_littlefs ;;
  *) error "Invalid option" ;;
esac

echo ""
success "Done!"
