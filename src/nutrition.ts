export type Nutrition = {
  calories: number;
  proteins: number;
  fats: number;
  carbs: number;
};

export function parseNonNegativeNumber(value: string): number | null {
  const cleaned = value.trim().replace(',', '.');
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parsePortion(value: string): number | null {
  const amount = parseNonNegativeNumber(value);
  return amount !== null && amount > 0 && amount <= 10000 ? amount : null;
}

export function scaleNutrition(base: Nutrition, quantity: number): Nutrition {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Количество должно быть положительным');
  }
  const factor = quantity / 100;
  return {
    calories: base.calories * factor,
    proteins: base.proteins * factor,
    fats: base.fats * factor,
    carbs: base.carbs * factor,
  };
}

export function sumNutrition(entries: Nutrition[]): Nutrition {
  return entries.reduce<Nutrition>(
    (acc, value) => ({
      calories: acc.calories + value.calories,
      proteins: acc.proteins + value.proteins,
      fats: acc.fats + value.fats,
      carbs: acc.carbs + value.carbs,
    }),
    { calories: 0, proteins: 0, fats: 0, carbs: 0 },
  );
}

export function localDay(date: Date = new Date(), timezone = 'Europe/Moscow'): string {
  // Номер дня получаем в заданном часовом поясе, а дату храним как YYYY-MM-DD.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function fmt(value: number): string {
  return (Math.round(value * 10) / 10).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

export function nutritionText(value: Nutrition): string {
  return `${fmt(value.calories)} ккал · Б ${fmt(value.proteins)} · Ж ${fmt(value.fats)} · У ${fmt(value.carbs)}`;
}
