import type { Nutrition } from './nutrition.ts';

export type ExternalProduct = Nutrition & {
  name: string;
  brand: string;
  barcode: string;
  basis: 'G100' | 'ML100';
};

type OffResponse = {
  status?: string;
  product?: {
    product_name?: string;
    product_name_ru?: string;
    brands?: string;
    nutrition_data_per?: string;
    nutriments?: Record<string, unknown>;
  };
};

function safeNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

export async function getProductByBarcode(barcode: string): Promise<ExternalProduct | null> {
  if (!/^\d{8,14}$/.test(barcode)) throw new Error('Нужен штрихкод из 8–14 цифр');
  const agent = process.env.OFF_USER_AGENT;
  if (!agent || agent.includes('example.com')) {
    throw new Error('Настрой OFF_USER_AGENT в .env — укажи свой контактный email');
  }

  const url = new URL(`https://world.openfoodfacts.org/api/v3/product/${barcode}`);
  url.searchParams.set('fields', 'product_name,product_name_ru,brands,nutrition_data_per,nutriments');
  url.searchParams.set('lc', 'ru');

  const response = await fetch(url, {
    headers: { 'User-Agent': agent, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Open Food Facts временно недоступен (HTTP ${response.status})`);
  const data = (await response.json()) as OffResponse;
  const product = data.product;
  if (!product || data.status === 'failure') return null;
  const n = product.nutriments ?? {};

  const calories = safeNumber(n['energy-kcal_100g']);
  const proteins = safeNumber(n['proteins_100g']);
  const fats = safeNumber(n['fat_100g']);
  const carbs = safeNumber(n['carbohydrates_100g']);
  const name = (product.product_name_ru || product.product_name || '').trim();
  if (!name || calories === null || proteins === null || fats === null || carbs === null) {
    return null; // Не выдумываем значения при неполных данных.
  }
  if (calories > 1000 || proteins > 100 || fats > 100 || carbs > 100) return null;

  return {
    name: name.slice(0, 150), brand: (product.brands ?? '').slice(0, 100),
    barcode, basis: product.nutrition_data_per === '100ml' ? 'ML100' : 'G100',
    calories, proteins, fats, carbs,
  };
}
