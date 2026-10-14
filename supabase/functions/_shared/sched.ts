// Shared helpers for the sched-bot and sched-api edge functions.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

export const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
export const APP_SHORT_NAME = Deno.env.get("TELEGRAM_APP_SHORT_NAME") ?? "";
export const MINI_APP_URL = Deno.env.get("SCHED_MINI_APP_URL") ?? "";

export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

export type SchedEvent = {
  id: string;
  title: string;
  dates: string[]; // YYYY-MM-DD
  start_hour: number;
  end_hour: number;
  slot_minutes: number;
  tz: string;
  creator_id: number;
  inline_message_ids: string[];
};

export type SchedResponse = {
  user_id: number;
  name: string;
  slots: number[];
  updated_at?: string;
};

// ---------- Telegram Bot API ----------

export async function tg(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false }));
  if (!json.ok) console.error(`tg ${method} failed`, json.description ?? res.status);
  return json;
}

let botUsername: string | null = null;
export async function getBotUsername(): Promise<string> {
  if (!botUsername) {
    const me = await tg("getMe", {});
    botUsername = me.result?.username ?? "";
  }
  return botUsername!;
}

export async function openButton(eventId: string) {
  const username = await getBotUsername();
  return {
    inline_keyboard: [[{
      text: "🗓 Add my availability",
      url: `https://t.me/${username}/${APP_SHORT_NAME}?startapp=${eventId}`,
    }]],
  };
}

// ---------- initData validation ----------

const enc = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export type TgUser = { id: number; first_name: string; last_name?: string; username?: string };

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export async function validateInitData(initData: string, maxAgeSec = 86400): Promise<TgUser | null> {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), BOT_TOKEN);
  const expected = toHex(await hmac(secret, checkString));
  if (!timingSafeEqual(expected, hash)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null");
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const displayName = (u: TgUser) =>
  [u.first_name, u.last_name].filter(Boolean).join(" ").slice(0, 64) || (u.username ?? `User ${u.id}`);

// ---------- Summary text ----------

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(iso: string, withDate: boolean) {
  const d = new Date(iso + "T00:00:00Z");
  const wd = WEEKDAYS[d.getUTCDay()];
  return withDate ? `${wd} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : wd;
}

// minutes from midnight -> { text: "3:30", ampm: "pm" }
function clock(mins: number) {
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { text: m ? `${h12}:${String(m).padStart(2, "0")}` : `${h12}`, ampm: h24 < 12 ? "am" : "pm" };
}

export function timeRange(startMin: number, endMin: number) {
  const a = clock(startMin), b = clock(endMin);
  return a.ampm === b.ampm ? `${a.text}–${b.text}${b.ampm}` : `${a.text}${a.ampm}–${b.text}${b.ampm}`;
}

function tzAbbrev(tz: string) {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(new Date()).find((p) => p.type === "timeZoneName");
    return part?.value ?? tz;
  } catch {
    return tz;
  }
}

/** Longest contiguous run (within one day) of slots where the most people are free. */
export function bestWindow(ev: SchedEvent, responses: SchedResponse[]) {
  const perDay = ((ev.end_hour - ev.start_hour) * 60) / ev.slot_minutes;
  const counts = new Array(perDay * ev.dates.length).fill(0);
  for (const r of responses) for (const s of r.slots) if (s >= 0 && s < counts.length) counts[s]++;
  const max = Math.max(0, ...counts);
  if (max === 0) return null;

  let best = { day: 0, from: 0, len: 0 };
  for (let d = 0; d < ev.dates.length; d++) {
    let run = 0;
    for (let s = 0; s <= perDay; s++) {
      if (s < perDay && counts[d * perDay + s] === max) run++;
      else {
        if (run > best.len) best = { day: d, from: s - run, len: run };
        run = 0;
      }
    }
  }
  const startMin = ev.start_hour * 60 + best.from * ev.slot_minutes;
  return { ...best, count: max, startMin, endMin: startMin + best.len * ev.slot_minutes };
}

export function summaryHtml(ev: SchedEvent, responses: SchedResponse[]) {
  const active = responses.filter((r) => r.slots.length > 0);
  const sorted = [...ev.dates].sort();
  const multiWeek = sorted.length > 7 ||
    (new Date(sorted.at(-1)!).getTime() - new Date(sorted[0]).getTime()) / 864e5 >= 7;

  const span = sorted.length === 1
    ? dayLabel(sorted[0], true)
    : `${dayLabel(sorted[0], true)} – ${dayLabel(sorted.at(-1)!, true)}`;
  const lines = [
    `🗓 <b>${escapeHtml(ev.title)}</b>`,
    `${span} · ${timeRange(ev.start_hour * 60, ev.end_hour * 60)} ${escapeHtml(tzAbbrev(ev.tz))}`,
  ];

  if (active.length === 0) {
    lines.push("No responses yet · tap below to add yours");
  } else {
    const best = bestWindow(ev, active);
    const who = `${active.length} responded`;
    if (!best) lines.push(`${who} · no overlap yet`);
    else {
      const day = dayLabel(ev.dates[best.day], multiWeek);
      const frac = best.count === active.length ? "everyone" : `${best.count}/${active.length}`;
      lines.push(`${who} · best: ${day} ${timeRange(best.startMin, best.endMin)} (${frac})`);
    }
  }
  return lines.join("\n");
}

export async function loadEvent(id: string) {
  const { data: ev } = await db.from("sched_events").select("*").eq("id", id).maybeSingle();
  if (!ev) return null;
  const { data: responses } = await db.from("sched_responses")
    .select("user_id,name,slots,updated_at").eq("event_id", id).order("updated_at");
  return { ev: ev as SchedEvent, responses: (responses ?? []) as SchedResponse[] };
}
