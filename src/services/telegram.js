'use strict';
// Telegram Bot API. Students link their account with a one-time code: they open t.me/<bot>?start=<code>, the bot
// receives "/start <code>" through getUpdates (polled by the scheduler) and saves the chat ID. Nobody has to look up an ID.
const { config } = require('../config');
const db = require('../db');
const log = require('../logger');

let me = null;
let offset = 0;
let warned409 = false;

async function call(method, body = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { const e = new Error(j.description || `Telegram HTTP ${r.status}`); e.code = j.error_code || r.status; throw e; }
    return j.result;
  } finally { clearTimeout(t); }
}

// { configured, ok, username, error }
async function botInfo(force = false) {
  if (!config.telegramToken) return { configured: false, ok: false, error: 'No bot token set' };
  if (me && !force) return me;
  try {
    const r = await call('getMe');
    me = { configured: true, ok: true, username: r.username, name: r.first_name };
  } catch (e) {
    return { configured: true, ok: false, error: e.name === 'AbortError' ? 'Cannot reach Telegram (network blocked?)' : e.message };
  }
  return me;
}

// Returns 'Sent' | 'Failed' | 'Skipped'
async function sendMessage(chatId, text) {
  if (!config.telegramToken || !chatId) return 'Skipped';
  try { await call('sendMessage', { chat_id: chatId, text }, 5000); return 'Sent'; }
  catch (e) { log.warn('telegram_send_failed', { msg: e.message }); return 'Failed'; }
}

async function handle(msg) {
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/);
  if (start) {
    const code = start[1];
    if (code && /^[A-Za-z0-9]{6,16}$/.test(code)) {
      const row = await db.one('SELECT c.user_id, u.full_name FROM telegram_link_codes c JOIN users u ON u.user_id = c.user_id WHERE c.code = ? AND c.expires_at > NOW()', [code]);
      if (!row) return sendMessage(chatId, 'This link has expired. Go back to the website, open Profile > Telegram and press "Link Telegram" again.');
      await db.q('UPDATE users SET telegram_chat_id = ? WHERE user_id = ?', [chatId, row.user_id]);
      await db.q('DELETE FROM telegram_link_codes WHERE user_id = ?', [row.user_id]);
      return sendMessage(chatId, `Linked! Hi ${row.full_name}, you will now get booking confirmations and "court is ready" alerts here.`);
    }
    return sendMessage(chatId, `Hi! This is the UTeM Smart Sports bot.\nYour chat ID is ${chatId}.\nTo link your account, use the "Link Telegram" button on the website (Profile > Telegram).`);
  }
  if (/^\/id\b/.test(text)) return sendMessage(chatId, `Your chat ID is ${chatId}`);
  return sendMessage(chatId, 'I send booking alerts. Commands: /start to begin, /id to see your chat ID.');
}

// Called by the scheduler (one web server at a time). Telegram keeps unread messages for 24 hours.
async function pollUpdates() {
  if (!config.telegramToken) return;
  try {
    const updates = await call('getUpdates', { offset, timeout: 0, allowed_updates: ['message'] }, 6000);
    for (const u of updates) { offset = u.update_id + 1; await handle(u.message).catch((e) => log.warn('telegram_handle_failed', { msg: e.message })); }
    warned409 = false;
  } catch (e) {
    if (e.code === 409 && !warned409) { warned409 = true; log.warn('telegram_conflict', { msg: 'A webhook is set for this bot. Remove it: https://api.telegram.org/bot<TOKEN>/deleteWebhook' }); }
    else if (e.code !== 409) throw e;
  }
}

module.exports = { botInfo, sendMessage, pollUpdates };
