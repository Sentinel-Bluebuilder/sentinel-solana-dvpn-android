// ─── One date format for tables and lists ───

/** Short local date + 24 h time: "Oct 20 · 20:53". */
export function when(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}
