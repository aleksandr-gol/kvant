import { buildCompactToolDescriptions } from '../tools/registry.js';
import { buildSkillMetadataSection, discoverSkills } from '../skills/index.js';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChannelProfile } from './channels.js';
import { kvantPath } from '../utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Returns the current date formatted for prompts.
 */
export function getCurrentDate(): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  };
  return new Date().toLocaleDateString('ru-RU', { ...options, timeZone: 'Europe/Moscow' });
}

/**
 * Load SOUL.md content from user override or bundled file.
 */
export async function loadSoulDocument(): Promise<string | null> {
  const userSoulPath = kvantPath('SOUL.md');
  try {
    return await readFile(userSoulPath, 'utf-8');
  } catch {
    // Continue to bundled fallback when user override is missing/unreadable.
  }

  const bundledSoulPath = join(__dirname, '../../SOUL.md');
  try {
    return await readFile(bundledSoulPath, 'utf-8');
  } catch {
    // SOUL.md is optional; keep prompt behavior unchanged when absent.
  }

  return null;
}

/**
 * Load user-defined research rules from .kvant/RULES.md.
 * Returns null if the file doesn't exist (rules are optional).
 */
export async function loadRulesDocument(): Promise<string | null> {
  const rulesPath = kvantPath('RULES.md');
  try {
    return await readFile(rulesPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Build the skills section for the system prompt.
 * Only includes skill metadata if skills are available.
 */
function buildSkillsSection(): string {
  const skills = discoverSkills();
  
  if (skills.length === 0) {
    return '';
  }

  const skillList = buildSkillMetadataSection();
  
  return `## Доступные сценарии (skills)

${skillList}

## Как использовать сценарии

- Проверь, подходит ли готовый сценарий под задачу
- Если подходит — вызови его ПЕРВЫМ действием через инструмент skill
- Сценарии описывают проверенный порядок работы для сложных задач (DCF, разбор портфеля, лестница облигаций)
- Не вызывай повторно сценарий, уже вызванный в этом запросе`;
}

function buildMemorySection(memoryFiles: string[], memoryContext?: string | null): string {
  const fileListSection = memoryFiles.length > 0
    ? `\nФайлы памяти: ${memoryFiles.join(', ')}`
    : '';

  const contextSection = memoryContext
    ? `\n\n### Что ты знаешь о пользователе\n\n${memoryContext}`
    : '';

  return `## Память

У тебя есть постоянная память в markdown-файлах .kvant/memory/.${fileListSection}${contextSection}

### Вспомнить
memory_search ищет по файлам памяти и прошлым диалогам.

**ВАЖНО:** перед персональными советами — покупка/продажа, состав портфеля, размер позиции —
СНАЧАЛА вызови memory_search, чтобы вспомнить цели, отношение к риску, ограничения и прошлые решения пользователя.
memory_get читает нужный раздел целиком.

### Сохранить
Используй **memory_update** (не write_file/edit_file):
- запомнить — просто передай content;
- заметка дня — file="daily";
- правка или удаление — action="edit"/"delete" с old_text (сначала проверь текст через memory_get).`;
}

// ============================================================================
// Default System Prompt (for backward compatibility)
// ============================================================================

/**
 * Default system prompt used when no specific prompt is provided.
 */
export const DEFAULT_SYSTEM_PROMPT = `Ты — Квант, ассистент-аналитик российского фондового рынка.

Текущая дата: ${getCurrentDate()}

Отвечай на русском, коротко и точно.

## Поведение

- Точность важнее согласия
- Профессиональный, объективный тон
- Тщательно, но без лишнего

## Формат

- Коротко и прямо
- Для несравнительной информации — обычный текст или простой список
- Без markdown-заголовков; **жирный** — редко, для ключевых чисел`;

// ============================================================================
// Group Chat Context
// ============================================================================

export type GroupContext = {
  groupName?: string;
  membersList?: string;
  activationMode: 'mention';
};

/**
 * Build a system prompt section for group chat context.
 */
export function buildGroupSection(ctx: GroupContext): string {
  const lines: string[] = ['## Group Chat'];
  lines.push('');
  if (ctx.groupName) {
    lines.push(`You are participating in the WhatsApp group "${ctx.groupName}".`);
  } else {
    lines.push('You are participating in a WhatsApp group chat.');
  }
  lines.push('You were activated because someone @-mentioned you.');
  lines.push('');
  lines.push('### Group behavior');
  lines.push('- Address the person who mentioned you by name');
  lines.push('- Reference recent group context when relevant');
  lines.push('- Keep responses concise — this is a group chat, not a 1:1 conversation');
  lines.push('- Do not repeat information that was already shared in the group');

  if (ctx.membersList) {
    lines.push('');
    lines.push('### Group members');
    lines.push(ctx.membersList);
  }

  return lines.join('\n');
}

// ============================================================================
// System Prompt
// ============================================================================

/**
 * Build the system prompt for the agent.
 * @param model - The model name (used to get appropriate tool descriptions)
 * @param soulContent - Optional SOUL.md identity content
 * @param channel - Delivery channel (e.g., 'whatsapp', 'cli') — selects formatting profile
 */
export function buildSystemPrompt(
  model: string,
  soulContent?: string | null,
  channel?: string,
  groupContext?: GroupContext,
  memoryFiles?: string[],
  memoryContext?: string | null,
  rulesContent?: string | null,
  includeMemory: boolean = true,
): string {
  const toolDescriptions = buildCompactToolDescriptions(model);
  const profile = getChannelProfile(channel);

  const behaviorBullets = profile.behavior.map(b => `- ${b}`).join('\n');
  const formatBullets = profile.responseFormat.map(b => `- ${b}`).join('\n');

  const tablesSection = profile.tables
    ? `\n## Tables (for comparative/tabular data)\n\n${profile.tables}`
    : '';

  return `Ты — Квант, ${profile.label}-ассистент для исследования российского фондового рынка. У тебя есть инструменты с данными Мосбиржи, Банка России, отчётностью МСФО и новостями.

Текущая дата: ${getCurrentDate()} (время московское)

${profile.preamble}

## Инструменты

${toolDescriptions}

## Как пользоваться инструментами

- Когда нужен инструмент, вызывай его сразу, без вступительного текста: текст пиши только в итоговом ответе, после всех вызовов.
- Сначала данные, потом вывод. На вопросы о ценах, ставках, отчётности, дивидендах, облигациях и портфеле отвечай только после вызова инструментов.
- get_quotes, get_company_financials, get_dividends и draft_order принимают сразу несколько бумаг (tickers) — запрашивай все бумаги одним вызовом, а не по одной.
- Если не уверен в тикере, не угадывай латинский код: передай название по-русски («Т-Банк», «Сбербанк», «ОФЗ 26238») — инструменты сами найдут бумагу, или вызови find_instrument.
- Для расчётов портфеля и накоплений используй analyze_portfolio и plan_savings: они считают детерминированно. Не пересчитывай их числа в уме.
- Для сделок — только draft_order: заявки по всем бумагам с одинаковой суммой — одним вызовом через tickers. Лоты, сумму и комиссию заявки не считай сам — бери из ответа draft_order. Ты не можешь и не должен исполнять заявки.
- Дивидендную доходность за 12 месяцев бери из get_dividends (поле summary), а не из таблицы отчётности.
- Шагов у тебя достаточно: если задача требует нескольких бумаг или заявок, доведи её до конца, а не сокращай.
- web_fetch — только когда заголовков новостей мало и нужны детали по конкретной ссылке.
- Если результат сохранён в файл ("persisted to file"), читай нужные части через read_file.
- spawn_subagent (если доступен) — для независимых подзадач; несколько независимых вызовов в одном ходе выполняются параллельно.
- Без инструментов отвечай только на вопросы об определениях, устойчивых фактах и на разговорные реплики.

${buildSkillsSection()}

${includeMemory ? buildMemorySection(memoryFiles ?? [], memoryContext) : ''}

## Поведение

${behaviorBullets}

${rulesContent ? `## Правила исследования

Эти правила задал пользователь. Соблюдай их в каждом запросе.

${rulesContent}
` : ''}
${soulContent ? `## Личность

${soulContent}

Следуй описанной личности и инвестиционной философии: они задают тон, ценности и подход к финансовым вопросам.
` : ''}

## Формат ответа

${formatBullets}${tablesSection}${groupContext ? '\n\n' + buildGroupSection(groupContext) : ''}`;
}

// ============================================================================
// User Prompts
// ============================================================================


