#!/usr/bin/env bash
# Runs every minute from cron on the Vultr server.
# 1) pulls latest code from GitHub and redeploys the bot if it changed
# 2) runs whatever command is in control/cmd.txt (once per id)
# 3) pushes status (pm2 state, recent logs, stats, settings) back to GitHub
# Secrets (.env keys) never leave the server.
set -u
export PATH=/usr/local/bin:/usr/bin:/bin:$PATH HOME=/root
export GIT_SSH_COMMAND="ssh -i /root/.ssh/copybot_deploy -o StrictHostKeyChecking=accept-new"
REPO=/root/copybot-ops
APP=/root/copybot
exec 9>/tmp/copybot-agent.lock; flock -n 9 || exit 0

cd "$REPO" || exit 1
git fetch -q origin main && git reset -q --hard origin/main

redact() {
  # strip api keys / private key from anything we push
  local s; s=$(cat)
  for k in HELIUS_API_KEY JUP_API_KEY PRIVATE_KEY; do
    v=$(grep -E "^$k=" "$APP/.env" 2>/dev/null | cut -d= -f2-)
    [ -n "$v" ] && s=${s//"$v"/REDACTED}
  done
  printf '%s\n' "$s" | sed -E 's/api-key=[A-Za-z0-9-]+/api-key=REDACTED/g'
}

# ---------- 1. deploy ----------
mkdir -p "$APP"
HASH=$(git rev-parse HEAD:app)
if [ "$HASH" != "$(cat "$APP/.deployed" 2>/dev/null)" ]; then
  (cd "$REPO/app" && tar -cf - .) | (cd "$APP" && tar -xf -)
  [ -f "$APP/.env" ] || cp "$APP/.env.example" "$APP/.env"
  chmod 600 "$APP/.env"
  (cd "$APP" && npm install --omit=dev --silent >/dev/null 2>&1)
  pm2 describe copybot >/dev/null 2>&1 && pm2 restart copybot >/dev/null 2>&1
  echo "$HASH" > "$APP/.deployed"
fi

# ---------- 2. commands ----------
# control/cmd.txt: first line "id: <unique>", following lines one command each
OUT="$REPO/status/cmd_output.txt"
if [ -f control/cmd.txt ]; then
  ID=$(sed -n 's/^id: *//p' control/cmd.txt | head -1)
  if [ -n "$ID" ] && [ "$ID" != "$(cat /root/.copybot_last_cmd 2>/dev/null)" ]; then
    echo "$ID" > /root/.copybot_last_cmd
    {
      echo "=== cmd $ID @ $(date -u +%FT%TZ) ==="
      grep -v '^id:' control/cmd.txt | grep -v '^\s*$' | while read -r c; do
        echo "> $c"
        cd "$APP"
        case "$c" in
          check)    timeout 90 npm run -s check 2>&1 ;;
          wallet)   timeout 30 npm run -s wallet 2>&1 ;;
          wallet-force) timeout 30 npm run -s wallet -- --force 2>&1 ;;
          wallet-restore)
            # put back the most recent backed-up key (current one gets backed up first)
            f=$(ls -t wallet-backup-*.txt 2>/dev/null | head -1)
            if [ -z "$f" ]; then echo "no backup found"
            else
              cur=$(grep '^PRIVATE_KEY=' .env)
              [ -n "${cur#PRIVATE_KEY=}" ] && { echo "$cur" > "wallet-backup-$(date +%s%3N).txt"; chmod 600 wallet-backup-*.txt; }
              old=$(grep '^PRIVATE_KEY=' "$f" | head -1)
              sed -i "s|^PRIVATE_KEY=.*|$old|" .env
              echo "restored key from $f"
            fi ;;
          inspect)  timeout 120 node scripts/inspect.js 2>&1 ;;
          watch)    timeout 160 node scripts/watch.js 2>&1 ;;
          stats)    npm run -s stats 2>&1 ;;
          papertest) mkdir -p /root/copybot/papertest-logs; PAPER=true LOG_DIR=/root/copybot/papertest-logs timeout 130 node src/bot.js 2>&1 | tail -n 60 ;;
          start)    pm2 describe copybot >/dev/null 2>&1 && pm2 restart copybot || pm2 start src/bot.js --name copybot; pm2 save >/dev/null ;;
          stop)     pm2 stop copybot; pm2 save >/dev/null ;;
          restart)  pm2 restart copybot ;;
          reset-positions) cp logs/positions.json "logs/positions.bak.$(date +%s).json" 2>/dev/null; echo '{}' > logs/positions.json; echo cleared ;;
          set\ *)
            kv=${c#set }; k=${kv%%=*}; v=${kv#*=}
            if [[ "$k" =~ ^(HELIUS_API_KEY|JUP_API_KEY|PRIVATE_KEY)$ ]]; then echo "refused: secrets are only edited on the server"
            elif [[ "$k" =~ ^[A-Z_]+$ ]] && grep -q "^$k=" .env; then sed -i "s|^$k=.*|$k=$v|" .env; echo "set $k=$v"
            elif [[ "$k" =~ ^[A-Z_]+$ ]]; then echo "$k=$v" >> .env; echo "added $k=$v"
            else echo "bad key"; fi ;;
          *) echo "unknown command" ;;
        esac
        cd "$REPO"
      done
      echo
    } 2>&1 | redact >> "$OUT"
    tail -n 400 "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
  fi
fi

# ---------- 3. status ----------
mkdir -p status
{
  echo "updated: $(date -u +%FT%TZ)"
  echo "deployed: $(cat "$APP/.deployed" 2>/dev/null)"
  echo "pm2: $(pm2 jlist 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const p=JSON.parse(d).find(x=>x.name==="copybot");console.log(p?`${p.pm2_env.status} uptime=${Math.round((Date.now()-p.pm2_env.pm_uptime)/60000)}m restarts=${p.pm2_env.restart_time}`:"not started")}catch{console.log("pm2 n/a")}})')"
  echo "wallet: $(cd "$APP" && node -e 'import("dotenv/config").then(async()=>{const k=process.env.PRIVATE_KEY;if(!k)return console.log("none");const bs58=(await import("bs58")).default;const {Keypair}=await import("@solana/web3.js");console.log(Keypair.fromSecretKey(bs58.decode(k)).publicKey.toBase58())}).catch(()=>console.log("error"))' 2>/dev/null)"
  echo
  echo "--- settings (secrets hidden) ---"
  grep -E '^[A-Z_]+=' "$APP/.env" | sed -E 's/^(HELIUS_API_KEY|JUP_API_KEY|PRIVATE_KEY)=.+/\1=<set>/'
  echo
  echo "--- stats ---"
  (cd "$APP" && npm run -s stats 2>&1)
  echo
  echo "--- positions ---"
  cat "$APP/logs/positions.json" 2>/dev/null || echo "{}"
} 2>&1 | redact > status/status.txt
pm2 logs copybot --nostream --lines 200 --raw 2>/dev/null | redact > status/log.txt
cp "$APP/logs/trades.jsonl" status/trades.jsonl 2>/dev/null

git add status
if ! git diff --cached --quiet; then
  git -c user.name=copybot-vultr -c user.email=copybot@localhost commit -qm "status $(date -u +%H:%M)"
  git push -q origin main 2>/dev/null || { git pull -q --rebase origin main && git push -q origin main; }
fi
