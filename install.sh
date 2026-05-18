#!/usr/bin/env bash
set -e

GITHUB_USER="AirplaneGobrr-Trash"
REPO="process-daemon"
PDD_BINARY=/usr/local/bin/pdd
PD_BINARY=/usr/local/bin/pd
DATA_DIR=/var/lib/pdd
SERVICE=/etc/systemd/system/pdd.service

# Detect architecture
ARCH=$(uname -m)
case $ARCH in
    x86_64)  ARCH="x64" ;;
    aarch64) ARCH="arm64" ;;
    *) echo "error: unsupported architecture: $ARCH"; exit 1 ;;
esac

BASE_URL="https://github.com/$GITHUB_USER/$REPO/releases/latest/download"

echo "Downloading pdd..."
curl -fsSL "$BASE_URL/pdd-linux-$ARCH" -o /tmp/pdd-download

echo "Downloading pd..."
curl -fsSL "$BASE_URL/pd-linux-$ARCH" -o /tmp/pd-download

echo "Installing binaries..."
sudo install -m 755 /tmp/pdd-download "$PDD_BINARY"
sudo install -m 755 /tmp/pd-download "$PD_BINARY"
rm /tmp/pdd-download /tmp/pd-download

echo "Creating data directory $DATA_DIR..."
sudo mkdir -p "$DATA_DIR"
sudo chown "$USER:$USER" "$DATA_DIR"

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
sudo systemctl start pdd

echo ""
echo "pdd installed and running at http://localhost:3830"
echo "pd CLI available as: pd list, pd start, pd stop, pd restart, pd remove, pd logs"
