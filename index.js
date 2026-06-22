require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

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
    year INTEGER NOT NULL,
    image_url TEXT NOT NULL,
    sold INTEGER DEFAULT 0,
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
`);

// Добавить стартовый аккаунт если таблица пустая
const existingAccounts = db.prepare('SELECT COUNT(*) as count FROM accounts').get();
if (existingAccounts.count === 0) {
  db.prepare(`
    INSERT INTO accounts (id, title, trophies, fighters, price, year, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'acc-29444',
    'Brawl Stars — 29 444 кубка',
    29444, 65, 800, 2024,
    'https://i.ibb.co/qYT3zH2F/photo-2026-06-20-23-05-47.jpg'
  );
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
      INSERT INTO accounts (id, title, trophies, fighters, price, year, image_url)
      VALUES (@id, @title, @trophies, @fighters, @price, @year, @image_url)
    `).run(account);
  },
  markSold(id) {
    db.prepare("UPDATE accounts SET sold = 1 WHERE id = ?").run(id);
  },
  delete(id) {
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  },
};

const ordersDb = {
  create(order) {
    db.prepare(`
      INSERT INTO orders (order_id, buyer_chat_id, buyer_name, account_id, account_title, price, referred_by, discount)
      VALUES (@order_id, @buyer_chat_id, @buyer_name, @account_id, @account_title, @price, @referred_by, @discount)
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
    return { today, week, total, pending };
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
    db.prepare(`
      INSERT OR IGNORE INTO users (chat_id, username, ref_code)
      VALUES (?, ?, ?)
    `).run(chatId, username || null, refCode);
    return this.get(chatId);
  },
  setReferredBy(chatId, referrerChatId) {
    db.prepare('UPDATE users SET referred_by = ? WHERE chat_id = ? AND referred_by IS NULL')
      .run(referrerChatId, chatId);
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
    db.prepare(`
      INSERT INTO reviews (order_id, buyer_chat_id, buyer_name, stars, text)
      VALUES (@order_id, @buyer_chat_id, @buyer_name, @stars, @text)
    `).run(review);
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

setInterval(() => spamDb.cleanup(), 60 * 60 * 1000);

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

// =====================
// БОТ
// =====================
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const pendingEmailByChatId = new Map();
const pendingMainMsgStore = new Map();
const pendingLastOrderStore = new Map();

function isAdmin(ctx) {
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

async function notifyAdmin(text, keyboard) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
  } catch (e) { console.warn('Admin notify error:', e.message); }
}

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
    `📅 Год: *${account.year}*\n`;

  if (discount > 0) {
    caption +=
      `💰 Цена: *${escapeMarkdown(formatPrice(account.price))}* → *${escapeMarkdown(formatPrice(finalPrice))}*\n` +
      `🎁 Скидка: *${escapeMarkdown(formatPrice(discount))}*\n`;
  } else {
    caption += `💰 Цена: *${escapeMarkdown(formatPrice(account.price))}*\n`;
  }

  caption += `\n📦 Аккаунт ${i + 1} из ${accounts.length}`;

  const navRow = [];
  if (i > 0) navRow.push({ text: '◀ Пред.', callback_data: `catalog_${i - 1}` });
  if (i < accounts.length - 1) navRow.push({ text: 'След. ▶', callback_data: `catalog_${i + 1}` });

  const rows = [];
  if (navRow.length > 0) rows.push(navRow);
  rows.push([{ text: `🛒 Купить за ${formatPrice(finalPrice)}`, callback_data: `buy_${account.id}` }]);

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
// ЭКРАНЫ ПОКУПАТЕЛЯ
// =====================
function screenPayment(account, finalPrice) {
  return {
    type: 'text',
    text:
      `💳 *Оплата заказа*\n\n` +
      `🎮 Аккаунт: *${escapeMarkdown(account.title)}*\n` +
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

function screenEnterName(account, finalPrice) {
  return {
    type: 'text',
    text:
      `✍️ *Введите ваше имя*\n\n` +
      `Напишите *полное имя и первую букву фамилии*\n` +
      `_Например: Александр К_\n\n` +
      `⚠️ Укажите имя точно как в банке при переводе\\.\n\n` +
      `💰 Сумма: *${escapeMarkdown(formatPrice(finalPrice))}*\n` +
      `📞 На номер: *\\+7 902 917\\-54\\-45*`,
    keyboard: {
      inline_keyboard: [
        [{ text: '◀ Назад к оплате', callback_data: `back_payment_${account.id}` }],
      ],
    },
  };
}

function screenWaiting(orderId, buyerName) {
  return {
    type: 'text',
    text:
      `⏳ *Ожидайте подтверждения*\n\n` +
      `Заказ: *\\#${escapeMarkdown(orderId)}*\n` +
      `Имя: *${escapeMarkdown(buyerName)}*\n\n` +
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

function screenSuccess(accountTitle) {
  return {
    type: 'text',
    text:
      `🎉 *Поздравляем\\! Заказ завершён\\!*\n\n` +
      `🏆 Аккаунт *${escapeMarkdown(accountTitle)}* передан вам\\.\n\n` +
      `Спасибо за покупку\\! По вопросам: @brawlhelpp`,
    keyboard: {
      inline_keyboard: [
        [{ text: '⭐ Оставить отзыв', callback_data: 'leave_review' }],
        [{ text: '🏠 Вернуться в каталог', callback_data: 'back_catalog' }],
      ],
    },
  };
}

function screenRejected(orderId) {
  return {
    type: 'text',
    text:
      `❌ *Заказ \\#${escapeMarkdown(orderId)} отклонён*\n\n` +
      `Оплата не найдена или имя не совпало\\.\n` +
      `Если уже перевели деньги — напишите: @brawlhelpp`,
    keyboard: {
      inline_keyboard: [
        [{ text: '◀ Вернуться в каталог', callback_data: 'back_catalog' }],
      ],
    },
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
      inline_keyboard: [
        [{ text: 'Пропустить', callback_data: 'skip_review' }],
      ],
    },
  };
}

function screenReviewDone() {
  return {
    type: 'text',
    text: `✅ *Спасибо за отзыв\\!*\n\nЭто помогает нам становиться лучше 🙏`,
    keyboard: {
      inline_keyboard: [
        [{ text: '🏠 В каталог', callback_data: 'back_catalog' }],
      ],
    },
  };
}

// =====================
// СТАРТ
// =====================
bot.start(async (ctx) => {
  ctx.session = ctx.session || {};
  const chatId = String(ctx.chat.id);
  const username = ctx.from?.username || null;

  usersDb.upsert(chatId, username);

  // Реферальная ссылка
  const startPayload = ctx.startPayload;
  if (startPayload && startPayload.startsWith('REF')) {
    const referrer = usersDb.getByRefCode(startPayload);
    if (referrer && referrer.chat_id !== chatId) {
      usersDb.setReferredBy(chatId, referrer.chat_id);
      await tempMsg(chatId,
        `🎁 Вы пришли по реферальной ссылке!\n\nПри первой покупке скидка 100 ₽ уже применится автоматически!`,
        7000
      );
    }
  }

  const discount = getUserDiscount(chatId);
  const discountLine = discount > 0
    ? `\n\n🎁 У вас есть скидка *${escapeMarkdown(formatPrice(discount))}* на следующую покупку\\!`
    : '';

  await ctx.reply(
    `👋 Привет\\! Это магазин аккаунтов Brawl Stars\\.${discountLine}\n\nВыбери действие:`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        keyboard: [
          [{ text: '📋 Каталог аккаунтов' }],
          [{ text: '🔗 Моя реферальная ссылка' }, { text: '❓ Помощь' }],
        ],
        resize_keyboard: true,
      },
    }
  );
});

// =====================
// КОМАНДЫ АДМИНА
// =====================
bot.command('orders', async (ctx) => {
  if (!isAdmin(ctx)) return;

  const all = ordersDb.getRecent(20);
  const active = ordersDb.getActive();

  if (all.length === 0) return ctx.reply('📭 Заказов пока нет.');

  let text = `📋 *Заказы* \\(последние ${all.length}\\)\n🔴 Активных: *${active.length}*\n\n`;

  for (const o of all) {
    text += `*\\#${escapeMarkdown(o.order_id)}* — ${escapeMarkdown(statusLabel(o.status))}\n`;
    text += `👤 ${escapeMarkdown(o.buyer_name)}`;
    if (o.email) text += ` • 📧 ${escapeMarkdown(o.email)}`;
    text += `\n💰 ${escapeMarkdown(formatPrice(o.price))}`;
    if (o.discount > 0) text += ` \\(−${escapeMarkdown(formatPrice(o.discount))}\\)`;
    text += ` • 🕐 ${escapeMarkdown(formatDate(o.created_at))}\n`;
    if (o.status === 'pending') {
      text += `_→ /confirm\\_${o.order_id} или /reject\\_${o.order_id}_\n`;
    } else if (o.status === 'code_received') {
      text += `_→ /complete\\_${o.order_id} или /reject\\_${o.order_id}_\n`;
    }
    text += '\n';
  }

  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
});

bot.command('order', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = ctx.message.text.split(' ')[1]?.toUpperCase();
  if (!id) return ctx.reply('Использование: /order ID');

  const o = ordersDb.get(id);
  if (!o) return ctx.reply(`❌ Заказ #${id} не найден.`);

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
    `${escapeMarkdown(statusLabel(o.status))}\n\n` +
    `👤 Имя: *${escapeMarkdown(o.buyer_name)}*\n` +
    `🎮 ${escapeMarkdown(o.account_title || '—')}\n` +
    `💰 ${escapeMarkdown(formatPrice(o.price))}`;
  if (o.discount > 0) text += ` \\(−${escapeMarkdown(formatPrice(o.discount))} скидка\\)`;
  text += '\n';
  if (o.email) text += `📧 ${escapeMarkdown(o.email)}\n`;
  if (o.code) text += `🔑 Код: *${escapeMarkdown(o.code)}*\n`;
  text += `🕐 ${escapeMarkdown(formatDate(o.created_at))}`;

  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
  });
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return;

  const s = ordersDb.getStats();
  const rev = reviewsDb.getStats();
  const accounts = accountsDb.getAllIncludingSold();
  const available = accounts.filter(a => !a.sold).length;
  const sold = accounts.filter(a => a.sold).length;

  const text =
    `📊 *Статистика магазина*\n\n` +
    `📅 *Сегодня:*\n` +
    `   Продаж: *${s.today.count}* на *${escapeMarkdown(formatPrice(s.today.revenue))}*\n\n` +
    `📆 *За 7 дней:*\n` +
    `   Продаж: *${s.week.count}* на *${escapeMarkdown(formatPrice(s.week.revenue))}*\n\n` +
    `📈 *За всё время:*\n` +
    `   Продаж: *${s.total.count}* на *${escapeMarkdown(formatPrice(s.total.revenue))}*\n\n` +
    `⏳ Ожидают подтверждения: *${s.pending.count}*\n\n` +
    `📦 *Каталог:*\n` +
    `   Доступно: *${available}*  •  Продано: *${sold}*\n\n` +
    `⭐ *Отзывы:*\n` +
    `   Всего: *${rev.count}*  •  Средняя оценка: *${rev.avg ? rev.avg.toFixed(1) : '—'}*`;

  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
});

bot.command('reviews', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const reviews = reviewsDb.getAll().slice(0, 10);
  if (reviews.length === 0) return ctx.reply('📭 Отзывов пока нет.');

  let text = `⭐ *Последние отзывы*\n\n`;
  for (const r of reviews) {
    text += `${'⭐'.repeat(r.stars)} — *${escapeMarkdown(r.buyer_name || 'Покупатель')}*\n`;
    if (r.text) text += `_${escapeMarkdown(r.text)}_\n`;
    text += `🕐 ${escapeMarkdown(formatDate(r.created_at))}\n\n`;
  }

  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
});

bot.command('addaccount', async (ctx) => {
  if (!isAdmin(ctx)) return;

  // Формат:
  // /addaccount
  // Название аккаунта
  // кубки бойцы цена год
  // https://ссылка-на-фото.jpg

  const lines = ctx.message.text.split('\n').slice(1);

  if (lines.length < 3) {
    return ctx.reply(
      '📝 Формат добавления:\n\n' +
      '/addaccount\n' +
      'Brawl Stars — 35 000 кубков\n' +
      '35000 70 1200 2024\n' +
      'https://ссылка-на-фото.jpg'
    );
  }

  const title = lines[0].trim();
  const stats = lines[1].trim().split(/\s+/);
  const imageUrl = lines[2].trim();

  if (stats.length < 4) {
    return ctx.reply('❌ Во второй строке укажите: кубки бойцы цена год\nНапример: 35000 70 1200 2024');
  }

  const [trophies, fighters, price, year] = stats.map(Number);
  if ([trophies, fighters, price, year].some(isNaN)) {
    return ctx.reply('❌ Кубки, бойцы, цена и год должны быть числами.');
  }

  const id = 'acc-' + Date.now();
  accountsDb.add({ id, title, trophies, fighters, price, year, image_url: imageUrl });

  await ctx.reply(
    `✅ Аккаунт добавлен в каталог!\n\n` +
    `🏆 ${title}\n` +
    `🥇 ${trophies.toLocaleString('ru-RU')} кубков\n` +
    `⚔️ ${fighters} бойцов\n` +
    `💰 ${formatPrice(price)}\n` +
    `📅 ${year}\n` +
    `🆔 ${id}`
  );
});

bot.command('delaccount', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = ctx.message.text.split(' ')[1];
  if (!id) return ctx.reply('Использование: /delaccount ID');

  const account = accountsDb.getById(id);
  if (!account) return ctx.reply(`❌ Аккаунт ${id} не найден.`);

  accountsDb.delete(id);
  await ctx.reply(`✅ Аккаунт "${account.title}" удалён из каталога.`);
});

bot.command('accounts', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const all = accountsDb.getAllIncludingSold();
  if (all.length === 0) return ctx.reply('📭 Аккаунтов нет.');

  let text = `📦 *Все аккаунты:*\n\n`;
  for (const a of all) {
    text += `${a.sold ? '🔴 Продан' : '🟢 Доступен'} — *${escapeMarkdown(a.title)}*\n`;
    text += `💰 ${escapeMarkdown(formatPrice(a.price))} • 🥇 ${a.trophies.toLocaleString('ru-RU')}\n`;
    text += `🆔 \`${escapeMarkdown(a.id)}\`\n\n`;
  }

  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
});

// Быстрые команды
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
// КАТАЛОГ — кнопки
// =====================
bot.hears('📋 Каталог аккаунтов', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.step = 'catalog';
  ctx.session.catalogIndex = 0;
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
// ПОКУПКА — кнопки
// =====================
bot.action(/^buy_(.+)$/, async (ctx) => {
  ctx.session = ctx.session || {};
  const chatId = ctx.chat.id;
  const account = accountsDb.getById(ctx.match[1]);

  if (!account || account.sold) {
    await ctx.answerCbQuery('❌ Этот аккаунт уже продан');
    const screen = buildCatalogScreen(0, getUserDiscount(chatId));
    await goTo(chatId, ctx.session, screen);
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
  ctx.session.step = 'payment';
  const finalPrice = Math.max(0, account.price - discount);

  await ctx.answerCbQuery();
  await goTo(chatId, ctx.session, screenPayment(account, finalPrice));
});

bot.action(/^back_payment_(.+)$/, async (ctx) => {
  ctx.session = ctx.session || {};
  const account = accountsDb.getById(ctx.match[1]);
  if (!account) return ctx.answerCbQuery();
  ctx.session.step = 'payment';
  const finalPrice = Math.max(0, account.price - (ctx.session.pendingDiscount || 0));
  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, screenPayment(account, finalPrice));
});

bot.action(/^paid_(.+)$/, async (ctx) => {
  ctx.session = ctx.session || {};
  const chatId = ctx.chat.id;
  const account = accountsDb.getById(ctx.match[1]);

  if (!account || account.sold) {
    await ctx.answerCbQuery('❌ Аккаунт уже продан');
    return;
  }

  // Антиспам: не более 2 нажатий за 30 минут
  if (spamDb.check(String(chatId), 'paid', 2, 30)) {
    await ctx.answerCbQuery('⛔ Слишком много попыток');
    await tempMsg(chatId,
      '⛔ Вы слишком часто нажимаете "Я оплатил".\n\nЕсли есть проблемы — напишите @brawlhelpp'
    );
    return;
  }
  spamDb.log(String(chatId), 'paid');

  // Защита от двойного заказа
  if (ordersDb.hasPendingOrder(String(chatId))) {
    await ctx.answerCbQuery('⚠️ У вас уже есть активный заказ!');
    await tempMsg(chatId, '⚠️ У вас уже есть активный заказ. Дождитесь его завершения.');
    return;
  }

  ctx.session.selectedAccountId = account.id;
  ctx.session.step = 'awaiting_name';
  const finalPrice = Math.max(0, account.price - (ctx.session.pendingDiscount || 0));
  await ctx.answerCbQuery();
  await goTo(chatId, ctx.session, screenEnterName(account, finalPrice));
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
  const screen = buildCatalogScreen(ctx.session.catalogIndex || 0, getUserDiscount(ctx.chat.id));
  await goTo(ctx.chat.id, ctx.session, screen);
});

// =====================
// ОТЗЫВЫ — кнопки
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
  const screen = buildCatalogScreen(0, getUserDiscount(ctx.chat.id));
  await goTo(ctx.chat.id, ctx.session, screen);
});

// =====================
// РЕФЕРАЛЬНАЯ ССЫЛКА
// =====================
bot.hears('🔗 Моя реферальная ссылка', async (ctx) => {
  const user = usersDb.get(String(ctx.chat.id));
  if (!user) return;
  const botUsername = ctx.botInfo?.username || 'yourbot';
  const link = `https://t.me/${botUsername}?start=${user.ref_code}`;
  const discount = getUserDiscount(ctx.chat.id);

  await ctx.reply(
    `🔗 *Ваша реферальная ссылка:*\n\n` +
    `\`${link}\`\n\n` +
    `Поделитесь с другом\\. Когда он купит аккаунт — вы получите скидку *100 ₽* на следующую покупку\\!\n\n` +
    (discount > 0
      ? `🎁 Ваша текущая скидка: *${escapeMarkdown(formatPrice(discount))}*`
      : `💡 Пригласите друга и получите скидку\\.`),
    { parse_mode: 'MarkdownV2' }
  );
});

// =====================
// MIDDLEWARE
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
// =====================
bot.on('text', async (ctx) => {
  ctx.session = ctx.session || {};
  const text = ctx.message.text.trim();
  const step = ctx.session.step;
  const chatId = ctx.chat.id;

  try { await ctx.deleteMessage(); } catch (e) {}

  if (text.startsWith('/')) return;
  if (text === '📋 Каталог аккаунтов') return;
  if (text === '🔗 Моя реферальная ссылка') return;

  if (text === '❓ Помощь') {
    await tempMsg(chatId,
      '📞 По вопросам: @brawlhelpp\n\n' +
      '1️⃣ Нажмите "Каталог аккаунтов"\n' +
      '2️⃣ Выберите аккаунт и нажмите "Купить"\n' +
      '3️⃣ Оплатите через СБП на указанный номер\n' +
      '4️⃣ Нажмите "Я оплатил"\n' +
      '5️⃣ Введите имя как в банке\n' +
      '6️⃣ Дождитесь подтверждения от продавца\n' +
      '7️⃣ Введите email — получите код\n' +
      '8️⃣ Введите код из письма\n' +
      '9️⃣ Готово! 🏆\n\n' +
      '🔗 Пригласите друга и получите скидку 100 ₽!',
      10000
    );
    return;
  }

  // --- Ввод имени ---
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

    const discount = ctx.session.pendingDiscount || 0;
    const finalPrice = Math.max(0, account.price - discount);
    const orderId = generateOrderId();
    const userRecord = usersDb.get(String(chatId));

    ordersDb.create({
      order_id: orderId,
      buyer_chat_id: String(chatId),
      buyer_name: text,
      account_id: account.id,
      account_title: account.title,
      price: account.price,
      referred_by: userRecord?.referred_by || null,
      discount,
    });
    ctx.session.orderId = orderId;

    // Списываем скидку сразу при создании заказа
    if (discount > 0) {
      db.prepare('UPDATE users SET discount = 0 WHERE chat_id = ?').run(String(chatId));
    }

    await goTo(chatId, ctx.session, screenWaiting(orderId, text));

    await notifyAdmin(
      `🆕 *Новый заказ \\#${escapeMarkdown(orderId)}*\n\n` +
      `👤 Имя: *${escapeMarkdown(text)}*\n` +
      `🎮 ${escapeMarkdown(account.title)}\n` +
      `💰 ${escapeMarkdown(formatPrice(finalPrice))}` +
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

  // --- Ввод email ---
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
      `👤 ${escapeMarkdown(order.buyer_name)}\n` +
      `📧 *${escapeMarkdown(text)}*`,
      [[{ text: '📨 Запросить код у покупателя', callback_data: `askcode_${orderId}` }]]
    );
    return;
  }

  // --- Ввод кода ---
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
      `👤 ${escapeMarkdown(order.buyer_name)}\n` +
      `📧 ${escapeMarkdown(order.email || '—')}\n` +
      `🔑 Код: *${escapeMarkdown(text)}*`,
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

  // --- Текст отзыва ---
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
        `⭐ *Новый отзыв*\n\n` +
        `${'⭐'.repeat(ctx.session.reviewStars || 5)} — ${escapeMarkdown(ctx.session.buyerName || 'Покупатель')}\n` +
        `_${escapeMarkdown(text.slice(0, 300))}_`
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

async function handleReject(ctx, orderId) {
  const order = ordersDb.get(orderId);
  if (!order) { await ctx.reply(`❌ Заказ #${orderId} не найден.`); return; }
  if (order.status === 'fulfilled') { await ctx.reply('⚠️ Заказ уже завершён.'); return; }

  ordersDb.update(orderId, { status: 'rejected' });

  await ctx.reply(
    `❌ Заказ *\\#${escapeMarkdown(orderId)}* отклонён\\.`,
    { parse_mode: 'MarkdownV2' }
  );

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
  if (order.status !== 'code_received') {
    await ctx.reply(`⚠️ Заказ не в статусе "Код получен" (${statusLabel(order.status)}).`);
    return;
  }

  ordersDb.update(orderId, { status: 'fulfilled' });
  accountsDb.markSold(order.account_id);
  usersDb.incrementOrders(String(order.buyer_chat_id));

  // Реферальный бонус — начислить пригласившему
  if (order.referred_by) {
    usersDb.addDiscount(order.referred_by, 100);
    try {
      await bot.telegram.sendMessage(
        Number(order.referred_by),
        `🎁 По вашей реферальной ссылке совершили покупку\\!\n\nВы получили скидку *100 ₽* на следующую покупку\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (e) {}
  }

  await ctx.reply(
    `🏆 Заказ *\\#${escapeMarkdown(orderId)}* завершён\\!\n\n` +
    `👤 ${escapeMarkdown(order.buyer_name)}\n` +
    `📧 ${escapeMarkdown(order.email || '—')}\n` +
    `🔑 ${escapeMarkdown(order.code || '—')}`,
    { parse_mode: 'MarkdownV2' }
  );

  if (order.buyer_chat_id) {
    try {
      const sent = await bot.telegram.sendMessage(
        Number(order.buyer_chat_id),
        `🎉 *Поздравляем\\! Заказ завершён\\!*\n\n` +
        `🏆 Аккаунт *${escapeMarkdown(order.account_title)}* передан вам\\.\n\n` +
        `Спасибо за покупку\\! По вопросам: @brawlhelpp`,
        { parse_mode: 'MarkdownV2' }
      );
      pendingMainMsgStore.set(String(order.buyer_chat_id), sent.message_id);
      pendingLastOrderStore.set(String(order.buyer_chat_id), orderId);
    } catch (e) { console.warn(e.message); }
  }
}

// Кнопки в сообщениях админа
bot.action(/^fulfill_(.+)$/, async (ctx) => {
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('✅ Подтверждаю...');
  await handleFulfill(ctx, ctx.match[1]);
});

bot.action(/^askcode_(.+)$/, async (ctx) => {
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
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('✅ Завершаю...');
  await handleComplete(ctx, ctx.match[1]);
});

bot.action(/^reject_(.+)$/, async (ctx) => {
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
  const list = ordersDb.getAll();
  res.json({ orders: list });
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
    createdAt: order.created_at,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));

bot.launch();
console.log('✅ Bot started');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
