import 'dotenv/config';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import { db } from './db.ts';
import { getProductByBarcode } from './off.ts';
import {
  fmt, localDay, nutritionText, parseNonNegativeNumber, parsePortion,
  scaleNutrition, sumNutrition, type Nutrition,
} from './nutrition.ts';

const token = process.env.BOT_TOKEN;
if (!token || token === 'INSERT_BOT_TOKEN_HERE') {
  throw new Error('Укажи BOT_TOKEN в .env (токен создаётся через @BotFather)');
}
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
const fetchWithNodeSignal: typeof fetch = async (input, init) => {
  const sourceSignal = init?.signal;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (sourceSignal?.aborted) abort();
  else sourceSignal?.addEventListener('abort', abort, { once: true });

  const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(String(input));
  const method = init?.method ?? 'GET';
  const rawHeaders = init?.headers;
  const requestHeaders: Record<string, string> = {};
  if (rawHeaders) {
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((value, key) => {
        requestHeaders[key] = value;
      });
    } else if (Array.isArray(rawHeaders)) {
      for (const [key, value] of rawHeaders) {
        requestHeaders[key] = String(value);
      }
    } else {
      for (const [key, value] of Object.entries(rawHeaders as Record<string, string | string[] | number | boolean | undefined>)) {
        if (value === undefined) continue;
        requestHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
      }
    }
  }
  let body: string | Uint8Array | undefined;
  if (typeof init?.body === 'string') {
    body = init.body;
  } else if (init?.body instanceof URLSearchParams) {
    body = init.body.toString();
  } else if (init?.body instanceof ArrayBuffer) {
    body = new Uint8Array(init.body);
  } else if (ArrayBuffer.isView(init?.body)) {
    body = new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength);
  } else if (init?.body && typeof init.body === 'object') {
    body = JSON.stringify(init.body);
  }

  try {
    return await new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method,
          headers: requestHeaders,
          agent: proxyAgent ?? undefined,
        },
        (response) => {
          const responseBody: Buffer[] = [];
          response.on('data', (chunk) => {
            responseBody.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            const finalBody = Buffer.concat(responseBody);
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) {
                responseHeaders.set(key, value.join(', '));
              } else if (typeof value === 'string') {
                responseHeaders.set(key, value);
              }
            }
            resolve(new Response(finalBody, {
              status: response.statusCode ?? 200,
              statusText: response.statusMessage ?? '',
              headers: responseHeaders,
            }));
          });
        },
      );
      request.on('error', (error) => {
        reject(error);
      });
      sourceSignal?.addEventListener('abort', () => request.destroy(), { once: true });
      if (body !== undefined) request.write(body);
      request.end();
    });
  } finally {
    sourceSignal?.removeEventListener('abort', abort);
  }
};
const bot = new Bot(token, { client: { fetch: fetchWithNodeSignal } });

const STEPS = ['name', 'brand', 'stores', 'basis', 'calories', 'proteins', 'fats', 'carbs'] as const;
type NewStep = typeof STEPS[number];
type NewData = Partial<Nutrition & {
  name: string;
  brand: string;
  stores: string[];
  basis: 'G100' | 'ML100';
}>;
type Session =
  | { kind: 'new'; step: NewStep; data: NewData; expiresAt: number }
  | { kind: 'weight'; productId: number; expiresAt: number };
const sessions = new Map<number, Session>();
const SESSION_TIME_MS = 20 * 60 * 1000;

function prompt(step: NewStep): string {
  const messages: Record<NewStep, string> = {
    name: 'Название продукта? Например: Творог 5%',
    brand: 'Бренд? Например: Простоквашино. Если бренда нет, отправь -',
    stores: 'Где куплен? Пятёрочка, Магнит или другой магазин. Несколько магазинов раздели запятой. Если неважно, отправь -',
    basis: 'КБЖУ на 100 граммов или на 100 миллилитров? Ответь: г или мл',
    calories: 'Калории на 100 г/мл (ккал)? Например: 121',
    proteins: 'Белки на 100 г/мл? Например: 17',
    fats: 'Жиры на 100 г/мл? Например: 5',
    carbs: 'Углеводы на 100 г/мл? Например: 2.5',
  };
  return messages[step];
}

function publicHelp(): string {
  return [
    '🥗 Дневник КБЖУ',
    '',
    '/new — добавить продукт с упаковки',
    '/search творог — найти продукт по названию',
    '/store магнит — товары с меткой магазина',
    '/barcode 4601234567890 — найти по штрихкоду',
    '/today — дневник и КБЖУ за сегодня',
    '/history — последние 7 дней',
    '/undo — удалить последнюю запись',
    '/goal 2200 — задать дневную цель в ккал',
    '/timezone Europe/Moscow — часовой пояс дневника',
    '/cancel — отменить ввод',
    '',
    'Можно просто отправить название товара или цифры штрихкода.',
    'Для внесения еды нажми «➕ Съел» и укажи вес.',
  ].join('\n');
}

function normalizeStore(value: string): string {
  const cleaned = value.trim();
  if (/^(пят(е|ё)рочк[а-я]*|5ka)$/i.test(cleaned)) return 'Пятёрочка';
  if (/^магнит[а-я]*$/i.test(cleaned)) return 'Магнит';
  return cleaned;
}

function displayProduct(p: {
  id: number;
  name: string;
  brand: string;
  stores: string[];
  basis: 'G100' | 'ML100';
  source: string;
} & Nutrition): string {
  const tag = p.stores.length ? ` · ${p.stores.join(', ')}` : '';
  const unit = p.basis === 'ML100' ? 'мл' : 'г';
  const attribution = p.source === 'OPEN_FOOD_FACTS' ? ' · Open Food Facts' : '';
  return `#${p.id} ${p.name}${p.brand ? ` (${p.brand})` : ''}${tag}\n` +
    `На 100 ${unit}: ${nutritionText(p)}${attribution}`;
}

async function ensureUser(telegramId: number) {
  return db.user.upsert({
    where: { telegramId: BigInt(telegramId) },
    update: {},
    create: {
      telegramId: BigInt(telegramId),
      timezone: process.env.DEFAULT_TIMEZONE || 'Europe/Moscow',
    },
  });
}

async function showToday(ctx: Context, telegramId: number) {
  const user = await ensureUser(telegramId);
  const day = localDay(new Date(), user.timezone);
  const entries = await db.foodEntry.findMany({
    where: { userId: user.id, day }, orderBy: { createdAt: 'desc' },
  });
  const total = sumNutrition(entries);
  let text = `📅 ${day}\n${nutritionText(total)}\n`;
  if (user.calorieGoal !== null) {
    text += `Цель: ${user.calorieGoal} ккал · `;
    const left = user.calorieGoal - total.calories;
    text += left >= 0 ? `осталось ${fmt(left)} ккал\n` : `превышение ${fmt(-left)} ккал\n`;
  }
  if (!entries.length) {
    text += '\nЗаписей пока нет. Найди продукт через /search или создай через /new.';
  } else {
    text += '\nПоследние записи:\n' + entries.slice(0, 12).map((entry) =>
      `• ${entry.productName} — ${fmt(entry.amount)} ${entry.basis === 'ML100' ? 'мл' : 'г'} · ${fmt(entry.calories)} ккал`,
    ).join('\n');
    if (entries.length > 12) text += `\n…ещё ${entries.length - 12} записей`;
  }
  await ctx.reply(text);
}

async function showHistory(ctx: Context, telegramId: number) {
  const user = await ensureUser(telegramId);
  const today = localDay(new Date(), user.timezone);
  const pivot = new Date(`${today}T12:00:00Z`);
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(pivot.getTime() - offset * 86400000);
    return date.toISOString().slice(0, 10);
  });
  const entries = await db.foodEntry.findMany({
    where: { userId: user.id, day: { in: days } },
  });
  const lines = days.map((day) => {
    const daily = entries.filter((entry) => entry.day === day);
    const sum = sumNutrition(daily);
    return `${day} · ${fmt(sum.calories)} ккал · Б ${fmt(sum.proteins)} Ж ${fmt(sum.fats)} У ${fmt(sum.carbs)} (${daily.length} записей)`;
  });
  await ctx.reply('📊 Последние 7 дней\n\n' + lines.join('\n'));
}

async function search(ctx: Context, telegramId: number, query: string) {
  if (query.length < 2) {
    await ctx.reply('Отправь название продукта, например /search творог');
    return;
  }
  const user = await ensureUser(telegramId);
  const products = await db.product.findMany({
    where: {
      AND: [
        { OR: [{ ownerId: user.id }, { ownerId: null }] },
        { OR: [
          { name: { contains: query.slice(0, 80), mode: 'insensitive' } },
          { brand: { contains: query.slice(0, 80), mode: 'insensitive' } },
        ] },
      ],
    },
    take: 10, orderBy: { createdAt: 'desc' },
  });
  if (!products.length) {
    await ctx.reply('В нашем каталоге пока нет такого продукта. Добавь его через /new или проверь штрихкод через /barcode.');
    return;
  }
  const keyboard = new InlineKeyboard();
  products.forEach((p) => keyboard.text(`➕ ${p.name.slice(0, 35)} (#${p.id})`, `eat:${p.id}`).row());
  await ctx.reply(products.map(displayProduct).join('\n\n').slice(0, 3900), { reply_markup: keyboard });
}

async function searchStore(ctx: Context, telegramId: number, query: string) {
  if (!query) {
    await ctx.reply('Например: /store магнит или /store пятерочка');
    return;
  }
  const store = normalizeStore(query);
  const user = await ensureUser(telegramId);
  const products = await db.product.findMany({
    where: { AND: [{ OR: [{ ownerId: user.id }, { ownerId: null }] }, { stores: { has: store } }] },
    take: 10, orderBy: { createdAt: 'desc' },
  });
  if (!products.length) {
    await ctx.reply(`Товаров с меткой «${store}» пока нет. Добавь через /new. Это твой каталог, а не онлайн-остатки магазина.`);
    return;
  }
  const keyboard = new InlineKeyboard();
  products.forEach((p) => keyboard.text(`➕ ${p.name.slice(0, 35)}`, `eat:${p.id}`).row());
  await ctx.reply(`🏪 ${store} (добавленные и отмеченные товары)\n\n` +
    products.map(displayProduct).join('\n\n').slice(0, 3800), { reply_markup: keyboard });
}

async function lookupBarcode(ctx: Context, telegramId: number, barcode: string) {
  if (!/^\d{8,14}$/.test(barcode)) {
    await ctx.reply('Нужны 8–14 цифр штрихкода. Например: /barcode 3017620422003');
    return;
  }
  const user = await ensureUser(telegramId);
  let product = await db.product.findUnique({ where: { barcode } });
  if (!product) {
    try {
      const external = await getProductByBarcode(barcode);
      if (!external) {
        await ctx.reply('Товар не найден или в базе нет полного КБЖУ. Посмотри этикетку и добавь его вручную через /new.');
        return;
      }
      product = await db.product.upsert({
        where: { barcode }, update: {},
        create: {
          name: external.name, brand: external.brand,
          barcode, source: 'OPEN_FOOD_FACTS', basis: external.basis,
          stores: [], ownerId: null,
          calories: external.calories, proteins: external.proteins,
          fats: external.fats, carbs: external.carbs,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
      await ctx.reply(`Не получилось получить товар: ${message}`);
      return;
    }
  }
  if (product.ownerId !== null && product.ownerId !== user.id) {
    await ctx.reply('Этот товар недоступен. Добавь собственную карточку через /new.');
    return;
  }
  await ctx.reply('🔎 Найден товар:\n' + displayProduct(product) +
    '\n\nПроверь КБЖУ по упаковке: открытая база может содержать ошибки. ' +
    'Связь с Пятёрочкой/Магнитом не подтверждается этим поиском.', {
    reply_markup: new InlineKeyboard().text('➕ Съел — указать вес', `eat:${product.id}`),
  });
}

async function addEntry(ctx: Context, telegramId: number, productId: number, amount: number) {
  const user = await ensureUser(telegramId);
  const product = await db.product.findFirst({
    where: { id: productId, OR: [{ ownerId: user.id }, { ownerId: null }] },
  });
  if (!product) {
    await ctx.reply('Товар не найден в твоём каталоге. Попробуй /search.');
    return;
  }
  const values = scaleNutrition(product, amount);
  await db.foodEntry.create({
    data: {
      userId: user.id, productId: product.id,
      productName: product.name, amount, basis: product.basis,
      day: localDay(new Date(), user.timezone),
      ...values,
    },
  });
  await ctx.reply(`✅ Записано: ${product.name}, ${fmt(amount)} ${product.basis === 'ML100' ? 'мл' : 'г'}\n` +
    nutritionText(values) + '\nПосмотреть итог: /today');
}

async function processNew(ctx: Context, telegramId: number, text: string,
  session: Extract<Session, { kind: 'new' }>) {
  const data = session.data;
  const step = session.step;
  if (step === 'name' || step === 'brand') {
    if (text.length > (step === 'name' ? 150 : 100) || (step === 'name' && (text.length < 2 || text === '-'))) {
      await ctx.reply(`Некорректное значение. ${prompt(step)}`);
      return;
    }
    data[step] = text === '-' ? '' : text;
  } else if (step === 'stores') {
    const stores = text === '-' ? [] : text.split(',').map(normalizeStore).filter(Boolean);
    if (stores.length > 5 || stores.some((store) => store.length > 60)) {
      await ctx.reply('Укажи не больше 5 магазинов (до 60 символов каждый) или -');
      return;
    }
    data.stores = [...new Set(stores)];
  } else if (step === 'basis') {
    if (!['г', 'мл'].includes(text.toLowerCase())) {
      await ctx.reply(prompt(step));
      return;
    }
    data.basis = text.toLowerCase() === 'мл' ? 'ML100' : 'G100';
  } else {
    const value = parseNonNegativeNumber(text);
    const max = step === 'calories' ? 1000 : 100;
    if (value === null || value > max) {
      await ctx.reply(`Нужно число от 0 до ${max}. Можно с запятой: 2,5`);
      return;
    }
    data[step] = value;
  }
  const next = STEPS[STEPS.indexOf(step) + 1];
  if (next) {
    session.step = next;
    session.expiresAt = Date.now() + SESSION_TIME_MS;
    sessions.set(telegramId, session);
    await ctx.reply(prompt(next));
    return;
  }

  // Последний шаг завершён, все поля гарантированно заполнены порядком STEPS.
  const user = await ensureUser(telegramId);
  const product = await db.product.create({ data: {
    ownerId: user.id, name: data.name!, brand: data.brand!, stores: data.stores!,
    basis: data.basis!, source: 'MANUAL',
    calories: data.calories!, proteins: data.proteins!, fats: data.fats!, carbs: data.carbs!,
  } });
  sessions.delete(telegramId);
  await ctx.reply('✅ Продукт сохранён в твоём личном каталоге:\n' + displayProduct(product), {
    reply_markup: new InlineKeyboard().text('➕ Съел — указать вес', `eat:${product.id}`),
  });
}

// Дневник личный: запрещаем взаимодействие с ботом в групповых чатах.
bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== 'private') return;
  await next();
});

bot.command('start', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  await ensureUser(telegramId);
  await ctx.reply(publicHelp(), {
    reply_markup: new InlineKeyboard()
      .text('➕ Новый продукт', 'action:new')
      .text('📅 Сегодня', 'action:today'),
  });
});
bot.command('help', (ctx) => ctx.reply(publicHelp()));
bot.command('cancel', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  sessions.delete(telegramId);
  await ctx.reply('Ввод отменён. /new — начать заново.');
});
bot.command('new', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  sessions.set(telegramId, {
    kind: 'new', step: 'name', data: {}, expiresAt: Date.now() + SESSION_TIME_MS,
  });
  await ctx.reply('Создаём продукт по этикетке. /cancel — отмена.\n' + prompt('name'));
});
bot.command('search', (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  return search(ctx, telegramId, ctx.match.trim());
});
bot.command('store', (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  return searchStore(ctx, telegramId, ctx.match.trim());
});
bot.command('barcode', (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  return lookupBarcode(ctx, telegramId, ctx.match.trim());
});
bot.command('today', (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  return showToday(ctx, telegramId);
});
bot.command('history', (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  return showHistory(ctx, telegramId);
});
bot.command('goal', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  const amount = parseNonNegativeNumber(ctx.match.trim());
  if (amount === null || !Number.isInteger(amount) || amount < 100 || amount > 10000) {
    await ctx.reply('Пример: /goal 2200 (целое число от 100 до 10000). Цель ты задаёшь самостоятельно.');
    return;
  }
  const user = await ensureUser(telegramId);
  await db.user.update({ where: { id: user.id }, data: { calorieGoal: amount } });
  await ctx.reply(`✅ Дневная цель: ${amount} ккал. Посмотреть: /today`);
});
bot.command('timezone', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  const timezone = ctx.match.trim();
  if (!timezone || timezone.length > 80) {
    await ctx.reply('Пример: /timezone Europe/Moscow или /timezone America/Chicago');
    return;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    await ctx.reply('Неизвестный часовой пояс. Укажи название IANA, например Europe/Moscow.');
    return;
  }
  const user = await ensureUser(telegramId);
  await db.user.update({ where: { id: user.id }, data: { timezone } });
  await ctx.reply(`✅ Часовой пояс дневника: ${timezone}. Новые записи будут относиться к соответствующему местному дню.`);
});
bot.command('undo', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  const user = await ensureUser(telegramId);
  const last = await db.foodEntry.findFirst({
    where: { userId: user.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (!last) {
    await ctx.reply('Нет записей для удаления.');
    return;
  }
  await db.foodEntry.delete({ where: { id: last.id } });
  await ctx.reply(`🗑 Удалено: ${last.productName} (${fmt(last.amount)} ${last.basis === 'ML100' ? 'мл' : 'г'}) от ${last.day}`);
});

bot.callbackQuery('action:new', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  await ctx.answerCallbackQuery();
  sessions.set(telegramId, {
    kind: 'new', step: 'name', data: {}, expiresAt: Date.now() + SESSION_TIME_MS,
  });
  await ctx.reply(prompt('name'));
});
bot.callbackQuery('action:today', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  await ctx.answerCallbackQuery();
  await showToday(ctx, telegramId);
});
bot.callbackQuery(/^eat:(\d+)$/, async (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  await ctx.answerCallbackQuery();
  const productId = Number(ctx.match[1]);
  if (!Number.isSafeInteger(productId)) return;
  const user = await ensureUser(telegramId);
  const product = await db.product.findFirst({
    where: { id: productId, OR: [{ ownerId: user.id }, { ownerId: null }] },
  });
  if (!product) {
    await ctx.reply('Продукт недоступен.');
    return;
  }
  sessions.set(telegramId, { kind: 'weight', productId, expiresAt: Date.now() + SESSION_TIME_MS });
  await ctx.reply(`Сколько ${product.name} ты съел${product.basis === 'ML100' ? ' или выпил' : ''}? ` +
    `Введи количество в ${product.basis === 'ML100' ? 'мл' : 'г'} (например: 150).`);
});

bot.on('message:text', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;
  const text = ctx.message.text.trim();
  if (!text) return;
  const session = sessions.get(telegramId);
  if (session) {
    if (session.expiresAt < Date.now()) {
      sessions.delete(telegramId);
      await ctx.reply('Время ввода истекло. Начни заново через /new или /search.');
      return;
    }
    if (session.kind === 'new') {
      await processNew(ctx, telegramId, text, session);
      return;
    }
    const amount = parsePortion(text);
    if (amount === null) {
      await ctx.reply('Нужно число больше нуля и не больше 10000, например 150 или 150,5. /cancel — отмена.');
      return;
    }
    sessions.delete(telegramId);
    await addEntry(ctx, telegramId, session.productId, amount);
    return;
  }
  if (text.startsWith('/')) {
    await ctx.reply('Неизвестная команда. Все команды: /help');
  } else if (/^\d{8,14}$/.test(text)) {
    await lookupBarcode(ctx, telegramId, text);
  } else {
    await search(ctx, telegramId, text);
  }
});

bot.catch(async (error) => {
  console.error('Ошибка обработки Telegram-обновления:', error.error);
  try {
    await error.ctx.reply('Произошла ошибка сервера. Попробуй ещё раз.');
  } catch { /* например, пользователь заблокировал бота */ }
});

async function main() {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Меню и список команд' },
    { command: 'new', description: 'Добавить продукт с этикетки' },
    { command: 'search', description: 'Поиск по названию' },
    { command: 'store', description: 'Поиск по магазину' },
    { command: 'barcode', description: 'Поиск по штрихкоду' },
    { command: 'today', description: 'КБЖУ за сегодня' },
    { command: 'history', description: 'История за 7 дней' },
    { command: 'goal', description: 'Установить дневную цель ккал' },
    { command: 'undo', description: 'Удалить последнюю запись' },
    { command: 'timezone', description: 'Установить часовой пояс' },
    { command: 'cancel', description: 'Отменить ввод' },
  ]);
  console.log('Бот запускается через long polling…');
  await bot.start();
}

process.once('SIGINT', () => { bot.stop(); void db.$disconnect(); });
process.once('SIGTERM', () => { bot.stop(); void db.$disconnect(); });
main().catch(async (error) => {
  console.error('Не удалось запустить бота:', error);
  await db.$disconnect();
  process.exitCode = 1;
});
