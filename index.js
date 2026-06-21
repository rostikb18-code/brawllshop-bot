require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const express = require('express');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// =====================
// ХРАНИЛИЩЕ ЗАКАЗОВ (в памяти)
// =====================
const orders = new Map(); // orderId -> { orderId, email, accountId, accountTitle, price, status, code, chatId, createdAt }

function generateOrderId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// =====================
// КАТАЛОГ АККАУНТОВ
// =====================
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
  return Markup.inlineKeyboard([
    navRow,
    [Markup.button.callback(`🛒 Купить за ${formatPrice(ACCOUNTS[index].price)}`, `buy_${ACCOUNTS[index].id}`)],
  ].filter(row => row.length > 0));
}

// =====================
// СТАРТ
// =====================
bot.start(async (ctx) => {
  ctx.session = ctx.session || {};
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
  ctx.session.step = 'awaiting_email';

  await ctx.answerCbQuery();
  await ctx.reply(
    `✅ Вы выбрали: *${account.title}*\n💰 Цена: *${formatPrice(account.price)}*\n\n📧 Введите ваш email:`,
    { parse_mode: 'Markdown' }
  );
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
      '2️⃣ Введите email\n' +
      '3️⃣ Переведите деньги по СБП\n' +
      '4️⃣ Дождитесь подтверждения от продавца\n' +
      '5️⃣ Получите код и отправьте продавцу'
    );
  }

  if (step === 'awaiting_email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(text)) {
      return ctx.reply('❌ Неверный формат email. Попробуйте ещё раз:');
    }

    const account = getAccountById(ctx.session.selectedAccountId);
    if (!account) {
      ctx.session.step = null;
      return ctx.reply('❌ Аккаунт не найден. Начните заново — /start');
    }

    ctx.session.email = text;
    ctx.session.step = 'awaiting_payment';

    await ctx.reply(
      `📱 *Оплата через СБП*\n\n` +
      `Переведите *${formatPrice(account.price)}* на номер:\n` +
      `📞 *+7 902 917-54-45*\n\n` +
      `После перевода нажмите кнопку ниже 👇`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Я оплатил', 'confirm_payment')],
          [Markup.button.callback('❌ Отмена', 'cancel_order')],
        ]),
      }
    );
  }
});

// =====================
// ПОДТВЕРЖДЕНИЕ ОПЛАТЫ
// =====================
bot.action('confirm_payment', async (ctx) => {
  ctx.session = ctx.session || {};
  const account = getAccountById(ctx.session.selectedAccountId);
  const email = ctx.session.email;

  if (!account || !email) {
    await ctx.answerCbQuery();
    return ctx.reply('❌ Сессия истекла. Начните заново — /start');
  }

  await ctx.answerCbQuery('Создаём заказ...');
  await ctx.reply('⏳ Создаём заказ, подождите...');

  try {
    const orderId = generateOrderId();
    const order = {
      orderId,
      email,
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
    ctx.session.step = 'awaiting_confirmation';

    await ctx.reply(
      `✅ *Заказ #${orderId} создан!*\n\n` +
      `Продавец проверит оплату и подтвердит заказ.\n` +
      `Вы получите уведомление здесь в Telegram.\n\n` +
      `По вопросам: @brawlhelpp`,
      { parse_mode: 'Markdown' }
    );

    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🆕 *Новый заказ #${orderId}*\n\n` +
        `👤 Email: ${email}\n` +
        `🎮 Аккаунт: ${account.title}\n` +
        `🏆 Кубки: ${account.trophies.toLocaleString('ru-RU')}\n` +
        `💰 Цена: ${formatPrice(account.price)}\n\n` +
        `Подтвердить через веб-панель.`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (e) {
    console.error('Create order error:', e.message);
    await ctx.reply('❌ Не удалось создать заказ. Попробуйте позже или напишите @brawlhelpp');
  }
});

// =====================
// ОТМЕНА
// =====================
bot.action('cancel_order', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.step = null;
  ctx.session.selectedAccountId = null;
  ctx.session.email = null;
  await ctx.answerCbQuery('Отменено');
  await ctx.reply('❌ Заказ отменён. Напишите /start чтобы начать заново.');
});

// =====================
// EXPRESS СЕРВЕР + API
// =====================
const app = express();
app.use(express.json());

// CORS — разрешаем miniapp обращаться к API
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Проверка работы
app.get('/', (req, res) => res.json({ ok: true, message: 'Bot server is running' }));

// Создать заказ (из miniapp)
app.post('/api/order', (req, res) => {
  try {
    const { email, accountId, accountTitle, price } = req.body;
    if (!email || !accountId) return res.status(400).json({ error: 'email and accountId required' });

    const orderId = generateOrderId();
    const order = {
      orderId,
      email,
      accountId,
      accountTitle: accountTitle || accountId,
      price: price || 0,
      status: 'pending',
      code: null,
      chatId: null,
      createdAt: new Date().toISOString(),
    };
    orders.set(orderId, order);

    console.log(`Order created: ${orderId} for ${email}`);
    res.json({ orderId, status: 'pending' });
  } catch (e) {
    console.error('POST /api/order error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Получить статус заказа (из miniapp — polling)
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

// Список всех заказов (для админки)
app.get('/api/orders', (req, res) => {
  const list = Array.from(orders.values()).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json({ orders: list });
});

// Подтвердить заказ
app.post('/api/fulfill/:id', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') return res.status(400).json({ error: 'Order is not pending' });

  const code = req.body.code || crypto.randomBytes(6).toString('hex').toUpperCase();
  order.status = 'fulfilled';
  order.code = code;
  orders.set(order.orderId, order);

  // Уведомить покупателя в Telegram (если заказ через бота)
  if (order.chatId) {
    try {
      await bot.telegram.sendMessage(
        order.chatId,
        `🎉 *Заказ #${order.orderId} подтверждён!*\n\n` +
        `Ваш код для передачи аккаунта:\n` +
        `\`${code}\`\n\n` +
        `Отправьте этот код продавцу: @brawlhelpp`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.warn('Cannot notify buyer:', e.message);
    }
  }

  console.log(`Order fulfilled: ${order.orderId}, code: ${code}`);
  res.json({ ok: true, orderId: order.orderId, code, status: 'fulfilled' });
});

// Отклонить заказ
app.post('/api/reject/:id', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') return res.status(400).json({ error: 'Order is not pending' });

  order.status = 'rejected';
  orders.set(order.orderId, order);

  if (order.chatId) {
    try {
      await bot.telegram.sendMessage(
        order.chatId,
        `❌ *Заказ #${order.orderId} отклонён.*\n\n` +
        `Если вы уже перевели деньги, напишите продавцу: @brawlhelpp`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.warn('Cannot notify buyer:', e.message);
    }
  }

  console.log(`Order rejected: ${order.orderId}`);
  res.json({ ok: true, orderId: order.orderId, status: 'rejected' });
});

// Уведомить покупателя вручную
app.post('/notify', async (req, res) => {
  const { chatId, orderId, code } = req.body;
  if (!chatId || !orderId) return res.status(400).json({ error: 'chatId and orderId required' });

  try {
    await bot.telegram.sendMessage(
      chatId,
      `🎉 *Заказ #${orderId} подтверждён!*\n\n` +
      `Ваш код:\n\`${code || 'Уточните у продавца'}\`\n\n` +
      `Отправьте код продавцу: @brawlhelpp`,
      { parse_mode: 'Markdown' }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Notify error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// =====================
// ЗАПУСК БОТА
// =====================
bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
