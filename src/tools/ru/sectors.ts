/**
 * Sector map for liquid MOEX shares. MOEX ISS has no sector field, so the
 * portfolio check uses this list; unknown tickers fall into «Прочее».
 */
const SECTORS: Record<string, string[]> = {
  'Нефть и газ': ['GAZP', 'LKOH', 'ROSN', 'NVTK', 'TATN', 'TATNP', 'SNGS', 'SNGSP', 'SIBN', 'BANE', 'BANEP', 'TRNFP', 'RNFT'],
  'Финансы': ['SBER', 'SBERP', 'VTBR', 'T', 'MOEX', 'SVCB', 'MBNK', 'BSPB', 'CBOM', 'LEAS', 'RENI', 'SPBE', 'SFIN', 'DOMRF'],
  'Металлы и добыча': ['GMKN', 'PLZL', 'CHMF', 'NLMK', 'MAGN', 'ALRS', 'RUAL', 'POLY', 'SELG', 'UGLD', 'MTLR', 'MTLRP', 'RASP', 'ENPG', 'TRMK', 'VSMO'],
  'Химия и удобрения': ['PHOR', 'AKRN', 'KAZT', 'KAZTP', 'NKNC', 'NKNCP'],
  'Технологии': ['YDEX', 'OZON', 'POSI', 'ASTR', 'HEAD', 'VKCO', 'DIAS', 'SOFL', 'IVAT', 'CNRU', 'DATA', 'WUSH'],
  'Телеком': ['MTSS', 'RTKM', 'RTKMP'],
  'Потребительский сектор': ['MGNT', 'X5', 'FIXP', 'LENT', 'MVID', 'BELU', 'ABRD', 'AQUA', 'GCHE', 'HNFG', 'OKEY'],
  'Электроэнергетика': ['IRAO', 'HYDR', 'FEES', 'UPRO', 'OGKB', 'TGKA', 'MSNG', 'LSNG', 'LSNGP', 'MRKP', 'MRKC', 'ELFV'],
  'Недвижимость и стройка': ['SMLT', 'PIKK', 'LSRG', 'ETLN'],
  'Транспорт': ['AFLT', 'FLOT', 'NMTP', 'FESH', 'GLTR'],
  'Здравоохранение': ['MDMG', 'GEMC', 'PRMD', 'OZPH'],
  'Конгломераты': ['AFKS'],
  'Лесная промышленность': ['SGZH'],
};

const BY_TICKER = new Map<string, string>();
for (const [sector, tickers] of Object.entries(SECTORS)) {
  for (const t of tickers) BY_TICKER.set(t, sector);
}

export function sectorOf(ticker: string, kind?: string): string {
  if (kind === 'bond') return 'Облигации';
  if (kind === 'fund') return 'Фонды';
  if (kind === 'currency') return 'Валюта';
  return BY_TICKER.get(ticker.toUpperCase()) ?? 'Прочее';
}
