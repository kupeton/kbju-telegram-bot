import assert from 'node:assert/strict';
import test from 'node:test';
import { localDay, parseNonNegativeNumber, parsePortion, scaleNutrition, sumNutrition } from '../src/nutrition.ts';

test('порция 150 г масштабирует КБЖУ на 100 г', () => {
  assert.deepEqual(scaleNutrition({ calories: 100, proteins: 20, fats: 4, carbs: 2 }, 150), {
    calories: 150, proteins: 30, fats: 6, carbs: 3,
  });
});

test('суммирование нескольких продуктов', () => {
  assert.deepEqual(sumNutrition([
    { calories: 100, proteins: 5, fats: 2, carbs: 12 },
    { calories: 200, proteins: 10, fats: 1, carbs: 22 },
  ]), { calories: 300, proteins: 15, fats: 3, carbs: 34 });
});

test('запятая в дробном числе и проверка веса', () => {
  assert.equal(parseNonNegativeNumber('2,5'), 2.5);
  assert.equal(parsePortion('0'), null);
  assert.equal(parsePortion('-1'), null);
  assert.equal(parsePortion('150'), 150);
  assert.equal(parsePortion('123abc'), null);
});

test('день учитывает часовой пояс', () => {
  const date = new Date('2026-10-15T22:30:00.000Z');
  assert.equal(localDay(date, 'Europe/Moscow'), '2026-10-16');
  assert.equal(localDay(date, 'America/Chicago'), '2026-10-15');
});
