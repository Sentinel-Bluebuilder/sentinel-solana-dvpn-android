// ─── Country names + continents (F6.8, F7) ───
// Nodes store an ISO-3166 alpha-2 code on chain, so names come from Intl (built
// into Node and Chromium) instead of a hand-kept map. Continent grouping is
// ported from the Sentinel JS SDK app-helpers.js CONTINENT_BY_CODE idea.

let regionNames: Intl.DisplayNames | null = null;
// Short common names (Sentinel SDK COUNTRY-FLAGS standard) where Intl's CLDR name is
// long or political ("Hong Kong SAR China", "Myanmar (Burma)", "Congo - Kinshasa").
const DISPLAY: Record<string, string> = {
  HK: 'Hong Kong', MO: 'Macau', CD: 'DR Congo', CG: 'Republic of the Congo', MM: 'Myanmar', PS: 'Palestine',
  KR: 'South Korea', KP: 'North Korea', RU: 'Russia', TR: 'Turkey', CZ: 'Czech Republic', VN: 'Vietnam',
  IR: 'Iran', SY: 'Syria', LA: 'Laos', MD: 'Moldova', TZ: 'Tanzania', BO: 'Bolivia', VE: 'Venezuela',
  XK: 'Kosovo', CI: "Côte d'Ivoire", BA: 'Bosnia and Herzegovina', MK: 'North Macedonia', US: 'United States', GB: 'United Kingdom',
};

// Names and variants a node operator (or a metadata field) may report, lower-case → ISO (F6.8).
const VARIANTS: Record<string, string> = {
  'the netherlands': 'NL', netherlands: 'NL', holland: 'NL', turkiye: 'TR', 'türkiye': 'TR', turkey: 'TR',
  'dr congo': 'CD', 'democratic republic of the congo': 'CD', 'congo - kinshasa': 'CD', 'congo - brazzaville': 'CG',
  'republic of the congo': 'CG', czechia: 'CZ', 'czech republic': 'CZ', 'russian federation': 'RU', russia: 'RU',
  'viet nam': 'VN', vietnam: 'VN', 'hong kong': 'HK', 'hong kong sar china': 'HK', 'south korea': 'KR', korea: 'KR',
  'republic of korea': 'KR', 'korea, republic of': 'KR', 'north korea': 'KP', uae: 'AE', 'united arab emirates': 'AE',
  uk: 'GB', 'united kingdom': 'GB', 'great britain': 'GB', england: 'GB', usa: 'US', 'united states': 'US',
  'united states of america': 'US', america: 'US', iran: 'IR', 'iran, islamic republic of': 'IR', syria: 'SY',
  moldova: 'MD', 'republic of moldova': 'MD', laos: 'LA', 'macedonia': 'MK', 'north macedonia': 'MK', 'myanmar (burma)': 'MM',
  burma: 'MM', 'taiwan': 'TW', 'palestine': 'PS', 'ivory coast': 'CI', "cote d'ivoire": 'CI', "côte d'ivoire": 'CI',
  'bosnia': 'BA', kosovo: 'XK', macau: 'MO', macao: 'MO', 'tanzania, united republic of': 'TZ', 'bolivia': 'BO', 'venezuela': 'VE',
};

let nameIndex: Map<string, string> | null = null;
/** Every ISO region's English name → code, built once from Intl. */
function byName(): Map<string, string> {
  if (nameIndex) return nameIndex;
  nameIndex = new Map();
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    const n = names.of(code);
    if (n && n !== code) nameIndex.set(n.toLowerCase(), code);
  }
  return nameIndex;
}

/** Any reported country (code, name or known variant) → ISO alpha-2, or '' when it cannot be told. */
export function countryNameToCode(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const k = raw.toLowerCase().replace(/\s+/g, ' ');
  if (VARIANTS[k]) return VARIANTS[k]; // before the 2-letter rule: "UK" is GB, not a code
  if (/^[a-z]{2}$/.test(k)) return k.toUpperCase();
  return byName().get(k) ?? '';
}

export function countryName(code: string): string {
  const c = String(code ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return 'Unknown';
  if (DISPLAY[c]) return DISPLAY[c];
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(c) ?? c;
  } catch (err) {
    console.warn(`[country] no display name for ${c}: ${(err as Error).message}`);
    return c;
  }
}

const CONTINENTS: Record<string, string[]> = {
  'Europe': ['AD', 'AL', 'AT', 'BA', 'BE', 'BG', 'BY', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'RU', 'SE', 'SI', 'SK', 'SM', 'UA', 'VA', 'XK'],
  'Asia': ['AE', 'AF', 'AM', 'AZ', 'BD', 'BH', 'BN', 'BT', 'CN', 'GE', 'HK', 'ID', 'IL', 'IN', 'IQ', 'IR', 'JO', 'JP', 'KG', 'KH', 'KR', 'KW', 'KZ', 'LA', 'LB', 'LK', 'MM', 'MN', 'MO', 'MV', 'MY', 'NP', 'OM', 'PH', 'PK', 'PS', 'QA', 'SA', 'SG', 'SY', 'TH', 'TJ', 'TM', 'TR', 'TW', 'UZ', 'VN', 'YE'],
  'North America': ['AG', 'BB', 'BS', 'BZ', 'CA', 'CR', 'CU', 'DM', 'DO', 'GD', 'GT', 'HN', 'HT', 'JM', 'KN', 'LC', 'MX', 'NI', 'PA', 'PR', 'SV', 'TT', 'US', 'VC'],
  'South America': ['AR', 'BO', 'BR', 'CL', 'CO', 'EC', 'GY', 'PE', 'PY', 'SR', 'UY', 'VE'],
  'Africa': ['AO', 'BF', 'BI', 'BJ', 'BW', 'CD', 'CF', 'CG', 'CI', 'CM', 'CV', 'DJ', 'DZ', 'EG', 'ER', 'ET', 'GA', 'GH', 'GM', 'GN', 'GQ', 'GW', 'KE', 'KM', 'LR', 'LS', 'LY', 'MA', 'MG', 'ML', 'MR', 'MU', 'MW', 'MZ', 'NA', 'NE', 'NG', 'RW', 'SC', 'SD', 'SL', 'SN', 'SO', 'SS', 'ST', 'SZ', 'TD', 'TG', 'TN', 'TZ', 'UG', 'ZA', 'ZM', 'ZW'],
  'Oceania': ['AU', 'FJ', 'FM', 'KI', 'MH', 'NR', 'NZ', 'PG', 'PW', 'SB', 'TO', 'TV', 'VU', 'WS'],
};

const BY_CODE = new Map<string, string>();
for (const [cont, codes] of Object.entries(CONTINENTS)) for (const c of codes) BY_CODE.set(c, cont);

export function continentOf(code: string): string {
  return BY_CODE.get(String(code ?? '').toUpperCase()) ?? 'Other';
}

/** Regional-indicator flag emoji (fallback text only — the UI renders bundled SVG flags, D8). */
export function flagEmoji(code: string): string {
  const c = String(code ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}
