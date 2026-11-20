# Telegram setup (administrator, once) and how students link it

## A. Create the bot (5 minutes, administrator)
1. Open Telegram and search for **@BotFather**. Press Start.
2. Send `/newbot`. Give it a name (for example `UTeM Smart Sports`) and a username that ends in `bot` (for example `utem_smart_sports_bot`).
3. BotFather replies with a **token** that looks like `123456789:AAH...`. Keep it secret.
4. Put the token in your settings:
   - **On your laptop:** open `.env` and set `TELEGRAM_BOT_TOKEN=123456789:AAH...` (no spaces, no quotes needed). Stop the app (Ctrl+C) and run `npm start` again.
   - **On AWS:** Secrets Manager > `smartsports/app` > Retrieve secret value > Edit > set `TELEGRAM_BOT_TOKEN`. Then restart the servers (`aws autoscaling start-instance-refresh ...`).
5. Check it works: `npm run telegram:check`. It prints the bot name, or tells you why it fails.
6. In the website, log in as admin and open **Monitoring**. The "Telegram bot" card should show `@your_bot_username`.

## B. Students link Telegram (no chat ID needed)
1. Create a free Telegram account on your phone (the website tells you to do this before booking).
2. Log in on the website. A window "Set up Telegram before you book" opens. (You can also open **Profile > Telegram alerts** at any time.)
3. Press the green **Open @bot in Telegram** button, then press **Start** in Telegram.
4. Within a few seconds the website shows "Telegram linked", and the bot sends you "Linked!".
5. Press **Send a test message** in your profile to check.

## C. How to find your Telegram chat ID (only if the green button does not work)
- Search for **@userinfobot** in Telegram, press Start. It answers with `Id: 123456789`. Type that number in the box under "The button does not work?".
- Or send `/start` or `/id` to our own bot. It replies with your chat ID.
- You must press **Start** in our bot at least once, because a bot is not allowed to message someone who never started it.

## D. If it does not work
| Problem | Fix |
|---|---|
| Monitoring shows "Telegram bot: Not set up" | `TELEGRAM_BOT_TOKEN` is empty. See A4. |
| `npm run telegram:check` says it cannot reach Telegram | Your Wi-Fi blocks `api.telegram.org`. Try a phone hotspot. |
| The token is refused | Copy it again from BotFather. If you leaked it, send `/revoke` to BotFather and make a new one. |
| The button opens Telegram but nothing links | Wait 15 seconds (the server checks Telegram every 15 seconds). Make sure you pressed Start and the link is less than 10 minutes old. |
| Log says `telegram_conflict` | A webhook is set on the bot. Open `https://api.telegram.org/bot<TOKEN>/deleteWebhook` once. |
| Messages are not arriving but linking worked | The student blocked the bot, or pressed Stop. Ask them to press Start again. |
