require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const API = process.env.API_BASE_URL;

// Хранилище сессий пользователей (в памяти)
const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { step: 'idle', email: '', orderId: '' };
  }
  return sessions[userId];
}

// /start
bot.start((ctx) => {
  const session = getSession(ctx.from.id);
  session.step = 'idle';

  ctx.reply(
    '🏆 *Добро пожаловать в Brawllshop!*\n\n' +
    'Здесь ты можешь купить доступ к игре *Кубки* на 1 день за *10 ₽*.\n\n' +
    '✅ Полный доступ без ограничений\n' +
    '✅ Код приходит сразу после подтверждения\n' +
    '✅ Код также отправляется на email\n\n' +
    'Нажми кнопку ниже чтобы начать покупку:',
    {
      parse_mode: 'Markdown',
      ...Markup.keyboard([['🛒 Купить за 10 ₽']]).resize()
    }
  );
});

// Кнопка Купить
bot.hears('🛒 Купить за 10 ₽', (ctx) => {
  const session = getSession(ctx.from.id);
  session.step = 'waiting_email';

  ctx.reply(
    '📧 *Введи свой email*\n\n' +
    'На него придёт код доступа после подтверждения оплаты.',
    { parse_mode: 'Markdown' }
  );
});

// Обработка текста — email или "Я оплатил"
bot.on('text', async (ctx) => {
  const session = getSession(ctx.from.id);
  const text = ctx.message.text.trim();

  // Шаг 1 — получаем email
  if (session.step === 'waiting_email') {
    if (!isValidEmail(text)) {
      return ctx.reply('❌ Некорректный email. Попробуй ещё раз:');
    }

    session.email = text;
    session.step = 'waiting_payment';

    return ctx.reply(
      '💳 *Оплата через СБП*\n\n' +
      'Переведи *10 ₽* на номер:\n\n' +
      '📱 *+7 902 917-54-45*\n\n' +
      'После перевода нажми кнопку ниже 👇',
      {
        parse_mode: 'Markdown',
        ...Markup.keyboard([['✅ Я оплатил'], ['❌ Отмена']]).resize()
      }
    );
  }

  // Шаг 2 — пользователь нажал "Я оплатил"
  if (text === '✅ Я оплатил' && session.step === 'waiting_payment') {
    session.step = 'creating_order';

    await ctx.reply('⏳ Создаём заказ...', Markup.removeKeyboard());

    try {
      const response = await axios.post(`${API}/api/order`, {
        email: session.email,
        telegramUserId: String(ctx.from.id),
      });

      const orderId = response.data.orderId;
      if (!orderId) throw new Error('Сервер не вернул ID заказа');

      session.orderId = orderId;
      session.step = 'waiting_confirmation';

      // Сообщение пользователю
      await ctx.reply(
        '✅ *Заказ создан!*\n\n' +
        `📋 Номер заказа: \`${orderId}\`\n\n` +
        'Ожидай подтверждения от администратора.\n' +
        'Как только оплата будет подтверждена — ты получишь код прямо здесь.',
        {
          parse_mode: 'Markdown',
          ...Markup.keyboard([['🔄 Проверить статус'], ['❌ Отмена']]).resize()
        }
      );

      // Уведомление админу
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🆕 *Новый заказ!*\n\n` +
        `👤 Пользователь: @${ctx.from.username || 'без username'} (ID: ${ctx.from.id})\n` +
        `📧 Email: ${session.email}\n` +
        `📋 Заказ: \`${orderId}\`\n\n` +
        `Подтверди оплату:`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Подтвердить', `approve:${orderId}`),
              Markup.button.callback('❌ Отклонить', `reject:${orderId}`)
            ]
          ])
        }
      );

    } catch (err) {
      console.error('Create order error:', err.message);
      session.step = 'waiting_payment';
      await ctx.reply(
        '❌ Не удалось создать заказ. Попробуй ещё раз.',
        {
          ...Markup.keyboard([['✅ Я оплатил'], ['❌ Отмена']]).resize()
        }
      );
    }
    return;
  }

  // Кнопка проверить статус
  if (text === '🔄 Проверить статус' && session.step === 'waiting_confirmation') {
    if (!session.orderId) {
      return ctx.reply('❌ Заказ не найден. Начни покупку заново.');
    }

    try {
      const response = await axios.get(`${API}/api/order/${session.orderId}`);
      const status = response.data.status;
      const code = response.data.code;

      if (status === 'fulfilled' && code) {
        session.step = 'idle';
        return ctx.reply(
          '🎉 *Оплата подтверждена!*\n\n' +
          `🔑 Твой код доступа:\n\n\`${code}\`\n\n` +
          'Код также отправлен на твой email.\n\n' +
          'Спасибо за покупку! 🏆',
          {
            parse_mode: 'Markdown',
            ...Markup.keyboard([['🛒 Купить за 10 ₽']]).resize()
          }
        );
      }

      if (status === 'rejected' || status === 'cancelled') {
        session.step = 'idle';
        return ctx.reply(
          '❌ *Заказ отклонён.*\n\nЕсли перевод был сделан — проверь сумму и попробуй снова.',
          {
            parse_mode: 'Markdown',
            ...Markup.keyboard([['🛒 Купить за 10 ₽']]).resize()
          }
        );
      }

      return ctx.reply('⏳ Оплата ещё не подтверждена. Подожди немного.');

    } catch (err) {
      console.error('Check order error:', err.message);
      return ctx.reply('❌ Не удалось проверить статус. Попробуй позже.');
    }
  }

  // Отмена
  if (text === '❌ Отмена') {
    session.step = 'idle';
    session.email = '';
    session.orderId = '';
    return ctx.reply(
      '↩️ Покупка отменена.',
      {
        ...Markup.keyboard([['🛒 Купить за 10 ₽']]).resize()
      }
    );
  }
});

// Админ: подтвердить заказ
bot.action(/^approve:(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  await ctx.answerCbQuery('Подтверждаем...');

  try {
    const response = await axios.post(`${API}/api/fulfill/${orderId}`);
    const code = response.data.code;

    await ctx.editMessageText(
      ctx.callbackQuery.message.text + '\n\n✅ *Подтверждён*',
      { parse_mode: 'Markdown' }
    );

    // Найти пользователя по orderId и отправить код
    const userId = findUserByOrderId(orderId);
    if (userId && code) {
      await bot.telegram.sendMessage(
        userId,
        '🎉 *Оплата подтверждена!*\n\n' +
        `🔑 Твой код доступа:\n\n\`${code}\`\n\n` +
        'Код также отправлен на твой email.\n\n' +
        'Спасибо за покупку! 🏆',
        {
          parse_mode: 'Markdown',
          ...Markup.keyboard([['🛒 Купить за 10 ₽']]).resize()
        }
      );
      sessions[userId].step = 'idle';
    }

  } catch (err) {
    console.error('Fulfill error:', err.message);
    await ctx.reply('❌ Не удалось подтвердить заказ.');
  }
});

// Админ: отклонить заказ
bot.action(/^reject:(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  await ctx.answerCbQuery('Отклоняем...');

  try {
    await axios.post(`${API}/api/reject/${orderId}`);

    await ctx.editMessageText(
      ctx.callbackQuery.message.text + '\n\n❌ *Отклонён*',
      { parse_mode: 'Markdown' }
    );

    const userId = findUserByOrderId(orderId);
    if (userId) {
      await bot.telegram.sendMessage(
        userId,
        '❌ *Заказ отклонён.*\n\nЕсли перевод был сделан — проверь сумму и попробуй снова.',
        {
          parse_mode: 'Markdown',
          ...Markup.keyboard([['🛒 Купить за 10 ₽']]).resize()
        }
      );
      sessions[userId].step = 'idle';
    }

  } catch (err) {
    console.error('Reject error:', err.message);
    await ctx.reply('❌ Не удалось отклонить заказ.');
  }
});

// Найти userId по orderId
function findUserByOrderId(orderId) {
  for (const [userId, session] of Object.entries(sessions)) {
    if (session.orderId === orderId) return userId;
  }
  return null;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

bot.launch();
console.log('✅ Brawllshop bot запущен');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
