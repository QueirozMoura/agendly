// Datas e horas na timezone DA EMPRESA (imutável, R9), só com `Intl` (nenhuma dependência de fuso no frontend).
// O servidor guarda instantes em UTC; a tela mostra e recebe hora local da empresa. Horário inexistente (lacuna do
// horário de verão) é recusado; resolução de ambiguidades alinhada com o backend de referência (`date-fns-tz`).

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

function localParts(utcMs: number, tz: string) {
  const out: Record<string, number> = {};
  for (const p of parts(tz).formatToParts(new Date(utcMs)))
    if (p.type !== "literal") out[p.type] = Number(p.value);
  // Alguns motores devolvem "24" para a meia-noite mesmo com `h23`: normaliza para 0 (senão o dia rolaria).
  out.hour = (out.hour ?? 0) % 24;
  return out as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

/** Deslocamento (milissegundos) da `tz` em relação ao UTC no instante dado. */
function calcOffsetMs(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// `datetime-local` entrega "AAAA-MM-DDTHH:mm" (ou com segundos, conforme o navegador/`step`).
const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** "2031-03-03T10:00" (hora local da empresa) ⇒ instante ISO em UTC, ou `null` se inválido/inexistente. */
export function zonedLocalToUtcIso(local: string, tz: string): string | null {
  const m = LOCAL_INPUT.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  const utcWall = Date.UTC(y, mo - 1, d, h, mi, sec);
  const check = new Date(utcWall);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    h > 23 ||
    sec > 59 ||
    mi > 59
  )
    return null; // 31/02 etc.

  // Resolução compatível com o comportamento real do backend (date-fns-tz em UTC):
  const o1 = calcOffsetMs(utcWall, tz);
  let utcGuess = utcWall - o1;
  const o2 = calcOffsetMs(utcGuess, tz);
  let finalOffset = o1;
  if (o1 !== o2) {
    utcGuess -= o2 - o1;
    const o3 = calcOffsetMs(utcGuess, tz);
    if (o2 === o3) {
      finalOffset = o2;
    } else {
      finalOffset = Math.max(o2, o3);
    }
  }

  const result = utcWall - finalOffset;
  const p = localParts(result, tz);
  if (
    p.year !== y ||
    p.month !== mo ||
    p.day !== d ||
    p.hour !== h ||
    p.minute !== mi ||
    p.second !== sec
  ) {
    return null; // Lacuna do horário de verão (horário inexistente)
  }

  return new Date(result).toISOString();
}

/** Instante ISO ⇒ "YYYY-MM-DDTHH:mm" na `tz` (valor de `<input type="datetime-local">`). */
export function utcIsoToZonedLocal(iso: string, tz: string): string {
  if (Number.isNaN(new Date(iso).getTime())) return "";
  const p = localParts(new Date(iso).getTime(), tz);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** "ter., 03/03/2031 10:00" para mostrar ao usuário (pt-BR, na timezone da empresa). */
export function formatDateTime(iso: string, tz: string): string {
  // dado inesperado: mostra o texto cru em vez de quebrar a tela
  if (Number.isNaN(new Date(iso).getTime())) return iso;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date(iso))
    .replaceAll(",", "");
}

export const WEEKDAYS = [
  "Domingo",
  "Segunda-feira",
  "Terça-feira",
  "Quarta-feira",
  "Quinta-feira",
  "Sexta-feira",
  "Sábado",
] as const;

/** Horários em passos de 15 min (grade do expediente, D5). `end` inclui "24:00". */
export function timeOptions(kind: "start" | "end"): string[] {
  const out: string[] = [];
  const from = kind === "start" ? 0 : 15;
  const to = kind === "start" ? 24 * 60 - 15 : 24 * 60;
  for (let m = from; m <= to; m += 15)
    out.push(
      `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
    );
  return out;
}
