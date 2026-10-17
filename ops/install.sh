#!/usr/bin/env bash
# One-time: hooks the sync agent into cron and moves any existing install's .env/logs over.
set -e
chmod +x /root/copybot-ops/ops/agent.sh
( crontab -l 2>/dev/null | grep -v copybot-ops/ops/agent.sh; echo "* * * * * /root/copybot-ops/ops/agent.sh >> /root/copybot-agent.log 2>&1" ) | crontab -
command -v pm2 >/dev/null && pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
/root/copybot-ops/ops/agent.sh
echo ""
echo "ALL SET. Claude can run the bot from here. You can close this window."
