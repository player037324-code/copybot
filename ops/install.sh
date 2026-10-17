#!/usr/bin/env bash
# One-time: runs the sync agent every minute via a systemd timer (cron isn't always installed).
set -e
chmod +x /root/copybot-ops/ops/agent.sh
crontab -l 2>/dev/null | grep -v copybot-ops/ops/agent.sh | crontab - 2>/dev/null || true

cat > /etc/systemd/system/copybot-agent.service <<'EOF'
[Unit]
Description=copybot GitHub sync agent
After=network-online.target
[Service]
Type=oneshot
ExecStart=/bin/bash -c '/bin/bash /root/copybot-ops/ops/agent.sh >> /root/copybot-agent.log 2>&1'
TimeoutStartSec=170
EOF

cat > /etc/systemd/system/copybot-agent.timer <<'EOF'
[Unit]
Description=run copybot sync agent every minute
[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=5
Persistent=true
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable copybot-agent.timer >/dev/null 2>&1
systemctl restart copybot-agent.timer
command -v pm2 >/dev/null && pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
systemctl start copybot-agent.service || true
echo ""
systemctl list-timers copybot-agent.timer --no-pager | head -3
echo
echo "--- agent log ---"
: > /root/copybot-agent.log; systemctl start copybot-agent.service; tail -n 15 /root/copybot-agent.log; echo "(empty above = good)"
echo ""
systemctl is-active copybot-agent.timer >/dev/null && echo "ALL SET (timer running). You can close this window." || echo "TIMER NOT RUNNING, send Claude a screenshot"
