#!/usr/bin/env bash
# Installs pdd + pd, or moves an existing install to the self-updating layout.
# Safe to re-run: processes, logs and settings in /var/lib/pdd are kept.
set -euo pipefail

GITHUB_USER="AirplaneGobrr-Trash"
REPO="process-daemon"
DATA_DIR=/var/lib/pdd
BIN_DIR=$DATA_DIR/bin
SERVICE=/etc/systemd/system/pdd.service
USER_NAME="${SUDO_USER:-$USER}"

# Release signing key (Ed25519). Must match RELEASE_PUBLIC_KEY in projects/release.ts.
PUBKEY='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJKSzwhhQrw5mTlklbwotusWIw3pTjtoT/ewZGhoXVEQ=
-----END PUBLIC KEY-----'

case "$(uname -m)" in
    x86_64)  ARCH="x64" ;;
    aarch64) ARCH="arm64" ;;
    *) echo "error: unsupported architecture: $(uname -m)"; exit 1 ;;
esac

BASE_URL="https://github.com/$GITHUB_USER/$REPO/releases/latest/download"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading pdd and pd ($ARCH)..."
for f in "pdd-linux-$ARCH.gz" "pd-linux-$ARCH.gz" SHA256SUMS SHA256SUMS.sig; do
    curl -fsSL "$BASE_URL/$f" -o "$TMP/$f"
done

echo "Verifying..."
printf '%s\n' "$PUBKEY" > "$TMP/key.pem"
if command -v openssl >/dev/null 2>&1 && openssl version | grep -q '^OpenSSL 3'; then
    base64 -d "$TMP/SHA256SUMS.sig" > "$TMP/sig.bin"
    if ! openssl pkeyutl -verify -pubin -inkey "$TMP/key.pem" -rawin -in "$TMP/SHA256SUMS" -sigfile "$TMP/sig.bin" >/dev/null 2>&1; then
        echo "error: release signature did not verify; not installing"; exit 1
    fi
    echo "  signature ok"
else
    echo "  warning: no OpenSSL 3 here to check the Ed25519 signature; relying on HTTPS + checksums (pdd checks signatures itself for every later update)"
fi
(cd "$TMP" && grep -E " (pdd|pd)-linux-$ARCH\.gz$" SHA256SUMS | sha256sum -c --quiet -) || { echo "error: checksum mismatch"; exit 1; }
gunzip -f "$TMP/pdd-linux-$ARCH.gz" "$TMP/pd-linux-$ARCH.gz"

echo "Installing into $BIN_DIR..."
sudo mkdir -p "$BIN_DIR"
sudo chown -R "$USER_NAME:$USER_NAME" "$DATA_DIR"
if [ -f "$BIN_DIR/pdd" ]; then cp -f "$BIN_DIR/pdd" "$BIN_DIR/pdd.prev"; fi
if [ -f "$BIN_DIR/pd" ]; then cp -f "$BIN_DIR/pd" "$BIN_DIR/pd.prev"; fi
install -m 755 "$TMP/pdd-linux-$ARCH" "$BIN_DIR/pdd"
install -m 755 "$TMP/pd-linux-$ARCH" "$BIN_DIR/pd"

# The launcher rolls back a self-update that won't start. Same script pdd
# writes on each self-update (LAUNCHER in projects/release.ts).
cat > "$BIN_DIR/pdd-launch" <<'LAUNCH'
#!/bin/sh
# Installed by pdd. Starts pdd and rolls back a self-update that won't start.
BIN="$(dirname "$(readlink -f "$0")")"
DATA="$(dirname "$BIN")"
PENDING="$DATA/update-pending"
if [ -f "$PENDING" ]; then
    n=$(cat "$PENDING.tries" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$PENDING.tries"
    if [ "$n" -gt 3 ] && [ -f "$BIN/pdd.prev" ]; then
        mv -f "$BIN/pdd.prev" "$BIN/pdd"
        [ -f "$BIN/pd.prev" ] && mv -f "$BIN/pd.prev" "$BIN/pd"
        echo "update $(cat "$PENDING") failed to start $((n - 1)) times; rolled back" > "$DATA/update-rollback"
        rm -f "$PENDING" "$PENDING.tries"
    fi
fi
exec "$BIN/pdd" "$@"
LAUNCH
chmod 755 "$BIN_DIR/pdd-launch"
rm -f "$DATA_DIR/update-pending" "$DATA_DIR/update-pending.tries"

echo "Linking /usr/local/bin/pd and pdd..."
sudo ln -sfn "$BIN_DIR/pdd" /usr/local/bin/pdd
sudo ln -sfn "$BIN_DIR/pd" /usr/local/bin/pd

echo "Installing systemd service..."
sudo tee "$SERVICE" > /dev/null <<EOF
[Unit]
Description=Process Daemon (pdd)
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$USER_NAME
ExecStart=$BIN_DIR/pdd-launch
WorkingDirectory=$DATA_DIR
EnvironmentFile=-$DATA_DIR/env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable pdd >/dev/null 2>&1
sudo systemctl restart pdd

echo ""
echo "pdd $("$BIN_DIR/pd" --version 2>/dev/null || true) is running at http://localhost:3830"
echo "It now updates itself from signed releases (pd autoupdate on|off). Updates no longer need sudo."
