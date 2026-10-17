# copybot

Mirrors one Solana wallet's buys and sells through Jupiter (covers pump.fun, PumpSwap, Raydium, Meteora).

## Commands (run inside the copybot folder)
- `npm run check` test keys + show the target's recent trades
- `npm run wallet` create the trading wallet (key goes into .env, never printed)
- `pm2 start src/bot.js --name copybot` start it 24/7
- `pm2 logs copybot` watch it live (Ctrl+C to exit, bot keeps running)
- `npm run stats` PnL, win rate, last trades
- `pm2 restart copybot` after editing .env
- `pm2 stop copybot` stop it

All settings live in `.env`. `PAPER=true` means fake trades at real prices.
