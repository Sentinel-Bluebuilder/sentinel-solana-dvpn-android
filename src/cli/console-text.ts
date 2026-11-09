// ─── Plain ASCII for piped Windows output (owner VM runs: "…" showed as mojibake) ───
// A real Windows console gets UTF-16 from Node and shows every glyph. Piped output (PowerShell 5.1,
// cmd redirection, ssh) is read with the OEM code page (cp437), so UTF-8 punctuation turns into
// junk. There, and only there, human text is folded to ASCII. JSON output is never changed.
// DVPN_UTF8=1 keeps UTF-8 for a reader that decodes it.
const FOLD: Record<string, string> = {
  '…': '...', '·': '-', '•': '*', '→': '->', '←': '<-', '—': '-', '–': '-', '‘': "'", '’': "'", '“': '"', '”': '"',
  '✓': 'OK', '✔': 'OK', '✗': 'x', '✕': 'x', '×': 'x', '≈': '~', '≥': '>=', '≤': '<=', '±': '+/-', '°': ' deg', ' ': ' ',
};

export function foldAscii(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch.charCodeAt(0) < 128) out += ch;
    else if (FOLD[ch] !== undefined) out += FOLD[ch];
    else {
      // Accents off (São Paulo → Sao Paulo); anything else that has no ASCII form becomes "?".
      const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      out += /^[\x00-\x7f]+$/.test(base) ? base : '?';
    }
  }
  return out;
}

/** Fold only for piped output on Windows (see above). */
export function consoleText(s: string, stream: { isTTY?: boolean } = process.stdout): string {
  if (process.platform !== 'win32' || stream.isTTY || process.env.DVPN_UTF8 === '1') return s;
  return foldAscii(s);
}
