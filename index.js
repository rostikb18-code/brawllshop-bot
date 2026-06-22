require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SHOP_EMAIL_ADDRESS = process.env.SHOP_EMAIL;

// =====================
// БАЗА ДАННЫХ
// =====================
const db = new Database('./shop.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    trophies INTEGER NOT NULL,
    fighters INTEGER NOT NULL,
    price INTEGER NOT NULL,
    rent_price_day INTEGER DEFAULT 0,
    rent_price_week INTEGER DEFAULT 0,
    year INTEGER NOT NULL,
    image_url TEXT NOT NULL,
    sold INTEGER DEFAULT 0,
    rented INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    buyer_chat_id TEXT NOT NULL,
    buyer_name TEXT NOT NULL,
    email TEXT,
    account_id TEXT,
    account_title TEXT,
    price INTEGER,
    type TEXT DEFAULT 'buy',
    rent_days INTEGER DEFAULT 0,
    rent_until TEXT,
    status TEXT DEFAULT 'pending',
    code TEXT,
    referred_by TEXT,
    discount INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    chat_id TEXT PRIMARY KEY,
    username TEXT,
    ref_code TEXT UNIQUE,
    referred_by TEXT,
    discount INTEGER DEFAULT 0,
    orders_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    buyer_chat_id TEXT NOT NULL,
    buyer_name TEXT,
    stars INTEGER NOT NULL,
    text TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS spam_log (
    chat_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    chat_id TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Миграции
try { db.exec(`ALTER TABLE accounts ADD COLUMN rent_price_day INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE accounts ADD COLUMN rent_price_week INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE accounts ADD COLUMN rented INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN type TEXT DEFAULT 'buy'`); } catch(e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN rent_days INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN rent_until TEXT`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS admin_sessions (chat_id TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')))`); } catch(e) {}

// Стартовый аккаунт
const existingAccounts = db.prepare('SELECT COUNT(*) as count FROM accounts').get();
if (existingAccounts.count === 0) {
  db.prepare(`
    INSERT INTO accounts (id, title, trophies, fighters, price, rent_price_day, rent_price_week, year, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('acc-29444', 'Brawl Stars — 29 444 кубка', 29444, 65, 800, 100, 500, 2024,
    'https://i.ibb.co/qYT3zH2F/photo-2026-06-20-23-05-47.jpg');
}

// =====================
// DB HELPERS
// =====================
const accountsDb = {
  getAll() {
    return db.prepare('SELECT * FROM accounts WHERE sold = 0 ORDER BY created_at ASC').all();
  },
  getAllIncludingSold() {
    return db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
  },
  getById(id) {
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) || null;
  },
  add(account) {
    db.prepare(`
      INSERT INTO accounts (id, title, trophies, fighters, price, rent_price_day, rent_price_week, year, image_url)
      VALUES (@id, @title, @trophies, @fighters, @price, @rent_price_day, @rent_price_week, @year, @image_url)
    `).run(account);
  },
  markSold(id) {
    db.prepare('UPDATE accounts SET sold = 1, rented = 0 WHERE id = ?').run(id);
  },
  setRented(id, rented) {
    db.prepare('UPDATE accounts SET rented = ? WHERE id = ?').run(rented ? 1 : 0, id);
  },
  delete(id) {
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  },
};

const ordersDb = {
  create(order) {
    db.prepare(`
      INSERT INTO orders (order_id, buyer_chat_id, buyer_name, account_id, account_title, price, type, rent_days, rent_until, referred_by, discount)
      VALUES (@order_id, @buyer_chat_id, @buyer_name, @account_id, @account_title, @price, @type, @rent_days, @rent_until, @referred_by, @discount)
    `).run(order);
  },
  get(orderId) {
    return db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) || null;
  },
  getAll() {
    return db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  },
  getRecent(limit = 20) {
    return db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit);
  },
  getActive() {
    return db.prepare(
      "SELECT * FROM orders WHERE status NOT IN ('fulfilled','rejected','cancelled') ORDER BY created_at ASC"
    ).all();
  },
  getByChatId(chatId) {
    return db.prepare('SELECT * FROM orders WHERE buyer_chat_id = ? ORDER BY created_at DESC').all(chatId);
  },
  update(orderId, fields) {
    const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE orders SET ${sets}, updated_at = datetime('now') WHERE order_id = @order_id`)
      .run({ ...fields, order_id: orderId });
  },
  hasPendingOrder(chatId) {
    return !!db.prepare(
      "SELECT 1 FROM orders WHERE buyer_chat_id = ? AND status IN ('pending','confirmed','code_received') LIMIT 1"
    ).get(chatId);
  },
  getExpiredRentals() {
    return db.prepare(
      "SELECT * FROM orders WHERE type = 'rent' AND status = 'fulfilled' AND rent_until < datetime('now')"
    ).all();
  },
  getStats() {
    const today = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(price - discount), 0) as revenue
      FROM orders WHERE status = 'fulfilled' AND date(created_at) = date('now')
    `).get();
    const week = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(price - discount), 0) as revenue
      FROM orders WHERE status = 'fulfilled' AND created_at >= datetime('now', '-7 days')
    `).get();
    const total = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(price - discount), 0) as revenue
      FROM orders WHERE status = 'fulfilled'
    `).get();
    const pending = db.prepare(
      "SELECT COUNT(*) as count FROM orders WHERE status = 'pending'"
    ).get();
    const rentActive = db.prepare(
      "SELECT COUNT(*) as count FROM orders WHERE type = 'rent' AND status = 'fulfilled' AND rent_until > datetime('now')"
    ).get();
    return { today, week, total, pending, rentActive };
  },
};

const usersDb = {
  get(chatId) {
    return db.prepare('SELECT * FROM users WHERE chat_id = ?').get(chatId) || null;
  },
  getByRefCode(refCode) {
    return db.prepare('SELECT * FROM users WHERE ref_code = ?').get(refCode) || null;
  },
  upsert(chatId, username) {
    const existing = this.get(chatId);
    if (existing) return existing;
    const refCode = 'REF' + Math.random().toString(36).slice(2, 8).toUpperCase();
    db.prepare('INSERT OR IGNORE INTO users (chat_id, username, ref_code) VALUES (?, ?, ?)').run(chatId, username || null, refCode);
    return this.get(chatId);
  },
  setReferredBy(chatId, referrerChatId) {
    db.prepare('UPDATE users SET referred_by = ? WHERE chat_id = ? AND referred_by IS NULL').run(referrerChatId, chatId);
  },
  addDiscount(chatId, amount) {
    db.prepare('UPDATE users SET discount = discount + ? WHERE chat_id = ?').run(amount, String(chatId));
  },
  incrementOrders(chatId) {
    db.prepare('UPDATE users SET orders_count = orders_count + 1 WHERE chat_id = ?').run(chatId);
  },
};

const reviewsDb = {
  add(review) {
    db.prepare('INSERT INTO reviews (order_id, buyer_chat_id, buyer_name, stars, text) VALUES (@order_id, @buyer_chat_id, @buyer_name, @stars, @text)').run(review);
  },
  getAll() {
    return db.prepare('SELECT * FROM reviews ORDER BY created_at DESC').all();
  },
  hasReview(orderId) {
    return !!db.prepare('SELECT 1 FROM reviews WHERE order_id = ?').get(orderId);
  },
  getStats() {
    return db.prepare('SELECT COUNT(*) as count, AVG(stars) as avg FROM reviews').get();
  },
};

const spamDb = {
  check(chatId, action, limitCount, windowMinutes) {
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM spam_log
      WHERE chat_id = ? AND action = ? AND created_at >= datetime('now', '-${windowMinutes} minutes')
    `).get(chatId, action);
    return row.count >= limitCount;
  },
  log(chatId, action) {
    db.prepare('INSERT INTO spam_log (chat_id, action) VALUES (?, ?)').run(chatId, action);
  },
  cleanup() {
    db.prepare("DELETE FROM spam_log WHERE created_at < datetime('now', '-1 day')").run();
  },
};

// =====================
// ADMIN SESSIONS (хранятся в БД — не слетают при рестарте)
// =====================
const adminSessionsDb = {
  isVerified(chatId) {
    return !!db.prepare('SELECT 1 FROM admin_sessions WHERE chat_id = ?').get(String(chatId));
  },
  add(chatId) {
    db.prepare('INSERT OR REPLACE INTO admin_sessions (chat_id) VALUES (?)').run(String(chatId));
  },
  remove(chatId) {
    db.prepare('DELETE FROM admin_sessions WHERE chat_id = ?').run(String(chatId));
  },
};

setInterval(() => spamDb.cleanup(), 60 * 60 * 1000);

// =====================
// GMAIL IMAP — ИСПРАВЛЕННАЯ ВЕРСИЯ
// Ищет за 2 часа (не только UNSEEN), проверяет INBOX + All Mail
// =====================
function getSupercellCode() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: process.env.SHOP_EMAIL,
      password: process.env.SHOP_EMAIL_APP_PASSWORD,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000,
    });

    let resolved = false;

    function done(err, value) {
      if (resolved) return;
      resolved = true;
      try { imap.end(); } catch (e) {}
      if (err) reject(err);
      else resolve(value);
    }

    // Парсим письмо и извлекаем код
    function parseAndExtractCode(stream) {
      return new Promise((res, rej) => {
        simpleParser(stream, (err, parsed) => {
          if (err) return rej(err);

          const subject = parsed.subject || '';
          const text = parsed.text || '';
          const html = parsed.html || '';
          const fullText = text + ' ' + html;

          console.log('[Gmail] Subject:', subject);
          console.log('[Gmail] Text preview:', text.slice(0, 400));

          // Опасные письма — пропускаем
          const isDangerous =
            subject.toLowerCase().includes('смену адреса') ||
            subject.toLowerCase().includes('смену электронной') ||
            fullText.includes('смену адреса электронной почты') ||
            fullText.includes('запрос на смену') ||
            fullText.includes('изменить адрес электронной почты') ||
            fullText.includes('change your email');

          if (isDangerous) {
            return rej(new Error('⛔ Это письмо о смене почты — код не выдаётся в целях безопасности.'));
          }

          // Ищем 6-значный код всеми способами
          // Способ 1: обычный блок из 6 цифр
          let codeMatch = fullText.match(/\b(\d{6})\b/);

          // Способ 2: цифры через пробел "1 2 3 4 5 6"
          if (!codeMatch) {
            const spaced = fullText.match(/(\d)\s(\d)\s(\d)\s(\d)\s(\d)\s(\d)/);
            if (spaced) codeMatch = [spaced[0]];
          }

          // Способ 3: через дефис или пробел "123 456" или "123-456"
          if (!codeMatch) {
            const dashed = fullText.match(/(\d{3})[\s\-](\d{3})/);
            if (dashed) codeMatch = [dashed[0]];
          }

          console.log('[Gmail] codeMatch:', codeMatch ? codeMatch[0] : 'не найден');

          if (!codeMatch) {
            return rej(new Error('🔍 Код не найден в письме. Подождите 1-2 минуты и нажмите снова.'));
          }

          const code = codeMatch[0].replace(/\D/g, '');

          if (code.length !== 6) {
            return rej(new Error('🔍 Код не найден в письме. Подождите 1-2 минуты и нажмите снова.'));
          }

          console.log('[Gmail] Итоговый код:', code);
          res(code);
        });
      });
    }

    // Читаем последнее письмо из результатов поиска
    function fetchLatest(results, callback) {
      const latest = [results[results.length - 1]];
      console.log('[Gmail] Читаем письмо UID:', latest[0]);

      const fetch = imap.fetch(latest, { bodies: '' });
      let fetched = false;

      fetch.on('message', (msg) => {
        fetched = true;
        msg.on('body', async (stream) => {
          try {
            const code = await parseAndExtractCode(stream);
            // Помечаем прочитанным
            try { imap.addFlags(latest, '\\Seen', () => {}); } catch(e) {}
            callback(null, code);
          } catch (err) {
            callback(err);
          }
        });
      });

      fetch.once('error', (err) => callback(err));

      fetch.once('end', () => {
        if (!fetched) callback(new Error('❓ Не удалось прочитать письмо. Попробуйте ещё раз.'));
      });
    }

    // Ищем в папке
    function searchInBox(boxName, callback) {
      imap.openBox(boxName, false, (err) => {
        if (err) {
          console.log(`[Gmail] Не удалось открыть папку ${boxName}:`, err.message);
          return callback(null, []);
        }

        // Ищем за последние 2 часа — БЕЗ UNSEEN
        const since = new Date(Date.now() - 2 * 60 * 60 * 1000);

        imap.search(
          [['FROM', 'no-reply@supercell.com'], ['SINCE', since]],
          (err, results) => {
            if (err) {
              console.log(`[Gmail] Ошибка поиска в ${boxName}:`, err.message);
              return callback(null, []);
            }
            console.log(`[Gmail] Папка ${boxName}: найдено ${results ? results.length : 0} писем`);
            callback(null, results || []);
          }
        );
      });
    }

    imap.once('ready', () => {
      console.log('[Gmail] Подключились к IMAP');

      // Сначала ищем в INBOX
      searchInBox('INBOX', (err, inboxResults) => {
        if (inboxResults && inboxResults.length > 0) {
          fetchLatest(inboxResults, (err, code) => {
            if (err) return done(err);
            done(null, code);
          });
          return;
        }

        // Если в INBOX нет — ищем в All Mail
        console.log('[Gmail] В INBOX не найдено, проверяем All Mail...');
        searchInBox('[Gmail]/All Mail', (err2, allMailResults) => {
          if (!allMailResults || allMailResults.length === 0) {
            return done(new Error(
              '📭 Письмо от Supercell не найдено.\n\n' +
              'Убедитесь что:\n' +
              '1. Нажали "Отправить код" в игре\n' +
              '2. Ввели правильную почту магазина\n' +
              '3. Подождите 1-2 минуты и попробуйте снова'
            ));
          }

          fetchLatest(allMailResults, (err2, code) => {
            if (err2) return done(err2);
            done(null, code);
          });
        });
      });
    });

    imap.once('error', (err) => {
      console.error('[Gmail] IMAP connection error:', err.message);
      done(new Error('❌ Ошибка подключения к Gmail: ' + err.message));
    });

    imap.once('end', () => {
      if (!resolved) {
        done(new Error('❓ Соединение с Gmail закрыто. Попробуйте ещё раз.'));
      }
    });

    // Таймаут 30 секунд
    const timeout = setTimeout(() => {
      done(new Error('⏱ Превышено время ожидания Gmail. Попробуйте ещё раз.'));
    }, 30000);

    imap.once('ready', () => clearTimeout(timeout));

    imap.connect();
  });
}

// =====================
// УТИЛИТЫ
// =====================
function formatPrice(price) {
  return new Intl.NumberFormat('ru-RU').format(price || 0) + ' ₽';
}

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour12: false });
}

function statusLabel(status) {
  const map = {
    pending: '🟡 Ожидает',
    confirmed: '🔵 Подтверждён',
    code_received: '🟣 Код получен',
    fulfilled: '🟢 Завершён',
    rejected: '🔴 Отклонён',
    cancelled: '⚫ Отменён',
    expired: '🕐 Аренда истекла',
  };
  return map[status] || status;
}

function getUserDiscount(chatId) {
  const user = usersDb.get(String(chatId));
  return user?.discount || 0;
}

function generateOrderId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function rentUntilDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// =====================
// БОТ
// =====================
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const pendingEmailByChatId = new Map();
const pendingMainMsgStore = new Map();
const pendingLastOrderStore = new Map();

const lockMsgStore = new Map();

// isAdmin теперь проверяет БД — не слетает при рестарте
function isAdmin(ctx) {
  return String(ctx.chat?.id) === String(ADMIN_CHAT_ID) && adminSessionsDb.isVerified(ctx.chat?.id);
}

function isAdminChat(ctx) {
  return String(ctx.chat?.id) === String(ADMIN_CHAT_ID);
}

async function goTo(chatId, sess, screen) {
  if (sess.mainMsgId) {
    try { await bot.telegram.deleteMessage(chatId, sess.mainMsgId); } catch (e) {}
    sess.mainMsgId = null;
  }
  let sent;
  if (screen.type === 'photo') {
    sent = await bot.telegram.sendPhoto(chatId, screen.imageUrl, {
      caption: screen.caption,
      parse_mode: 'MarkdownV2',
      reply_markup: screen.keyboard,
    });
  } else {
    sent = await bot.telegram.sendMessage(chatId, screen.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: screen.keyboard,
    });
  }
  sess.mainMsgId = sent.message_id;
}

async function tempMsg(chatId, text, delay = 4000) {
  try {
    const sent = await bot.telegram.sendMessage(chatId, text);
    setTimeout(() => bot.telegram.deleteMessage(chatId, sent.message_id).catch(() => {}), delay);
  } catch (e) {}
}

async function lockMsg(chatId, text) {
  const prevId = lockMsgStore.get(String(chatId));
  if (prevId) {
    try { await bot.telegram.deleteMessage(chatId, prevId); } catch (e) {}
    lockMsgStore.delete(String(chatId));
  }
  try {
    const sent = await bot.telegram.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[{ text: '✖ Закрыть', callback_data: 'close_lock_msg' }]],
      },
    });
    lockMsgStore.set(String(chatId), sent.message_id);
  } catch (e) {}
}

async function deleteLockMsg(chatId) {
  const msgId = lockMsgStore.get(String(chatId));
  if (msgId) {
    try { await bot.telegram.deleteMessage(chatId, msgId); } catch (e) {}
    lockMsgStore.delete(String(chatId));
  }
}

async function notifyAdmin(text, keyboard) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
  } catch (e) { console.warn('Admin notify error:', e.message); }
}

setInterval(async () => {
  const expired = ordersDb.getExpiredRentals();
  for (const order of expired) {
    ordersDb.update(order.order_id, { status: 'expired' });
    accountsDb.setRented(order.account_id, false);
    try {
      await bot.telegram.sendMessage(
        Number(order.buyer_chat_id),
        `⏰ *Аренда завершена\\!*\n\n` +
        `Аккаунт *${escapeMarkdown(order.account_title)}* больше не в вашем распоряжении\\.\n\n` +
        `Хотите продлить или купить насовсем? Напишите @brawlhelpp`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (e) {}
    await notifyAdmin(
      `⏰ *Аренда истекла*\n\n` +
      `Заказ: *\\#${escapeMarkdown(order.order_id)}*\n` +
      `👤 ${escapeMarkdown(order.buyer_name)}\n` +
      `🎮 ${escapeMarkdown(order.account_title)}\n` +
      `📧 ${escapeMarkdown(order.email || '—')}`
    );
  }
}, 10 * 60 * 1000);

// =====================
// ЭКРАНЫ КАТАЛОГА
// =====================
function buildCatalogScreen(index, discount = 0) {
  const accounts = accountsDb.getAll();

  if (accounts.length === 0) {
    return {
      type: 'text',
      text: '😔 *Каталог пуст*\n\nСейчас нет доступных аккаунтов\\.\nЗагляни позже\\.',
      keyboard: { inline_keyboard: [] },
      accountIndex: 0,
    };
  }

  const i = Math.max(0, Math.min(index, accounts.length - 1));
  const account = accounts[i];
  const finalPrice = Math.max(0, account.price - discount);

  let caption =
    `🏆 *${escapeMarkdown(account.title)}*\n\n` +
    `🥇 Кубки: *${account.trophies.toLocaleString('ru-RU')}*\n` +
    `⚔️ Бойцы: *${account.fighters}*\n` +
    `📅 Год: *${account.year}*\n\n`;

  caption += `💰 *Купить:* ${escapeMarkdown(formatPrice(account.price))}`;
  if (discount > 0) {
    caption += ` → *${escapeMarkdown(formatPrice(finalPrice))}* 🎁`;
  }
  caption += '\n';

  if (account.rent_price_day > 0) {
    caption += `📅 *Аренда 1 день:* ${escapeMarkdown(formatPrice(account.rent_price_day))}\n`;
  }
  if (account.rent_price_week > 0) {
    caption += `📆 *Аренда 7 дней:* ${escapeMarkdown(formatPrice(account.rent_price_week))}\n`;
  }

  if (account.rented) {
    caption += `\n⚠️ _Сейчас в аренде_`;
  }

  caption += `\n📦 Аккаунт ${i + 1} из ${accounts.length}`;

  const navRow = [];
  if (i > 0) navRow.push({ text: '◀ Пред.', callback_data: `catalog_${i - 1}` });
  if (i < accounts.length - 1) navRow.push({ text: 'След. ▶', callback_data: `catalog_${i + 1}` });

  const rows = [];
  if (navRow.length > 0) rows.push(navRow);

  if (!account.rented) {
    rows.push([{ text: `🛒 Купить за ${formatPrice(finalPrice)}`, callback_data: `buy_${account.id}` }]);
    if (account.rent_price_day > 0 || account.rent_price_week > 0) {
      rows.push([{ text: `🔑 Арендовать`, callback_data: `rent_${account.id}` }]);
    }
  } else {
    rows.push([{ text: `🛒 Купить за ${formatPrice(finalPrice)}`, callback_data: `buy_${account.id}` }]);
    rows.push([{ text: `⏳ Аренда недоступна`, callback_data: `rent_busy` }]);
  }

  return {
    type: 'photo',
    imageUrl: account.image_url,
    caption,
    keyboard: { inline_keyboard: rows },
    accountId: account.id,
    accountIndex: i,
  };
}

// =====================
// ЭКРАНЫ
// =====================
function screenRentOptions(account) {
  const rows = [];
  if (account.rent_price_day > 0) {
    rows.push([{ text: `📅 1 день — ${formatPrice(account.rent_price_day)}`, callback_data: `rentpay_${account.id}_1` }]);
  }
  if (account.rent_price_week > 0) {
    rows.push([{ text: `📆 7 дней — ${formatPrice(account.rent_price_week)}`, callback_data: `rentpay_${account.id}_7` }]);
  }
  rows.push([{ text: '◀ Назад в каталог', callback_data: 'back_catalog' }]);
  return {
    type: 'text',
    text:
      `🔑 *Аренда аккаунта*\n\n` +
      `🏆 *${escapeMarkdown(account.title)}*\n\n` +
      `Выберите срок аренды:\n\n` +
      (account.rent_price_day > 0 ? `📅 1 день — *${escapeMarkdown(formatPrice(account.rent_price_day))}*\n` : '') +
      (account.rent_price_week > 0 ? `📆 7 дней — *${escapeMarkdown(formatPrice(account.rent_price_week))}*\n` : '') +
      `\n⚠️ _Аккаунт будет доступен только на выбранный срок_`,
    keyboard: { inline_keyboard: rows },
  };
}

function screenRentPayment(account, days, price) {
  const label = days === 1 ? '1 день' : `${days} дней`;
  return {
    type: 'text',
    text:
      `💳 *Оплата аренды*\n\n` +
      `🏆 *${escapeMarkdown(account.title)}*\n` +
      `⏱ Срок: *${escapeMarkdown(label)}*\n` +
      `💰 Сумма: *${escapeMarkdown(formatPrice(price))}*\n\n` +
      `📱 *Реквизиты СБП:*\n` +
      `📞 Номер: *\\+7 902 917\\-54\\-45*\n\n` +
      `Переведите сумму, затем нажмите кнопку 👇`,
    keyboard: {
      inline_keyboard: [
        [{ text: '✅ Я оплатил', callback_data: `rentpaid_${account.id}_${days}` }],
        [{ text: '◀ Назад', callback_data: `rent_${account.id}` }],
      ],
    },
  };
}

function screenRentEnterShopEmail(accountTitle, orderId) {
  return {
    type: 'text',
    text:
      `✅ *Оплата подтверждена\\!*\n\n` +
      `🏆 *${escapeMarkdown(accountTitle)}*\n\n` +
      `Теперь выполните следующие шаги:\n\n` +
      `1️⃣ Откройте Brawl Stars\n` +
      `2️⃣ Настройки → Supercell ID\n` +
      `3️⃣ Введите эту почту:\n\n` +
      `📧 \`${escapeMarkdown(SHOP_EMAIL_ADDRESS)}\`\n\n` +
      `4️⃣ Нажмите *"Отправить код"* в игре\n` +
      `5️⃣ Затем нажмите кнопку ниже 👇`,
    keyboard: {
      inline_keyboard: [
        [{ text: '📨 Я нажал — получить код', callback_data: `getrentcode_${orderId}` }],
      ],
    },
  };
}

function screenPayment(account, finalPrice, type = 'buy', days = 0) {
  const label = type === 'rent' ? (days === 1 ? '1 день' : `${days} дней`) : null;
  return {
    type: 'text',
    text:
      `💳 *Оплата ${type === 'rent' ? 'аренды' : 'заказа'}*\n\n` +
      `🎮 Аккаунт: *${escapeMarkdown(account.title)}*\n` +
      (label ? `⏱ Срок аренды: *${escapeMarkdown(label)}*\n` : '') +
      `💰 Сумма к оплате: *${escapeMarkdown(formatPrice(finalPrice))}*\n\n` +
      `📱 *Реквизиты СБП:*\n` +
      `📞 Номер: *\\+7 902 917\\-54\\-45*\n\n` +
      `Переведите сумму, затем нажмите кнопку 👇`,
    keyboard: {
      inline_keyboard: [
        [{ text: '✅ Я оплатил', callback_data: `paid_${account.id}` }],
        [{ text: '◀ Назад в каталог', callback_data: 'back_catalog' }],
      ],
    },
  };
}

function screenEnterName(account, finalPrice, type = 'buy', days = 0) {
  const label = type === 'rent' ? (days === 1 ? '1 день' : `${days} дней`) : null;
  return {
    type: 'text',
    text:
      `✍️ *Введите ваше имя*\n\n` +
      `Напишите *полное имя и первую букву фамилии*\n` +
      `_Например: Александр К_\n\n` +
      `⚠️ Укажите имя точно как в банке при переводе\\.\n\n` +
      `💰 Сумма: *${escapeMarkdown(formatPrice(finalPrice))}*\n` +
      (label ? `⏱ Срок: *${escapeMarkdown(label)}*\n` : '') +
      `📞 На номер: *\\+7 902 917\\-54\\-45*`,
    keyboard: {
      inline_keyboard: [
        [{ text: '◀ Назад к оплате', callback_data: `back_payment_${account.id}` }],
      ],
    },
  };
}

function screenWaiting(orderId, buyerName, type = 'buy') {
  return {
    type: 'text',
    text:
      `⏳ *Ожидайте подтверждения*\n\n` +
      `Заказ: *\\#${escapeMarkdown(orderId)}*\n` +
      `Имя: *${escapeMarkdown(buyerName)}*\n` +
      `Тип: *${type === 'rent' ? 'Аренда' : 'Покупка'}*\n\n` +
      `Продавец проверяет ваш перевод по имени\\.\n` +
      `Как только оплата подтвердится — бот сообщит вам\\.`,
    keyboard: {
      inline_keyboard: [
        [{ text: '◀ Отменить заказ', callback_data: `cancel_${orderId}` }],
      ],
    },
  };
}

function screenEnterCode(email) {
  return {
    type: 'text',
    text:
      `📬 *Проверьте почту\\!*\n\n` +
      `На адрес *${escapeMarkdown(email)}* пришло письмо с кодом\\.\n\n` +
      `Введите *6\\-значный код* прямо сюда в чат:`,
    keyboard: { inline_keyboard: [] },
  };
}

function screenCodeWaiting() {
  return {
    type: 'text',
    text:
      `⏳ *Код принят\\!*\n\n` +
      `Продавец проверяет код и завершает передачу аккаунта\\.\n` +
      `Пожалуйста, подождите\\.\\.\\.`,
    keyboard: { inline_keyboard: [] },
  };
}

function screenLeaveReview() {
  return {
    type: 'text',
    text: `⭐ *Оставьте отзыв*\n\nВыберите оценку:`,
    keyboard: {
      inline_keyboard: [
        [
          { text: '⭐', callback_data: 'review_1' },
          { text: '⭐⭐', callback_data: 'review_2' },
          { text: '⭐⭐⭐', callback_data: 'review_3' },
          { text: '⭐⭐⭐⭐', callback_data: 'review_4' },
          { text: '⭐⭐⭐⭐⭐', callback_data: 'review_5' },
        ],
        [{ text: 'Пропустить', callback_data: 'skip_review' }],
      ],
    },
  };
}

function screenReviewText(stars) {
  return {
    type: 'text',
    text:
      `${'⭐'.repeat(stars)}\n\n` +
      `Напишите короткий отзыв о покупке\\.\n` +
      `_Или нажмите "Пропустить"_`,
    keyboard: {
      inline_keyboard: [[{ text: 'Пропустить', callback_data: 'skip_review' }]],
    },
  };
}

function screenReviewDone() {
  return {
    type: 'text',
    text: `✅ *Спасибо за отзыв\\!*\n\nЭто помогает нам становиться лучше 🙏`,
    keyboard: {
      inline_keyboard: [[{ text: '🏠 В каталог', callback_data: 'back_catalog' }]],
    },
  };
}

// =====================
// РЕГИСТРАЦИЯ КОМАНД
// =====================
bot.telegram.setMyCommands([
  { command: 'start', description: '🏠 Главное меню' },
  { command: 'catalog', description: '📋 Каталог аккаунтов' },
  { command: 'ref', description: '🔗 Моя реферальная ссылка' },
  { command: 'myorders', description: '📦 Мои заказы' },
  { command: 'help', description: '❓ Помощь' },
]).catch(e => console.warn('setMyCommands error:', e.message));

bot.telegram.setMyCommands([
  { command: 'start', description: '🏠 Главное меню' },
  { command: 'catalog', description: '📋 Каталог аккаунтов' },
  { command: 'ref', description: '🔗 Моя реферальная ссылка' },
  { command: 'myorders', description: '📦 Мои заказы' },
  { command: 'help', description: '❓ Помощь' },
  { command: 'login', description: '🔐 Войти как администратор' },
  { command: 'logout', description: '🚪 Выйти из администратора' },
  { command: 'orders', description: '📋 Все заказы' },
  { command: 'stats', description: '📊 Статистика' },
  { command: 'reviews', description: '⭐ Отзывы' },
  { command: 'accounts', description: '🗂 Все аккаунты' },
], {
  scope: { type: 'chat', chat_id: Number(ADMIN_CHAT_ID) },
}).catch(e => console.warn('setMyCommands admin error:', e.message));

// =====================
// СТАРТ
// =====================
bot.start(async (ctx) => {
  ctx.session = ctx.session || {};
  const chatId = String(ctx.chat.id);
  const username = ctx.from?.username || null;

  usersDb.upsert(chatId, username);

  const startPayload = ctx.startPayload;
  if (startPayload && startPayload.startsWith('REF')) {
    const referrer = usersDb.getByRefCode(startPayload);
    if (referrer && referrer.chat_id !== chatId) {
      usersDb.setReferredBy(chatId, referrer.chat_id);
      await tempMsg(chatId,
        `🎁 Вы пришли по реферальной ссылке!\n\nПри первой покупке скидка 100 ₽ применится автоматически!`,
        7000
      );
    }
  }

  const discount = getUserDiscount(chatId);
  const discountLine = discount > 0
    ? `\n\n🎁 У вас есть скидка *${escapeMarkdown(formatPrice(discount))}* на следующую покупку\\!`
    : '';

  if (chatId === String(ADMIN_CHAT_ID)) {
    const isVerified = adminSessionsDb.isVerified(chatId);
    await ctx.reply(
      `👋 Привет, Администратор\\!${discountLine}\n\n` +
      (isVerified ? `✅ Вы авторизованы\\.` : `🔐 Войдите командой:\n/login ваш_пароль`),
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          keyboard: [
            [{ text: '📋 Каталог аккаунтов' }, { text: '📊 Статистика' }],
            [{ text: '📦 Все заказы' }, { text: '⭐ Отзывы' }],
            [{ text: '➕ Добавить аккаунт' }, { text: '🗂 Мои аккаунты' }],
            [{ text: '🔗 Моя реферальная ссылка' }, { text: '❓ Помощь' }],
          ],
          resize_keyboard: true,
        },
      }
    );
    return;
  }

  await ctx.reply(
    `👋 Привет\\! Это магазин аккаунтов Brawl Stars\\.${discountLine}\n\nВыбери действие:`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        keyboard: [
          [{ text: '📋 Каталог аккаунтов' }],
          [{ text: '📦 Мои заказы' }, { text: '🔗 Моя реферальная ссылка' }],
          [{ text: '❓ Помощь' }],
        ],
        resize_keyboard: true,
      },
    }
  );
});

// =====================
// КОМАНДЫ ПОКУПАТЕЛЯ
// =====================
bot.command('catalog', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.step = 'catalog';
  const discount = getUserDiscount(ctx.chat.id);
  const screen = buildCatalogScreen(0, discount);
  ctx.session.catalogIndex = screen.accountIndex ?? 0;
  await goTo(ctx.chat.id, ctx.session, screen);
});

bot.command('ref', async (ctx) => {
  const user = usersDb.get(String(ctx.chat.id));
  if (!user) return;
  const botUsername = ctx.botInfo?.username || 'yourbot';
  const link = `https://t.me/${botUsername}?start=${user.ref_code}`;
  const discount = getUserDiscount(ctx.chat.id);
  await ctx.reply(
    `🔗 *Ваша реферальная ссылка:*\n\n\`${link}\`\n\n` +
    `Поделитесь с другом\\. Когда он купит — вы получите скидку *100 ₽*\\!\n\n` +
    (discount > 0 ? `🎁 Ваша текущая скидка: *${escapeMarkdown(formatPrice(discount))}*` : `💡 Пригласите друга и получите скидку\\.`),
    { parse_mode: 'MarkdownV2' }
  );
});

bot.command('myorders', async (ctx) => {
  const orders = ordersDb.getByChatId(String(ctx.chat.id)).slice(0, 10);
  if (orders.length === 0) return ctx.reply('📭 У вас ещё нет заказов.');

  let text = `📦 *Ваши заказы:*\n\n`;
  for (const o of orders) {
    text += `*\\#${escapeMarkdown(o.order_id)}* — ${escapeMarkdown(statusLabel(o.status))}\n`;
    text += `🎮 ${escapeMarkdown(o.account_title || '—')}`;
    text += ` • ${o.type === 'rent' ? '🔑 Аренда' : '🛒 Покупка'}\n`;
    text += `💰 ${escapeMarkdown(formatPrice(o.price))}`;
    if (o.discount > 0) text += ` \\(−${escapeMarkdown(formatPrice(o.discount))}\\)`;
    text += ` • 🕐 ${escapeMarkdown(formatDate(o.created_at))}\n\n`;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
});

bot.command('help', async (ctx) => {
  const isAdm = isAdminChat(ctx);
  let text =
    `❓ *Помощь*\n\n` +
    `*Как купить аккаунт:*\n` +
    `1️⃣ Нажмите 📋 Каталог аккаунтов\n` +
    `2️⃣ Выберите аккаунт\n` +
    `3️⃣ Нажмите "Купить" или "Арендовать"\n` +
    `4️⃣ Оплатите через СБП на указанный номер\n` +
    `5️⃣ Нажмите "Я оплатил"\n` +
    `6️⃣ Введите имя как в банке\n` +
    `7️⃣ Дождитесь подтверждения\n` +
    `8️⃣ Введите email → получите код\n` +
    `9️⃣ Введите код из письма\n` +
    `🔟 Готово\\! 🏆\n\n` +
    `📞 По вопросам: @brawlhelpp`;

  if (isAdm) {
    text +=
      `\n\n*Команды администратора:*\n` +
      `/login пароль — войти в панель\n` +
      `/logout — выйти\n` +
      `/orders — все заказы\n` +
      `/stats — статистика\n` +
      `/reviews — отзывы\n` +
      `/accounts — все аккаунты`;
  }

  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
});

// =====================
// КОМАНДЫ АДМИНА
// ИСПРАВЛЕНО: пароль НЕ удаляется, сессия хранится в БД
// =====================
bot.command('login', async (ctx) => {
  if (!isAdminChat(ctx)) return;

  const parts = ctx.message.text.trim().split(/\s+/);
  const password = parts[1];

  // НЕ удаляем сообщение — чтобы видеть что вводили
  // Но можно раскомментировать если хочешь скрывать пароль:
  // try { await ctx.deleteMessage(); } catch (e) {}

  if (!password) {
    await ctx.reply(
      '🔐 Введите пароль так:\n\n/login ваш_пароль',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (password === ADMIN_PASSWORD) {
    adminSessionsDb.add(String(ctx.chat.id));
    await deleteLockMsg(ctx.chat.id);
    await ctx.reply(
      '✅ Вы вошли как администратор!\n\nВсе кнопки теперь активны. Сессия сохранена — не слетит при перезапуске бота.',
    );
  } else {
    await ctx.reply('❌ Неверный пароль. Попробуйте ещё раз: /login ваш_пароль');
  }
});

bot.command('logout', async (ctx) => {
  if (!isAdminChat(ctx)) return;
  adminSessionsDb.remove(String(ctx.chat.id));
  await ctx.reply('👋 Вы вышли из панели администратора.');
});

bot.command('orders', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('🔒 Нет доступа. Введите /login пароль');
  const all = ordersDb.getRecent(20);
  const active = ordersDb.getActive();
  if (all.length === 0) return ctx.reply('📭 Заказов пока нет.');

  let text = `📋 *Заказы* \\(последние ${all.length}\\)\n🔴 Активных: *${active.length}*\n\n`;
  for (const o of all) {
    text += `*\\#${escapeMarkdown(o.order_id)}* — ${escapeMarkdown(statusLabel(o.status))}`;
    text += ` ${o.type === 'rent' ? '🔑' : '🛒'}\n`;
    text += `👤 ${escapeMarkdown(o.buyer_name)}`;
    if (o.email) text += ` • 📧 ${escapeMarkdown(o.email)}`;
    text += `\n💰 ${escapeMarkdown(formatPrice(o.price))}`;
    if (o.discount > 0) text += ` \\(−${escapeMarkdown(formatPrice(o.discount))}\\)`;
    text += ` • 🕐 ${escapeMarkdown(formatDate(o.created_at))}\n\n`;
  }

  const buttons = active.slice(0, 5).map(o => ([{
    text: `#${o.order_id} ${o.type === 'rent' ? '🔑' : '🛒'} ${statusLabel(o.status)}`,
    callback_data: `admin_order_${o.order_id}`,
  }]));

  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
  });
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('🔒 Нет доступа. Введите /login пароль');
  await showStats(ctx);
});

bot.command('reviews', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('🔒 Нет доступа. Введите /login пароль');
  await showReviews(ctx);
});

bot.command('accounts', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('🔒 Нет доступа. Введите /login пароль');
  await showAccounts(ctx);
});

bot.hears(/^\/confirm_([A-F0-9]+)$/i, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await handleFulfill(ctx, ctx.match[1].toUpperCase());
});
bot.hears(/^\/reject_([A-F0-9]+)$/i, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await handleReject(ctx, ctx.match[1].toUpperCase());
});
bot.hears(/^\/complete_([A-F0-9]+)$/i, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await handleComplete(ctx, ctx.match[1].toUpperCase());
});

// =====================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ АДМИНА
// =====================
async function showStats(ctx) {
  const s = ordersDb.getStats();
  const rev = reviewsDb.getStats();
  const accounts = accountsDb.getAllIncludingSold();
  const available = accounts.filter(a => !a.sold).length;
  const sold = accounts.filter(a => a.sold).length;

  const text =
    `📊 *Статистика магазина*\n\n` +
    `📅 *Сегодня:*\n   Продаж: *${s.today.count}* на *${escapeMarkdown(formatPrice(s.today.revenue))}*\n\n` +
    `📆 *За 7 дней:*\n   Продаж: *${s.week.count}* на *${escapeMarkdown(formatPrice(s.week.revenue))}*\n\n` +
    `📈 *За всё время:*\n   Продаж: *${s.total.count}* на *${escapeMarkdown(formatPrice(s.total.revenue))}*\n\n` +
    `⏳ Ожидают: *${s.pending.count}*\n` +
    `🔑 Активных аренд: *${s.rentActive.count}*\n\n` +
    `📦 *Каталог:*\n   Доступно: *${available}*  •  Продано: *${sold}*\n\n` +
    `⭐ *Отзывы:*\n   Всего: *${rev.count}*  •  Средняя: *${rev.avg ? rev.avg.toFixed(1) : '—'}*`;

  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
}

async function showReviews(ctx) {
  const reviews = reviewsDb.getAll().slice(0, 10);
  if (reviews.length === 0) return ctx.reply('📭 Отзывов пока нет.');

  let text = `⭐ *Последние отзывы*\n\n`;
  for (const r of reviews) {
    text += `${'⭐'.repeat(r.stars)} — *${escapeMarkdown(r.buyer_name || 'Покупатель')}*\n`;
    if (r.text) text += `_${escapeMarkdown(r.text)}_\n`;
    text += `🕐 ${escapeMarkdown(formatDate(r.created_at))}\n\n`;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
}

async function showAccounts(ctx) {
  const all = accountsDb.getAllIncludingSold();
  if (all.length === 0) return ctx.reply('📭 Аккаунтов нет.');

  let text = `📦 *Все аккаунты:*\n\n`;
  const buttons = [];

  for (const a of all) {
    const rentInfo = a.rent_price_day > 0 ? ` • 🔑 ${formatPrice(a.rent_price_day)}/день` : '';
    text += `${a.sold ? '🔴 Продан' : a.rented ? '🟡 В аренде' : '🟢 Доступен'} — *${escapeMarkdown(a.title)}*\n`;
    text += `💰 ${escapeMarkdown(formatPrice(a.price))}${escapeMarkdown(rentInfo)} • 🥇 ${a.trophies.toLocaleString('ru-RU')}\n`;
    text += `\`${escapeMarkdown(a.id)}\`\n\n`;
    if (!a.sold) {
      buttons.push([{ text: `🗑 Удалить: ${a.title}`, callback_data: `del_acc_${a.id}` }]);
    }
  }

  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
  });
}

// =====================
// КНОПКИ КАТАЛОГА
// =====================
bot.hears('📋 Каталог аккаунтов', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.step = 'catalog';
  const discount = getUserDiscount(ctx.chat.id);
  const screen = buildCatalogScreen(0, discount);
  ctx.session.catalogIndex = screen.accountIndex ?? 0;
  await goTo(ctx.chat.id, ctx.session, screen);
});

bot.action(/^catalog_(\d+)$/, async (ctx) => {
  ctx.session = ctx.session || {};
  const index = parseInt(ctx.match[1], 10);
  const discount = getUserDiscount(ctx.chat.id);
  const screen = buildCatalogScreen(index, discount);
  ctx.session.catalogIndex = screen.accountIndex ?? index;
  ctx.session.step = 'catalog';
  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, screen);
});

bot.action('back_catalog', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.step = 'catalog';
  const discount = getUserDiscount(ctx.chat.id);
  const screen = buildCatalogScreen(ctx.session.catalogIndex || 0, discount);
  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, screen);
});

// =====================
// КНОПКИ ПОКУПКИ
// =====================
bot.action(/^buy_(.+)$/, async (ctx) => {
  ctx.session = ctx.session || {};
  const chatId = ctx.chat.id;
  const account = accountsDb.getById(ctx.match[1]);

  if (!account || account.sold) {
    await ctx.answerCbQuery('❌ Этот аккаунт уже продан');
    await goTo(chatId, ctx.session, buildCatalogScreen(0, getUserDiscount(chatId)));
    return;
  }

  if (ordersDb.hasPendingOrder(String(chatId))) {
    await ctx.answerCbQuery('⚠️ У вас уже есть активный заказ!');
    await tempMsg(chatId, '⚠️ У вас уже есть активный заказ. Дождитесь завершения или отмените его.');
    return;
  }

  const discount = getUserDiscount(chatId);
  ctx.session.selectedAccountId = account.id;
  ctx.session.pendingDiscount = discount;
  ctx.session.orderType = 'buy';
  ctx.session.rentDays = 0;
  ctx.session.step = 'payment';
  const finalPrice = Math.max(0, account.price - discount);

  await ctx.answerCbQuery();
  await goTo(chatId, ctx.session, screenPayment(account, finalPrice, 'buy'));
});

bot.action(/^back_payment_(.+)$/, async (ctx) => {
  ctx.session = ctx.session || {};
  const account = accountsDb.getById(ctx.match[1]);
  if (!account) return ctx.answerCbQuery();
  ctx.session.step = 'payment';
  const finalPrice = Math.max(0, account.price - (ctx.session.pendingDiscount || 0));
  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, screenPayment(account, finalPrice, ctx.session.orderType || 'buy', ctx.session.rentDays || 0));
});

bot.action(/^paid_(.+)$/, async (ctx) => {
  ctx.session = ctx.session || {};
  const chatId = ctx.chat.id;
  const account = accountsDb.getById(ctx.match[1]);

  if (!account || account.sold) {
    await ctx.answerCbQuery('❌ Аккаунт уже продан');
    return;
  }

  if (spamDb.check(String(chatId), 'paid', 2, 30)) {
    await ctx.answerCbQuery('⛔ Слишком много попыток');
    await tempMsg(chatId, '⛔ Вы слишком часто нажимаете "Я оплатил".\nЕсли есть проблемы — напишите @brawlhelpp');
    return;
  }
  spamDb.log(String(chatId), 'paid');

  if (ordersDb.hasPendingOrder(String(chatId))) {
    await ctx.answerCbQuery('⚠️ У вас уже есть активный заказ!');
    await tempMsg(chatId, '⚠️ У вас уже есть активный заказ. Дождитесь его завершения.');
    return;
  }

  ctx.session.selectedAccountId = account.id;
  ctx.session.step = 'awaiting_name';
  const finalPrice = ctx.session.orderType === 'rent'
    ? (ctx.session.rentDays === 1 ? account.rent_price_day : account.rent_price_week)
    : Math.max(0, account.price - (ctx.session.pendingDiscount || 0));

  await ctx.answerCbQuery();
  await goTo(chatId, ctx.session, screenEnterName(account, finalPrice, ctx.session.orderType || 'buy', ctx.session.rentDays || 0));
});

bot.action(/^cancel_(.+)$/, async (ctx) => {
  ctx.session = ctx.session || {};
  const orderId = ctx.match[1];
  const order = ordersDb.get(orderId);
  if (order && order.status === 'pending') {
    ordersDb.update(orderId, { status: 'cancelled' });
    await notifyAdmin(
      `⚫ *Заказ \\#${escapeMarkdown(orderId)} отменён покупателем*\n\n` +
      `👤 ${escapeMarkdown(order.buyer_name)}\n💰 ${escapeMarkdown(formatPrice(order.price))}`
    );
  }
  ctx.session.step = 'catalog';
  await ctx.answerCbQuery('Заказ отменён');
  await goTo(ctx.chat.id, ctx.session, buildCatalogScreen(ctx.session.catalogIndex || 0, getUserDiscount(ctx.chat.id)));
});

// =====================
// КНОПКИ АРЕНДЫ
// =====================
bot.action('rent_busy', async (ctx) => {
  await ctx.answerCbQuery('⏳ Этот аккаунт сейчас в аренде');
});

bot.action(/^rent_(.+)$/, async (ctx) => {
  ctx.session = ctx.session || {};
  const account = accountsDb.getById(ctx.match[1]);

  if (!account || account.sold) {
    await ctx.answerCbQuery('❌ Аккаунт недоступен');
    return;
  }
  if (account.rented) {
    await ctx.answerCbQuery('⏳ Аккаунт сейчас в аренде');
    await tempMsg(ctx.chat.id, '⏳ Этот аккаунт сейчас в аренде. Попробуйте позже или выберите другой.');
    return;
  }
  if (ordersDb.hasPendingOrder(String(ctx.chat.id))) {
    await ctx.answerCbQuery('⚠️ У вас уже есть активный заказ!');
    await tempMsg(ctx.chat.id, '⚠️ У вас уже есть активный заказ.');
    return;
  }

  ctx.session.selectedAccountId = account.id;
  ctx.session.orderType = 'rent';
  ctx.session.step = 'rent_options';

  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, screenRentOptions(account));
});

bot.action(/^rentpay_(.+)_(\d+)$/, async (ctx) => {
  ctx.session = ctx.session || {};
  const accountId = ctx.match[1];
  const days = parseInt(ctx.match[2], 10);
  const account = accountsDb.getById(accountId);

  if (!account || account.sold || account.rented) {
    await ctx.answerCbQuery('❌ Аккаунт недоступен');
    return;
  }

  const price = days === 1 ? account.rent_price_day : account.rent_price_week;
  ctx.session.selectedAccountId = account.id;
  ctx.session.orderType = 'rent';
  ctx.session.rentDays = days;
  ctx.session.pendingDiscount = 0;
  ctx.session.step = 'payment';

  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, screenRentPayment(account, days, price));
});

bot.action(/^rentpaid_(.+)_(\d+)$/, async (ctx) => {
  ctx.session = ctx.session || {};
  const chatId = ctx.chat.id;
  const accountId = ctx.match[1];
  const days = parseInt(ctx.match[2], 10);
  const account = accountsDb.getById(accountId);

  if (!account || account.sold || account.rented) {
    await ctx.answerCbQuery('❌ Аккаунт недоступен');
    return;
  }
  if (spamDb.check(String(chatId), 'paid', 2, 30)) {
    await ctx.answerCbQuery('⛔ Слишком много попыток');
    return;
  }
  spamDb.log(String(chatId), 'paid');

  if (ordersDb.hasPendingOrder(String(chatId))) {
    await ctx.answerCbQuery('⚠️ У вас уже есть активный заказ!');
    return;
  }

  ctx.session.selectedAccountId = account.id;
  ctx.session.orderType = 'rent';
  ctx.session.rentDays = days;
  ctx.session.pendingDiscount = 0;
  ctx.session.step = 'awaiting_name';

  const price = days === 1 ? account.rent_price_day : account.rent_price_week;

  await ctx.answerCbQuery();
  await goTo(chatId, ctx.session, screenEnterName(account, price, 'rent', days));
});

// =====================
// КНОПКА "ПОЛУЧИТЬ КОД" ДЛЯ АРЕНДЫ
// =====================
bot.action(/^getrentcode_(.+)$/, async (ctx) => {
  ctx.session = ctx.session || {};
  const orderId = ctx.match[1];
  const order = ordersDb.get(orderId);

  if (!order) {
    await ctx.answerCbQuery('❌ Заказ не найден');
    return;
  }

  if (spamDb.check(String(ctx.chat.id), 'getrentcode', 3, 2)) {
    await ctx.answerCbQuery('⏳ Подождите немного перед повторной попыткой');
    return;
  }
  spamDb.log(String(ctx.chat.id), 'getrentcode');

  await ctx.answerCbQuery('📨 Читаю письмо...');
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}

  const loadingMsg = await bot.telegram.sendMessage(
    ctx.chat.id,
    `⏳ *Читаю письмо от Supercell\\.\\.\\.*\n\nПодождите несколько секунд\\.`,
    { parse_mode: 'MarkdownV2' }
  );

  try {
    const code = await getSupercellCode();
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (e) {}

    const rentUntil = rentUntilDate(order.rent_days || 1);
    ordersDb.update(orderId, { status: 'fulfilled', code, rent_until: rentUntil });
    usersDb.incrementOrders(String(order.buyer_chat_id));

    if (order.referred_by) {
      usersDb.addDiscount(order.referred_by, 100);
      try {
        await bot.telegram.sendMessage(Number(order.referred_by),
          `🎁 По вашей реферальной ссылке совершили покупку\\!\n\nВы получили скидку *100 ₽* на следующую покупку\\.`,
          { parse_mode: 'MarkdownV2' }
        );
      } catch (e) {}
    }

    const sent = await bot.telegram.sendMessage(
      ctx.chat.id,
      `🎉 *Аренда активирована\\!*\n\n` +
      `🏆 *${escapeMarkdown(order.account_title)}*\n\n` +
      `Введите этот код в игру:\n\n` +
      `🔑 \`${escapeMarkdown(code)}\`\n\n` +
      `⏱ Аренда до: *${escapeMarkdown(formatDate(rentUntil))}*\n\n` +
      `По вопросам: @brawlhelpp`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⭐ Оставить отзыв', callback_data: 'leave_review' }],
            [{ text: '🏠 В каталог', callback_data: 'back_catalog' }],
          ],
        },
      }
    );
    pendingMainMsgStore.set(String(ctx.chat.id), sent.message_id);
    pendingLastOrderStore.set(String(ctx.chat.id), orderId);
    ctx.session.lastOrderId = orderId;

    await notifyAdmin(
      `✅ *Аренда завершена автоматически*\n\n` +
      `Заказ: *\\#${escapeMarkdown(orderId)}*\n` +
      `👤 ${escapeMarkdown(order.buyer_name)}\n` +
      `🎮 ${escapeMarkdown(order.account_title)}\n` +
      `🔑 Код: *${escapeMarkdown(code)}*\n` +
      `⏱ До: *${escapeMarkdown(formatDate(rentUntil))}*`
    );

  } catch (err) {
    console.error('[Gmail RENT ERROR]', err.message);
    try { await bot.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch (e) {}

    const sent = await bot.telegram.sendMessage(
      ctx.chat.id,
      `❌ *Не удалось получить код:*\n\n${escapeMarkdown(err.message)}\n\n` +
      `Подождите 1\\-2 минуты и попробуйте снова\\.\n` +
      `Убедитесь что нажали *"Отправить код"* в игре\\.`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Попробовать снова', callback_data: `getrentcode_${orderId}` }],
            [{ text: '📞 Написать продавцу', url: 'https://t.me/brawlhelpp' }],
          ],
        },
      }
    );
    pendingMainMsgStore.set(String(ctx.chat.id), sent.message_id);

    await notifyAdmin(
      `⚠️ *Ошибка чтения кода для аренды*\n\n` +
      `Заказ: *\\#${escapeMarkdown(orderId)}*\n` +
      `👤 ${escapeMarkdown(order.buyer_name)}\n` +
      `❌ ${escapeMarkdown(err.message)}`,
      [[{ text: '✅ Завершить вручную', callback_data: `complete_${orderId}` }]]
    );
  }
});

// =====================
// ОТЗЫВЫ
// =====================
bot.action('leave_review', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.step = 'awaiting_review_stars';
  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, screenLeaveReview());
});

bot.action(/^review_(\d)$/, async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.reviewStars = parseInt(ctx.match[1], 10);
  ctx.session.step = 'awaiting_review_text';
  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, screenReviewText(ctx.session.reviewStars));
});

bot.action('skip_review', async (ctx) => {
  ctx.session = ctx.session || {};
  if (ctx.session.reviewStars && ctx.session.lastOrderId) {
    if (!reviewsDb.hasReview(ctx.session.lastOrderId)) {
      reviewsDb.add({
        order_id: ctx.session.lastOrderId,
        buyer_chat_id: String(ctx.chat.id),
        buyer_name: ctx.session.buyerName || null,
        stars: ctx.session.reviewStars,
        text: null,
      });
    }
  }
  ctx.session.step = 'catalog';
  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, buildCatalogScreen(0, getUserDiscount(ctx.chat.id)));
});

bot.action('close_lock_msg', async (ctx) => {
  await ctx.answerCbQuery();
  await deleteLockMsg(ctx.chat.id);
});

// =====================
// РЕФЕРАЛ
// =====================
bot.hears('🔗 Моя реферальная ссылка', async (ctx) => {
  const user = usersDb.get(String(ctx.chat.id));
  if (!user) return;
  const botUsername = ctx.botInfo?.username || 'yourbot';
  const link = `https://t.me/${botUsername}?start=${user.ref_code}`;
  const discount = getUserDiscount(ctx.chat.id);
  await ctx.reply(
    `🔗 *Ваша реферальная ссылка:*\n\n\`${link}\`\n\n` +
    `Поделитесь с другом\\. Когда он купит — вы получите скидку *100 ₽*\\!\n\n` +
    (discount > 0 ? `🎁 Ваша текущая скидка: *${escapeMarkdown(formatPrice(discount))}*` : `💡 Пригласите друга и получите скидку\\.`),
    { parse_mode: 'MarkdownV2' }
  );
});

// =====================
// КНОПКИ АДМИНА
// =====================
bot.hears('📊 Статистика', async (ctx) => {
  await deleteLockMsg(ctx.chat.id);
  if (!isAdmin(ctx)) return lockMsg(ctx.chat.id, '🔒 Введите /login пароль');
  await showStats(ctx);
});

bot.hears('📦 Все заказы', async (ctx) => {
  await deleteLockMsg(ctx.chat.id);
  if (!isAdmin(ctx)) return lockMsg(ctx.chat.id, '🔒 Введите /login пароль');
  const all = ordersDb.getRecent(20);
  const active = ordersDb.getActive();
  if (all.length === 0) return ctx.reply('📭 Заказов пока нет.');

  let text = `📋 *Заказы* \\(последние ${all.length}\\)\n🔴 Активных: *${active.length}*\n\n`;
  for (const o of all) {
    text += `*\\#${escapeMarkdown(o.order_id)}* — ${escapeMarkdown(statusLabel(o.status))} ${o.type === 'rent' ? '🔑' : '🛒'}\n`;
    text += `👤 ${escapeMarkdown(o.buyer_name)}`;
    if (o.email) text += ` • 📧 ${escapeMarkdown(o.email)}`;
    text += `\n💰 ${escapeMarkdown(formatPrice(o.price))} • 🕐 ${escapeMarkdown(formatDate(o.created_at))}\n\n`;
  }

  const buttons = active.slice(0, 5).map(o => ([{
    text: `#${o.order_id} ${o.type === 'rent' ? '🔑' : '🛒'} ${statusLabel(o.status)}`,
    callback_data: `admin_order_${o.order_id}`,
  }]));

  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
  });
});

bot.hears('⭐ Отзывы', async (ctx) => {
  await deleteLockMsg(ctx.chat.id);
  if (!isAdmin(ctx)) return lockMsg(ctx.chat.id, '🔒 Введите /login пароль');
  await showReviews(ctx);
});

bot.hears('🗂 Мои аккаунты', async (ctx) => {
  await deleteLockMsg(ctx.chat.id);
  if (!isAdmin(ctx)) return lockMsg(ctx.chat.id, '🔒 Введите /login пароль');
  await showAccounts(ctx);
});

bot.hears('📦 Мои заказы', async (ctx) => {
  const orders = ordersDb.getByChatId(String(ctx.chat.id)).slice(0, 10);
  if (orders.length === 0) return ctx.reply('📭 У вас ещё нет заказов.');

  let text = `📦 *Ваши заказы:*\n\n`;
  for (const o of orders) {
    text += `*\\#${escapeMarkdown(o.order_id)}* — ${escapeMarkdown(statusLabel(o.status))} ${o.type === 'rent' ? '🔑' : '🛒'}\n`;
    text += `🎮 ${escapeMarkdown(o.account_title || '—')}\n`;
    text += `💰 ${escapeMarkdown(formatPrice(o.price))} • 🕐 ${escapeMarkdown(formatDate(o.created_at))}\n\n`;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
});

bot.hears('❓ Помощь', async (ctx) => {
  const isAdm = isAdminChat(ctx);
  let text =
    `❓ *Помощь*\n\n` +
    `*Как купить аккаунт:*\n` +
    `1️⃣ Нажмите 📋 Каталог аккаунтов\n` +
    `2️⃣ Выберите аккаунт и нажмите "Купить"\n` +
    `3️⃣ Оплатите через СБП на указанный номер\n` +
    `4️⃣ Нажмите "Я оплатил"\n` +
    `5️⃣ Введите имя как в банке\n` +
    `6️⃣ Дождитесь подтверждения\n` +
    `7️⃣ Введите email → получите код\n` +
    `8️⃣ Введите код из письма\n` +
    `9️⃣ Готово\\! 🏆\n\n` +
    `📞 По вопросам: @brawlhelpp`;

  if (isAdm) {
    text +=
      `\n\n*Кнопки администратора:*\n` +
      `📊 Статистика — доходы и продажи\n` +
      `📦 Все заказы — активные и завершённые\n` +
      `⭐ Отзывы — последние отзывы покупателей\n` +
      `🗂 Мои аккаунты — управление каталогом\n` +
      `➕ Добавить аккаунт — пошаговое добавление`;
  }

  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
});

bot.hears('➕ Добавить аккаунт', async (ctx) => {
  await deleteLockMsg(ctx.chat.id);
  if (!isAdmin(ctx)) return lockMsg(ctx.chat.id, '🔒 Введите /login пароль');
  ctx.session = ctx.session || {};
  ctx.session.step = 'admin_add_title';
  await ctx.reply(
    `➕ *Добавление аккаунта*\n\nШаг 1/4 — Введите название:\n_Например: Brawl Stars — 35 000 кубков_`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel_add' }]] },
    }
  );
});

bot.action('admin_cancel_add', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.step = null;
  ctx.session.newAccount = null;
  await ctx.answerCbQuery('Отменено');
  await ctx.reply('❌ Добавление отменено.');
});

bot.action(/^del_acc_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('🔒 Нет доступа');
  const id = ctx.match[1];
  const account = accountsDb.getById(id);
  if (!account) return ctx.answerCbQuery('❌ Не найден');
  accountsDb.delete(id);
  await ctx.answerCbQuery('✅ Удалён');
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.reply(`✅ Аккаунт *${escapeMarkdown(account.title)}* удалён\\.`, { parse_mode: 'MarkdownV2' });
});

bot.action(/^admin_order_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('🔒 Нет доступа');
  const orderId = ctx.match[1];
  const o = ordersDb.get(orderId);
  if (!o) return ctx.answerCbQuery('❌ Не найден');

  const buttons = [];
  if (o.status === 'pending') {
    buttons.push([
      { text: '✅ Подтвердить', callback_data: `fulfill_${o.order_id}` },
      { text: '❌ Отклонить', callback_data: `reject_${o.order_id}` },
    ]);
  } else if (o.status === 'code_received') {
    buttons.push([
      { text: '✅ Завершить', callback_data: `complete_${o.order_id}` },
      { text: '❌ Отклонить', callback_data: `reject_${o.order_id}` },
    ]);
  }

  let text =
    `📦 *Заказ \\#${escapeMarkdown(o.order_id)}*\n\n` +
    `${escapeMarkdown(statusLabel(o.status))} ${o.type === 'rent' ? '🔑 Аренда' : '🛒 Покупка'}\n\n` +
    `👤 *${escapeMarkdown(o.buyer_name)}*\n` +
    `🎮 ${escapeMarkdown(o.account_title || '—')}\n` +
    `💰 ${escapeMarkdown(formatPrice(o.price))}`;
  if (o.discount > 0) text += ` \\(−${escapeMarkdown(formatPrice(o.discount))}\\)`;
  if (o.type === 'rent') text += `\n⏱ Срок: *${o.rent_days} дн\\.*`;
  if (o.rent_until) text += `\n📅 До: *${escapeMarkdown(formatDate(o.rent_until))}*`;
  text += '\n';
  if (o.email) text += `📧 ${escapeMarkdown(o.email)}\n`;
  if (o.code) text += `🔑 Код: *${escapeMarkdown(o.code)}*\n`;
  text += `🕐 ${escapeMarkdown(formatDate(o.created_at))}`;

  await ctx.answerCbQuery();
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
  });
});

// =====================
// MIDDLEWARE (восстановление pending состояний)
// =====================
bot.use(async (ctx, next) => {
  if (ctx.message?.text) {
    ctx.session = ctx.session || {};
    const chatId = String(ctx.chat?.id);

    const pendingOrderId = pendingEmailByChatId.get(chatId);
    if (pendingOrderId && ctx.session.step !== 'awaiting_email') {
      ctx.session.step = 'awaiting_email';
      ctx.session.orderId = pendingOrderId;
      pendingEmailByChatId.delete(chatId);
    }

    const savedMsgId = pendingMainMsgStore.get(chatId);
    if (savedMsgId) {
      ctx.session.mainMsgId = savedMsgId;
      pendingMainMsgStore.delete(chatId);
    }

    const lastOrderId = pendingLastOrderStore.get(chatId);
    if (lastOrderId) {
      ctx.session.lastOrderId = lastOrderId;
      pendingLastOrderStore.delete(chatId);
    }
  }
  return next();
});

// =====================
// ОБРАБОТКА ТЕКСТА
// ИСПРАВЛЕНО: /login НЕ попадает сюда (команды обрабатываются раньше)
// =====================
bot.on('text', async (ctx) => {
  ctx.session = ctx.session || {};
  const text = ctx.message.text.trim();
  const step = ctx.session.step;
  const chatId = ctx.chat.id;

  // Команды и кнопки меню — не трогаем
  if (text.startsWith('/')) return;
  if ([
    '📋 Каталог аккаунтов', '🔗 Моя реферальная ссылка', '📦 Мои заказы',
    '📊 Статистика', '📦 Все заказы', '⭐ Отзывы', '🗂 Мои аккаунты',
    '➕ Добавить аккаунт', '❓ Помощь',
  ].includes(text)) return;

  // Удаляем только пользовательский ввод (не команды)
  try { await ctx.deleteMessage(); } catch (e) {}

  // Шаги добавления аккаунта (только для админа)
  if (isAdminChat(ctx) && step === 'admin_add_title') {
    ctx.session.newAccount = { title: text };
    ctx.session.step = 'admin_add_stats';
    await ctx.reply(
      `✅ Название: *${escapeMarkdown(text)}*\n\nШаг 2/4 — Введите характеристики:\n_кубки бойцы цена год_\n_Например: 35000 70 1200 2024_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel_add' }]] },
      }
    );
    return;
  }

  if (isAdminChat(ctx) && step === 'admin_add_stats') {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 4 || parts.map(Number).some(isNaN)) {
      await tempMsg(chatId, '❌ Введите 4 числа: кубки бойцы цена год\nНапример: 35000 70 1200 2024');
      return;
    }
    const [trophies, fighters, price, year] = parts.map(Number);
    ctx.session.newAccount = { ...ctx.session.newAccount, trophies, fighters, price, year };
    ctx.session.step = 'admin_add_rent';
    await ctx.reply(
      `✅ Характеристики сохранены\\!\n\nШаг 3/4 — Введите цены аренды:\n_цена_за_1_день цена_за_7_дней_\n_Например: 100 500_\n\n_Напишите 0 0 если аренда не нужна_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel_add' }]] },
      }
    );
    return;
  }

  if (isAdminChat(ctx) && step === 'admin_add_rent') {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2 || parts.map(Number).some(isNaN)) {
      await tempMsg(chatId, '❌ Введите 2 числа: цена за 1 день и цена за 7 дней\nНапример: 100 500\nИли 0 0 если аренда не нужна');
      return;
    }
    const [rentDay, rentWeek] = parts.map(Number);
    ctx.session.newAccount = { ...ctx.session.newAccount, rent_price_day: rentDay, rent_price_week: rentWeek };
    ctx.session.step = 'admin_add_image';
    await ctx.reply(
      `✅ Цены аренды сохранены\\!\n\nШаг 4/4 — Отправьте ссылку на фото:\n_Например: https://i\\.ibb\\.co/xxx/photo\\.jpg_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'admin_cancel_add' }]] },
      }
    );
    return;
  }

  if (isAdminChat(ctx) && step === 'admin_add_image') {
    if (!text.startsWith('http')) {
      await tempMsg(chatId, '❌ Ссылка должна начинаться с http');
      return;
    }
    const acc = ctx.session.newAccount;
    const id = 'acc-' + Date.now();
    accountsDb.add({ id, ...acc, image_url: text });
    ctx.session.step = null;
    ctx.session.newAccount = null;

    await ctx.reply(
      `✅ *Аккаунт добавлен в каталог\\!*\n\n` +
      `🏆 ${escapeMarkdown(acc.title)}\n` +
      `🥇 ${acc.trophies.toLocaleString('ru-RU')} кубков • ⚔️ ${acc.fighters} бойцов\n` +
      `💰 Цена: ${escapeMarkdown(formatPrice(acc.price))}\n` +
      `🔑 Аренда: ${acc.rent_price_day > 0 ? escapeMarkdown(formatPrice(acc.rent_price_day)) + '/день' : 'нет'}\n` +
      `📅 ${acc.year}`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  if (step === 'awaiting_name') {
    if (text.length < 3) {
      await tempMsg(chatId, '❌ Введите полное имя и первую букву фамилии.\nНапример: Александр К');
      return;
    }

    const account = accountsDb.getById(ctx.session.selectedAccountId);
    if (!account || account.sold) {
      await tempMsg(chatId, '❌ Аккаунт уже продан. Выберите другой.');
      ctx.session.step = 'catalog';
      await goTo(chatId, ctx.session, buildCatalogScreen(0, getUserDiscount(chatId)));
      return;
    }

    ctx.session.buyerName = text;
    ctx.session.step = 'awaiting_admin_confirm';

    const orderType = ctx.session.orderType || 'buy';
    const rentDays = ctx.session.rentDays || 0;
    const discount = orderType === 'buy' ? (ctx.session.pendingDiscount || 0) : 0;
    let price;
    if (orderType === 'rent') {
      price = rentDays === 1 ? account.rent_price_day : account.rent_price_week;
    } else {
      price = Math.max(0, account.price - discount);
    }

    const orderId = generateOrderId();
    const userRecord = usersDb.get(String(chatId));

    ordersDb.create({
      order_id: orderId,
      buyer_chat_id: String(chatId),
      buyer_name: text,
      account_id: account.id,
      account_title: account.title,
      price,
      type: orderType,
      rent_days: rentDays,
      rent_until: null,
      referred_by: userRecord?.referred_by || null,
      discount,
    });
    ctx.session.orderId = orderId;

    if (discount > 0) {
      db.prepare('UPDATE users SET discount = 0 WHERE chat_id = ?').run(String(chatId));
    }

    await goTo(chatId, ctx.session, screenWaiting(orderId, text, orderType));

    const typeLabel = orderType === 'rent' ? `🔑 Аренда ${rentDays} дн\\.` : '🛒 Покупка';

    await notifyAdmin(
      `🆕 *Новый заказ \\#${escapeMarkdown(orderId)}*\n\n` +
      `${typeLabel}\n` +
      `👤 Имя: *${escapeMarkdown(text)}*\n` +
      `🎮 ${escapeMarkdown(account.title)}\n` +
      `💰 ${escapeMarkdown(formatPrice(price))}` +
      (discount > 0 ? ` \\(−${escapeMarkdown(formatPrice(discount))} скидка\\)` : '') +
      `\n\nПроверьте перевод по имени и подтвердите:`,
      [[
        { text: '✅ Подтвердить оплату', callback_data: `fulfill_${orderId}` },
        { text: '❌ Отклонить', callback_data: `reject_${orderId}` },
      ]]
    );
    return;
  }

  if (step === 'awaiting_admin_confirm') {
    await tempMsg(chatId, '⏳ Ваш заказ на проверке. Дождитесь подтверждения от продавца.');
    return;
  }

  if (step === 'awaiting_email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      await tempMsg(chatId, '❌ Неверный формат email.\nНапример: example@mail.ru');
      return;
    }

    const orderId = ctx.session.orderId;
    const order = ordersDb.get(orderId);
    if (!order) {
      ctx.session.step = 'catalog';
      await goTo(chatId, ctx.session, buildCatalogScreen(0, getUserDiscount(chatId)));
      return;
    }

    ordersDb.update(orderId, { email: text });
    ctx.session.step = 'awaiting_code_from_email';

    await goTo(chatId, ctx.session, screenEnterCode(text));

    await notifyAdmin(
      `📧 *Заказ \\#${escapeMarkdown(orderId)}* — email получен\n\n` +
      `👤 ${escapeMarkdown(order.buyer_name)}\n📧 *${escapeMarkdown(text)}*`,
      [[{ text: '📨 Запросить код у покупателя', callback_data: `askcode_${orderId}` }]]
    );
    return;
  }

  if (step === 'awaiting_code_from_email') {
    if (!/^\d{6}$/.test(text)) {
      await tempMsg(chatId, '❌ Код должен состоять из 6 цифр.\nПроверьте письмо и попробуйте ещё раз.');
      return;
    }

    const orderId = ctx.session.orderId;
    const order = ordersDb.get(orderId);
    if (!order) {
      ctx.session.step = 'catalog';
      await goTo(chatId, ctx.session, buildCatalogScreen(0, getUserDiscount(chatId)));
      return;
    }

    ordersDb.update(orderId, { code: text, status: 'code_received' });
    ctx.session.step = 'awaiting_final_confirm';

    await goTo(chatId, ctx.session, screenCodeWaiting());

    await notifyAdmin(
      `🔑 *Заказ \\#${escapeMarkdown(orderId)}* — код от покупателя\n\n` +
      `👤 ${escapeMarkdown(order.buyer_name)}\n📧 ${escapeMarkdown(order.email || '—')}\n🔑 Код: *${escapeMarkdown(text)}*`,
      [[
        { text: '✅ Завершить заказ', callback_data: `complete_${orderId}` },
        { text: '❌ Отклонить', callback_data: `reject_${orderId}` },
      ]]
    );
    return;
  }

  if (step === 'awaiting_final_confirm') {
    await tempMsg(chatId, '⏳ Продавец проверяет код. Совсем скоро!');
    return;
  }

  if (step === 'awaiting_review_text') {
    const orderId = ctx.session.lastOrderId;
    if (orderId && !reviewsDb.hasReview(orderId)) {
      reviewsDb.add({
        order_id: orderId,
        buyer_chat_id: String(chatId),
        buyer_name: ctx.session.buyerName || null,
        stars: ctx.session.reviewStars || 5,
        text: text.slice(0, 500),
      });
      await notifyAdmin(
        `⭐ *Новый отзыв*\n\n${'⭐'.repeat(ctx.session.reviewStars || 5)} — ${escapeMarkdown(ctx.session.buyerName || 'Покупатель')}\n_${escapeMarkdown(text.slice(0, 300))}_`
      );
    }
    ctx.session.step = 'catalog';
    await goTo(chatId, ctx.session, screenReviewDone());
    return;
  }
});

// =====================
// ДЕЙСТВИЯ АДМИНА
// =====================
async function handleFulfill(ctx, orderId) {
  const order = ordersDb.get(orderId);
  if (!order) { await ctx.reply(`❌ Заказ #${orderId} не найден.`); return; }
  if (order.status !== 'pending') {
    await ctx.reply(`⚠️ Заказ уже обработан: ${statusLabel(order.status)}`);
    return;
  }

  ordersDb.update(orderId, { status: 'confirmed' });

  if (order.type === 'rent') {
    accountsDb.setRented(order.account_id, true);
    await ctx.reply(
      `✅ Заказ *\\#${escapeMarkdown(orderId)}* подтверждён\\. Отправляю инструкцию покупателю\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    try {
      const screen = screenRentEnterShopEmail(order.account_title, orderId);
      const sent = await bot.telegram.sendMessage(Number(order.buyer_chat_id), screen.text, {
        parse_mode: 'MarkdownV2',
        reply_markup: screen.keyboard,
      });
      pendingMainMsgStore.set(String(order.buyer_chat_id), sent.message_id);
    } catch (e) { console.warn(e.message); }
  } else {
    pendingEmailByChatId.set(String(order.buyer_chat_id), orderId);
    await ctx.reply(
      `✅ Заказ *\\#${escapeMarkdown(orderId)}* подтверждён\\. Ожидаю email от покупателя\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    try {
      const sent = await bot.telegram.sendMessage(
        Number(order.buyer_chat_id),
        `🎉 *Оплата подтверждена\\!*\n\nЗаказ: *\\#${escapeMarkdown(orderId)}*\n\nНапишите ваш *email* прямо сюда в чат:\n_Например: example@mail\\.ru_`,
        { parse_mode: 'MarkdownV2' }
      );
      pendingMainMsgStore.set(String(order.buyer_chat_id), sent.message_id);
    } catch (e) { console.warn(e.message); }
  }
}

async function handleReject(ctx, orderId) {
  const order = ordersDb.get(orderId);
  if (!order) { await ctx.reply(`❌ Заказ #${orderId} не найден.`); return; }
  if (order.status === 'fulfilled') { await ctx.reply('⚠️ Заказ уже завершён.'); return; }

  ordersDb.update(orderId, { status: 'rejected' });
  if (order.type === 'rent') accountsDb.setRented(order.account_id, false);

  await ctx.reply(`❌ Заказ *\\#${escapeMarkdown(orderId)}* отклонён\\.`, { parse_mode: 'MarkdownV2' });

  if (order.buyer_chat_id) {
    try {
      const sent = await bot.telegram.sendMessage(
        Number(order.buyer_chat_id),
        `❌ *Заказ \\#${escapeMarkdown(orderId)} отклонён\\.*\n\nОплата не найдена или имя не совпало\\.\nЕсли уже перевели деньги — напишите: @brawlhelpp`,
        { parse_mode: 'MarkdownV2' }
      );
      pendingMainMsgStore.set(String(order.buyer_chat_id), sent.message_id);
    } catch (e) { console.warn(e.message); }
  }
}

async function handleComplete(ctx, orderId) {
  const order = ordersDb.get(orderId);
  if (!order) { await ctx.reply(`❌ Заказ #${orderId} не найден.`); return; }
  if (order.status !== 'code_received' && order.status !== 'confirmed') {
    await ctx.reply(`⚠️ Заказ не готов к завершению \\(${escapeMarkdown(statusLabel(order.status))}\\)\\.`, { parse_mode: 'MarkdownV2' });
    return;
  }

  let finalCode = order.code || null;

  if (!finalCode) {
    await ctx.reply(`📧 Код не введён покупателем\\. Читаю Gmail автоматически\\.\\.\\.`, { parse_mode: 'MarkdownV2' });
    try {
      finalCode = await getSupercellCode();
      await ctx.reply(`✅ Код найден в Gmail: *${escapeMarkdown(finalCode)}*`, { parse_mode: 'MarkdownV2' });
    } catch (err) {
      console.error('[Gmail ERROR]', err.message);
      await ctx.reply(
        `❌ *Не удалось прочитать Gmail:*\n\n${escapeMarkdown(err.message)}\n\n` +
        `Попросите покупателя ввести код вручную или проверьте почту самостоятельно\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }
  }

  const rentUntil = order.type === 'rent' ? rentUntilDate(order.rent_days || 1) : null;

  ordersDb.update(orderId, { status: 'fulfilled', code: finalCode, rent_until: rentUntil });

  if (order.type === 'buy') accountsDb.markSold(order.account_id);

  usersDb.incrementOrders(String(order.buyer_chat_id));

  if (order.referred_by) {
    usersDb.addDiscount(order.referred_by, 100);
    try {
      await bot.telegram.sendMessage(Number(order.referred_by),
        `🎁 По вашей реферальной ссылке совершили покупку\\!\n\nВы получили скидку *100 ₽* на следующую покупку\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (e) {}
  }

  const rentInfo = rentUntil ? `\n⏱ Аренда до: *${escapeMarkdown(formatDate(rentUntil))}*` : '';

  await ctx.reply(
    `🏆 Заказ *\\#${escapeMarkdown(orderId)}* завершён\\!\n\n` +
    `👤 ${escapeMarkdown(order.buyer_name)}\n` +
    `📧 ${escapeMarkdown(order.email || '—')}\n` +
    `🔑 ${escapeMarkdown(finalCode)}${rentInfo}`,
    { parse_mode: 'MarkdownV2' }
  );

  if (order.buyer_chat_id) {
    try {
      const sent = await bot.telegram.sendMessage(
        Number(order.buyer_chat_id),
        `🎉 *${order.type === 'rent' ? 'Аренда активирована\\!' : 'Заказ завершён\\!'}*\n\n` +
        `🏆 Аккаунт *${escapeMarkdown(order.account_title)}* ${order.type === 'rent' ? 'в вашем распоряжении' : 'передан вам'}\\.\n` +
        (rentUntil ? `⏱ Аренда до: *${escapeMarkdown(formatDate(rentUntil))}*\n` : '') +
        `\nСпасибо за покупку\\! По вопросам: @brawlhelpp`,
        { parse_mode: 'MarkdownV2' }
      );
      pendingMainMsgStore.set(String(order.buyer_chat_id), sent.message_id);
      pendingLastOrderStore.set(String(order.buyer_chat_id), orderId);
    } catch (e) { console.warn(e.message); }
  }
}

bot.action(/^fulfill_(.+)$/, async (ctx) => {
  if (!isAdminChat(ctx)) return ctx.answerCbQuery('🔒 Нет доступа');
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('✅ Подтверждаю...');
  await handleFulfill(ctx, ctx.match[1]);
});

bot.action(/^askcode_(.+)$/, async (ctx) => {
  if (!isAdminChat(ctx)) return ctx.answerCbQuery('🔒 Нет доступа');
  const orderId = ctx.match[1];
  const order = ordersDb.get(orderId);
  if (!order) return ctx.answerCbQuery('❌ Заказ не найден');

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('📨 Запрос отправлен');
  await ctx.reply(`📨 Запрос кода отправлен покупателю (заказ #${orderId})`);

  if (order.buyer_chat_id) {
    try {
      const sent = await bot.telegram.sendMessage(
        Number(order.buyer_chat_id),
        `📬 *Проверьте почту\\!*\n\nНа адрес *${escapeMarkdown(order.email)}* пришло письмо с кодом\\.\n\nВведите *6\\-значный код* прямо сюда в чат:`,
        { parse_mode: 'MarkdownV2' }
      );
      pendingMainMsgStore.set(String(order.buyer_chat_id), sent.message_id);
    } catch (e) { console.warn(e.message); }
  }
});

bot.action(/^complete_(.+)$/, async (ctx) => {
  if (!isAdminChat(ctx)) return ctx.answerCbQuery('🔒 Нет доступа');
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('✅ Завершаю...');
  await handleComplete(ctx, ctx.match[1]);
});

bot.action(/^reject_(.+)$/, async (ctx) => {
  if (!isAdminChat(ctx)) return ctx.answerCbQuery('🔒 Нет доступа');
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('❌ Отклоняю...');
  await handleReject(ctx, ctx.match[1]);
});

// =====================
// EXPRESS API
// =====================
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.json({ ok: true, message: 'Bot is running' }));

app.get('/api/orders', (req, res) => {
  res.json({ orders: ordersDb.getAll() });
});

app.get('/api/order/:id', (req, res) => {
  const order = ordersDb.get(req.params.id.toUpperCase());
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({
    orderId: order.order_id,
    status: order.status,
    code: order.status === 'fulfilled' ? order.code : null,
    accountTitle: order.account_title,
    price: order.price,
    discount: order.discount,
    type: order.type,
    rentDays: order.rent_days,
    rentUntil: order.rent_until,
    createdAt: order.created_at,
  });
});

app.post('/api/fulfill/:id', async (req, res) => {
  const order = ordersDb.get(req.params.id.toUpperCase());
  if (!order) return res.status(404).json({ error: 'Not found' });
  const fakeCtx = { reply: (t, o) => bot.telegram.sendMessage(ADMIN_CHAT_ID, t, o) };
  await handleFulfill(fakeCtx, order.order_id);
  res.json({ ok: true });
});

app.post('/api/reject/:id', async (req, res) => {
  const order = ordersDb.get(req.params.id.toUpperCase());
  if (!order) return res.status(404).json({ error: 'Not found' });
  const fakeCtx = { reply: (t, o) => bot.telegram.sendMessage(ADMIN_CHAT_ID, t, o) };
  await handleReject(fakeCtx, order.order_id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));

bot.launch();
console.log('✅ Bot started');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
