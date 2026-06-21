require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const API_BASE_URL = process.env.API_BASE_URL || 'https://ksbkr-server-production.up.railway.app';

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

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

// Листание каталога
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
    `✅ Вы выбрали: *${account.title}*\n💰 Цена: *${formatPrice(account.price)}*\n\n📧 Введите ваш email для получения подтверждения:`,
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

  // Помощь
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

  // Ввод email
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
    return;
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
    const response = await axios.post(`${API_BASE_URL}/api/order`, {
      email: email,
      accountId: account.id,
      accountTitle: account.title,
      price: account.price,
    });

    const orderId = response.data.orderId;
    if (!orderId) throw new Error('Сервер не вернул ID заказа');

    ctx.session.orderId = orderId;
    ctx.session.step = 'awaiting_confirmation';

    await ctx.reply(
      `✅ *Заказ #${orderId} создан!*\n\n` +
      `Продавец проверит оплату и подтвердит заказ.\n` +
      `Вы получите уведомление здесь в Telegram.\n\n` +
      `По вопросам: @brawlhelpp`,
      { parse_mode: 'Markdown' }
    );

    // Уведомление админу
    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🆕 *Новый заказ #${orderId}*\n\n` +
        `👤 Email: ${email}\n` +
        `🎮 Аккаунт: ${account.title}\n` +
        `🏆 Кубки: ${account.trophies.toLocaleString('ru-RU')}\n` +
        `💰 Цена: ${formatPrice(account.price)}\n\n` +
        `Подтвердить или отклонить через веб-панель.`,
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
// УВЕДОМЛЕНИЕ ПОКУПАТЕЛЮ (вызывается с сервера)
// =====================
// Этот endpoint можно вызвать с Railway сервера когда заказ подтверждён
// POST /notify { chatId, orderId, code }
const express = require('express');
const app = express();
app.use(express.json());

app.post('/notify', async (req, res) => {
  const { chatId, orderId, code } = req.body;
  if (!chatId || !orderId) return res.status(400).json({ error: 'chatId and orderId required' });

  try {
    await bot.telegram.sendMessage(
      chatId,
      `🎉 *Заказ #${orderId} подтверждён!*\n\n` +
      `Ваш код для передачи аккаунта:\n` +
      `\`${code || 'Уточните у продавца'}\`\n\n` +
      `Отправьте этот код продавцу: @brawlhelpp`,
      { parse_mode: 'Markdown' }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Notify error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('Bot is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// =====================
// ЗАПУСК БОТА
// =====================
bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
