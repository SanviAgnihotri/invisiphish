#!/usr/bin/env bash
#
# Point sanvi.adityavyas.com at the Vigil application.
#
# The application is already running on this machine under pm2, on
# 127.0.0.1:5180. This adds the nginx vhost that serves the hostname and
# obtains the certificate Cloudflare checks in strict mode.
#
# This is the route that does not involve the Cloudflare tunnel: the tunnel
# for this hostname can serve the application directly, on its own port, and
# then no origin certificate is needed at all. This script is for the case
# where the hostname reaches this machine through nginx instead.
#
# Run it with:
#   sudo bash ~/setup-sanvi-domain.sh

set -euo pipefail

DOMAIN="sanvi.adityavyas.com"
APP="127.0.0.1:5180"
SITE="/etc/nginx/sites-available/$DOMAIN"

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }

# --- the vhost ---------------------------------------------------------------

say "writing the vhost for $DOMAIN"

if [ -f "$SITE" ]; then
  cp "$SITE" "$SITE.bak.$(date +%s)"
fi

cat > "$SITE" <<CONF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # The application serves the pages and the API from one port.
    location / {
        proxy_pass http://$APP;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
CONF

say "enabling it"
ln -sf "$SITE" "/etc/nginx/sites-enabled/$DOMAIN"
nginx -t

# --- the certificate ---------------------------------------------------------

say "obtaining the certificate"
if ! certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --keep-until-expiring; then
  # No account yet, or the account wants an address: register one.
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email --keep-until-expiring
fi

say "reloading nginx"
systemctl reload nginx

# --- the check ---------------------------------------------------------------

say "checking"
sleep 2
curl -s -o /dev/null -w "  http://$DOMAIN/  -> %{http_code}\n" --max-time 15 "http://$DOMAIN/"
curl -s -o /dev/null -w "  https://$DOMAIN/ -> %{http_code}\n" --max-time 15 "https://$DOMAIN/"
curl -s --max-time 15 "https://$DOMAIN/" | head -c 200
echo

say "done"
