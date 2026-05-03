// Compact German relative-time formatter for paired-peer "last seen"
// timestamps in the Settings → SYNCHRONISIERUNG section.
//
// Backend supplies Unix seconds; null means the peer was paired but
// never reachable since (e.g. paired offline, or peer hasn't been on
// the LAN since first handshake). UI surfaces null as "nie".

const MIN = 60;
const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Now, in Unix seconds. Hoisted so tests can stub it. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function relativeTime(unixSeconds: number | null | undefined): string {
  if (unixSeconds == null) return "nie";
  const delta = nowSeconds() - unixSeconds;
  if (delta < 0) return "gerade eben";
  if (delta < 45) return "gerade eben";
  if (delta < HOUR) {
    const m = Math.max(1, Math.round(delta / MIN));
    return m === 1 ? "vor 1 Minute" : `vor ${m} Minuten`;
  }
  if (delta < DAY) {
    const h = Math.round(delta / HOUR);
    return h === 1 ? "vor 1 Stunde" : `vor ${h} Stunden`;
  }
  if (delta < WEEK) {
    const d = Math.round(delta / DAY);
    return d === 1 ? "vor 1 Tag" : `vor ${d} Tagen`;
  }
  const w = Math.round(delta / WEEK);
  return w === 1 ? "vor 1 Woche" : `vor ${w} Wochen`;
}
