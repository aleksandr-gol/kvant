import { describe, expect, test } from 'bun:test';
import { looksLikeAnswerText, mergeAnswerParts } from './agent.js';

const table = '### Сравнение\n\n| Тикер | P/E |\n|---|---|\n| SBER | 3.43 |\n| VTBR | 1.46 |\n' + 'Комментарий к таблице. '.repeat(8);

describe('answer parts written alongside tool calls', () => {
  test('таблица — часть ответа, короткая фраза — нет', () => {
    expect(looksLikeAnswerText(table)).toBe(true);
    expect(looksLikeAnswerText('Сейчас получу котировки.')).toBe(false);
  });
  test('кусок идёт перед финальным текстом', () => {
    expect(mergeAnswerParts([table.trim()], '### Черновики\n- SBER 102 лота')).toBe(`${table.trim()}\n\n### Черновики\n- SBER 102 лота`);
  });
  test('если модель повторила таблицу в финале, дубля нет', () => {
    expect(mergeAnswerParts([table.trim()], `${table.trim()}\n\nИтог.`)).toBe(`${table.trim()}\n\nИтог.`);
  });
  test('повтор с другими отступами и жирным шрифтом тоже не дублируется', () => {
    const reformatted = table.replace(/\| /g, '|  ').replace('Комментарий', '**Комментарий**');
    expect(mergeAnswerParts([table.trim()], reformatted)).toBe(reformatted.trim());
  });
  test('без кусков — финальный текст как есть', () => {
    expect(mergeAnswerParts([], 'Ответ')).toBe('Ответ');
  });
});
