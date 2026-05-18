#!/usr/bin/env bash
set -e

PDD_BINARY=/usr/local/bin/pdd
PD_BINARY=/usr/local/bin/pd
DATA_DIR=/var/lib/pdd
SERVICE=/etc/systemd/system/pdd.service

ARCH=$(uname -m)
case $ARCH in
    x86_64)  ARCH="x64" ;;
    aarch64) ARCH="arm64" ;;
    *) echo "error: unsupported architecture: $ARCH"; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Building..."
bun run build:server

echo "Installing binaries..."
sudo install -m 755 "$SCRIPT_DIR/pdd-linux-$ARCH" "$PDD_BINARY"
sudo install -m 755 "$SCRIPT_DIR/pd-linux-$ARCH" "$PD_BINARY"

echo "Creating data directory $DATA_DIR..."
sudo mkdir -p "$DATA_DIR"
sudo chown "$USER:$USER" "$DATA_DIR"

if [ ! -f "$SERVICE" ]; then
    echo "Installing systemd service..."
    sudo tee "$SERVICE" > /dev/null <<EOF
[Unit]
Description=Process Daemon (pdd)
After=network.target

[Service]
Type=simple
User=$USER
ExecStart=$PDD_BINARY
WorkingDirectory=$DATA_DIR
EnvironmentFile=-/var/lib/pdd/env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable pdd
fi

echo "Restarting pdd..."
sudo systemctl restart pdd

echo ""
echo "pdd and pd installed from local build."