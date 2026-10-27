import assert from 'node:assert/strict';
import test from 'node:test';
import { getProductByBarcode } from '../src/off.ts';

test('штрихкод: API v3 и значения КБЖУ на 100 г', async () => {
  const previousAgent = process.env.OFF_USER_AGENT;
  const previousFetch = globalThis.fetch;
  process.env.OFF_USER_AGENT = 'TestKBJU/0.1 (contact@test.invalid)';
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /api\/v3\/product\/3017620422003/);
    assert.equal((init?.headers as Record<string, string>)['User-Agent'], process.env.OFF_USER_AGENT);
    return new Response(JSON.stringify({
      status: 'success',
      product: {
        product_name_ru: 'Проверенный тестовый продукт', brands: 'Тестовый бренд',
        nutriments: { 'energy-kcal_100g': 120, 'proteins_100g': 9, 'fat_100g': 4, 'carbohydrates_100g': 15 },
      },
    }), { status: 200 });
  };
  try {
    const product = await getProductByBarcode('3017620422003');
    assert.equal(product?.name, 'Проверенный тестовый продукт');
    assert.equal(product?.calories, 120);
    assert.equal(product?.fats, 4);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgent === undefined) delete process.env.OFF_USER_AGENT;
    else process.env.OFF_USER_AGENT = previousAgent;
  }
});
