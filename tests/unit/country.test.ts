// F6.8: whatever a node reports, the app shows one ISO code, one flag, one name.
import { describe, expect, it } from 'vitest';
import { countryName, countryNameToCode, continentOf, flagEmoji } from '../../src/core/nodes/country';

describe('country normalisation (F6.8)', () => {
  it.each([
    ['The Netherlands', 'NL'], ['Turkiye', 'TR'], ['Türkiye', 'TR'], ['DR Congo', 'CD'], ['Czechia', 'CZ'],
    ['Russian Federation', 'RU'], ['Viet Nam', 'VN'], ['South Korea', 'KR'], ['UAE', 'AE'], ['UK', 'GB'],
    ['USA', 'US'], ['us', 'US'], ['  Germany ', 'DE'], ['Hong Kong SAR China', 'HK'], ['japan', 'JP'], ['Côte d’Ivoire'.replace('’', "'"), 'CI'],
  ])('%s → %s', (input, code) => expect(countryNameToCode(input)).toBe(code));
  it('unknown input gives no code (never a wrong flag)', () => {
    expect(countryNameToCode('Atlantis')).toBe('');
    expect(countryNameToCode('')).toBe('');
  });
});

describe('display names (SDK short names)', () => {
  it.each([['HK', 'Hong Kong'], ['TR', 'Turkey'], ['CD', 'DR Congo'], ['MM', 'Myanmar'], ['US', 'United States'], ['GB', 'United Kingdom'], ['DE', 'Germany'], ['IN', 'India']])('%s → %s', (code, name) => expect(countryName(code)).toBe(name));
  it('garbage is Unknown, not a crash', () => expect(countryName('???')).toBe('Unknown'));
  it('continents and flags', () => {
    expect(continentOf('in')).toBe('Asia');
    expect(flagEmoji('DE')).toBe('🇩🇪');
    expect(flagEmoji('x')).toBe('');
  });
});
