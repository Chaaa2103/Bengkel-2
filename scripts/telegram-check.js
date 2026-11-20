'use strict';
// node scripts/telegram-check.js  -> tells you whether the bot token works and what the bot is called.
require('dotenv').config();
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('TELEGRAM_BOT_TOKEN is empty. Put the token from @BotFather in your .env file, then restart.'); process.exit(1); }
fetch(`https://api.telegram.org/bot${token}/getMe`).then((r) => r.json()).then((j) => {
  if (j.ok) console.log(`OK. The bot is @${j.result.username}. Students link by opening https://t.me/${j.result.username}`);
  else console.error('Telegram refused the token:', j.description);
}).catch((e) => { console.error('Cannot reach Telegram:', e.message, '\nYour network may block api.telegram.org. Try a phone hotspot.'); process.exit(1); });
