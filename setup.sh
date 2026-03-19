#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Yo! — One-Command VPS Setup Script
# Works on: Ubuntu 20.04/22.04/24.04, Debian 11/12
# Free hosting: Oracle Cloud Free Tier, Fly.io, Hetzner CAX11 (€4/mo)
#
# Usage:
#   curl -fsSL https://yourserver.com/setup.sh | bash
#   OR after uploading:
#   chmod +x setup.sh && ./setup.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[YO]${NC} $1"; }
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

echo ""
echo "  🔐 Yo! Server Setup"
echo "  ────────────────────────────────────"
echo ""

# ─── 1. System Update ──────────────────────────────────────────────────────────
log "Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

# ─── 2. Node.js 20 LTS ────────────────────────────────────────────────────────
if ! command -v node &> /dev/null; then
  log "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs -qq
else
  info "Node.js already installed: $(node --version)"
fi

# ─── 3. PM2 (process manager — keeps server alive after reboots) ──────────────
if ! command -v pm2 &> /dev/null; then
  log "Installing PM2..."
  npm install -g pm2 --silent
fi

# ─── 4. Copy server files ─────────────────────────────────────────────────────
log "Setting up server directory..."
mkdir -p /opt/yo-server
cp -r ./* /opt/yo-server/
cd /opt/yo-server

# ─── 5. Install dependencies ──────────────────────────────────────────────────
log "Installing server dependencies..."
npm install --omit=dev --silent

# ─── 6. Firewall ──────────────────────────────────────────────────────────────
if command -v ufw &> /dev/null; then
  log "Configuring firewall..."
  ufw allow 22/tcp   > /dev/null 2>&1   # SSH
  ufw allow 80/tcp   > /dev/null 2>&1   # HTTP
  ufw allow 443/tcp  > /dev/null 2>&1   # HTTPS
  ufw allow 3000/tcp > /dev/null 2>&1   # Yo! server (direct)
  ufw --force enable > /dev/null 2>&1
fi

# ─── 7. Start with PM2 ────────────────────────────────────────────────────────
log "Starting Yo! server with PM2..."
cd /opt/yo-server
pm2 delete yo-server 2>/dev/null || true
pm2 start server.js --name yo-server --restart-delay=3000
pm2 save
pm2 startup | tail -1 | bash 2>/dev/null || true

# ─── 8. Optional: Nginx reverse proxy + SSL ────────────────────────────────────
read -p "  Set up Nginx + free SSL (HTTPS)? Requires a domain name. [y/N]: " setup_nginx
if [[ "$setup_nginx" =~ ^[Yy]$ ]]; then
  read -p "  Enter your domain (e.g. chat.yourdomain.com): " DOMAIN

  apt-get install -y nginx certbot python3-certbot-nginx -qq

  cat > /etc/nginx/sites-available/yo-server << EOF
server {
    server_name ${DOMAIN};

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

  ln -sf /etc/nginx/sites-available/yo-server /etc/nginx/sites-enabled/
  nginx -t && systemctl reload nginx

  log "Getting free SSL certificate from Let's Encrypt..."
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@${DOMAIN}" 2>/dev/null \
    && log "SSL enabled! Your server: https://${DOMAIN}" \
    || warn "SSL setup failed — server still running on http://${DOMAIN}:3000"
else
  SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
  info "Skipping SSL. Your server URL: http://${SERVER_IP}:3000"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "  ${GREEN}✅ Yo! server is running!${NC}"
echo "  ────────────────────────────────────────────────────"
echo "  Server URL : http://${SERVER_IP}:3000"
echo "  Health check: curl http://${SERVER_IP}:3000/health"
echo "  View logs  : pm2 logs yo-server"
echo "  Restart    : pm2 restart yo-server"
echo "  Status     : pm2 status"
echo "  DB location: /opt/yo-server/yo.db"
echo "  ────────────────────────────────────────────────────"
echo ""
echo "  📱 Next step: Open app/src/lib/api.ts and set:"
echo "     SERVER_URL = 'http://${SERVER_IP}:3000'"
echo ""
