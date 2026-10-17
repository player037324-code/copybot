# copybot

Solana copytrade bot running on the Vultr box.

- `app/` the bot. Pushing changes here redeploys it within a minute.
- `control/cmd.txt` commands for the server (`check`, `wallet`, `start`, `stop`, `restart`, `stats`, `set KEY=VALUE`). Bump the `id:` line to run again.
- `status/` written by the server every minute: `status.txt`, `log.txt`, `trades.jsonl`, `cmd_output.txt`.

API keys and the wallet key live only in `/root/copybot/.env` on the server and are never pushed.
