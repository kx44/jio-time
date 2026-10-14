// sched-api: create / get / save for the scheduler Mini App.
// Requests carry Telegram initData, validated with the bot token (create may be anonymous).
import {
  BOT_TOKEN, db, displayName, getBotUsername, loadEvent, openButton, summaryHtml, tg, validateInitData,
} from "../_shared/sched.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

// Only the GitHub Pages Mini App may call this from a browser. (Doesn't stop scripts,
// which is what initData validation and the limits below are for.) The page sends
// text/plain bodies so browsers skip the CORS preflight; Max-Age covers anything else.
const CORS = {
  "Access-Control-Allow-Origin": "https://kx44.github.io",
  "Vary": "Origin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_ID = /^[A-Za-z0-9]{10}$/;
const MAX_BODY_BYTES = 16_384;
const ANON_CREATES_PER_IP_PER_10_MIN = 10;
const ANON_CREATES_GLOBAL_PER_10_MIN = 300; // safety net if IPs are spoofed or missing
const EDIT_MIN_GAP_MS = 3000;
const MIN_SAVE_INTERVAL_MS = 1000;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

function validTz(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json({ error: "too large" }, 413);
  let body: Record<string, any>;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "too large" }, 413);
    body = JSON.parse(raw);
    if (!body || typeof body !== "object") throw new Error("not an object");
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (typeof body.initData !== "string" && body.initData !== undefined) return json({ error: "bad initData" }, 400);

  const user = await validateInitData(body.initData ?? "");
  // Telegram Desktop gives inline-launched Mini Apps no initData, so create may be
  // anonymous; the creator is filled in from chosen_inline_result. get/save need a user.
  if (!user && !(body.action === "create" && !body.initData)) {
    return json({ error: "invalid initData" }, 401);
  }

  if (body.id !== undefined && !EVENT_ID.test(String(body.id))) return json({ error: "Event not found" }, 404);

  try {
    if (!user) return await create(null, body, req);
    switch (body.action) {
      case "create": return await create(user, body, req);
      case "get": return await get(user, body);
      case "save": return await save(user, body);
      default: return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: "server error" }, 500);
  }
});

// Salted hash so raw IP addresses are never stored.
async function ipHash(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "";
  if (!ip) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${BOT_TOKEN}|${ip}`));
  return [...new Uint8Array(digest)].slice(0, 16).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function create(user: { id: number } | null, b: Record<string, any>, req: Request) {
  const title = String(b.title ?? "").trim().slice(0, 120);
  const dates = [...new Set((Array.isArray(b.dates) ? b.dates : []).map(String))]
    .filter((d) => ISO_DATE.test(d) && !isNaN(Date.parse(d))).sort();
  const startHour = Number(b.startHour), endHour = Number(b.endHour);
  const tz = String(b.tz || "Asia/Singapore");

  if (!title) return json({ error: "Title is required" }, 400);
  if (dates.length < 1 || dates.length > 62) return json({ error: "Pick 1–62 dates" }, 400);
  // Keep events short-lived so the hourly cleanup can remove them.
  const today = Date.now();
  if (Date.parse(dates[0]) < today - 2 * 864e5 || Date.parse(dates.at(-1)!) > today + 366 * 864e5) {
    return json({ error: "Dates must be within the next year" }, 400);
  }
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) ||
      startHour < 0 || endHour > 24 || endHour <= startHour) {
    return json({ error: "End hour must be after start hour" }, 400);
  }
  if (!validTz(tz)) return json({ error: "Unknown timezone" }, 400);

  const ip = user ? null : await ipHash(req);
  if (!user) {
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const [perIp, global] = await Promise.all([
      ip
        ? db.from("sched_events").select("id", { count: "exact", head: true })
          .eq("create_ip_hash", ip).gte("created_at", since)
        : Promise.resolve({ count: 0 }),
      db.from("sched_events").select("id", { count: "exact", head: true })
        .is("creator_id", null).gte("created_at", since),
    ]);
    if ((perIp.count ?? 0) >= ANON_CREATES_PER_IP_PER_10_MIN ||
        (global.count ?? 0) >= ANON_CREATES_GLOBAL_PER_10_MIN) {
      return json({ error: "Too many new events, try again in a few minutes" }, 429);
    }
  }

  const id = newId();
  const { error } = await db.from("sched_events").insert({
    id, title, dates, start_hour: startHour, end_hour: endHour, slot_minutes: 30, tz,
    creator_id: user?.id ?? null, create_ip_hash: ip,
  });
  if (error) throw error;
  return json({ id, botUsername: await getBotUsername() });
}

async function get(user: { id: number }, b: Record<string, any>) {
  const loaded = await loadEvent(String(b.id ?? ""));
  if (!loaded) return json({ error: "This event has ended or was removed." }, 404);
  const { ev, responses } = loaded;
  return json({
    event: {
      id: ev.id, title: ev.title, dates: ev.dates, startHour: ev.start_hour, endHour: ev.end_hour,
      slotMinutes: ev.slot_minutes, tz: ev.tz, isCreator: ev.creator_id === user.id,
    },
    responses: responses.map((r) => ({ userId: r.user_id, name: r.name, slots: r.slots })),
    me: user.id,
  });
}

async function save(user: Parameters<typeof displayName>[0], b: Record<string, any>) {
  const id = String(b.id ?? "");
  const { data: ev } = await db.from("sched_events").select("*").eq("id", id).maybeSingle();
  if (!ev) return json({ error: "This event has ended or was removed." }, 404);

  // Throttle each user so a script can't hammer the DB and Telegram edits.
  const { data: prev } = await db.from("sched_responses").select("updated_at")
    .eq("event_id", id).eq("user_id", user.id).maybeSingle();
  if (prev && Date.now() - Date.parse(prev.updated_at) < MIN_SAVE_INTERVAL_MS) {
    return json({ error: "Saving too fast", retryAfterMs: MIN_SAVE_INTERVAL_MS }, 429);
  }

  const total = ((ev.end_hour - ev.start_hour) * 60 / ev.slot_minutes) * ev.dates.length;
  const slots = [...new Set((Array.isArray(b.slots) ? b.slots : []).map(Number))]
    .filter((s) => Number.isInteger(s) && s >= 0 && s < total)
    .sort((x, y) => x - y);

  const { error } = slots.length
    ? await db.from("sched_responses").upsert({
      event_id: id, user_id: user.id, name: displayName(user), slots, updated_at: new Date().toISOString(),
    })
    : await db.from("sched_responses").delete().eq("event_id", id).eq("user_id", user.id);
  if (error) throw error;

  const loaded = (await loadEvent(id))!;
  await scheduleMessageRefresh(loaded.ev);
  return json({
    ok: true,
    responses: loaded.responses.map((r) => ({ userId: r.user_id, name: r.name, slots: r.slots })),
  });
}

// Coalesce edits so a burst of saves makes at most one Telegram edit per event every
// EDIT_MIN_GAP_MS (Telegram rate-limits edits in busy groups). The edit runs after the
// response is sent and reads the latest data when it fires, so the last save always shows.
async function scheduleMessageRefresh(ev: Parameters<typeof summaryHtml>[0]) {
  if (!ev.inline_message_ids.length) return;
  const { data: delayMs, error } = await db.rpc("sched_claim_edit", { p_event_id: ev.id, p_min_gap_ms: EDIT_MIN_GAP_MS });
  if (error) console.error("claim edit", error);
  if (delayMs === null || delayMs === undefined) return; // an edit is already scheduled
  EdgeRuntime.waitUntil((async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    await db.rpc("sched_start_edit", { p_event_id: ev.id });
    const fresh = await loadEvent(ev.id);
    if (fresh) await refreshMessages(fresh.ev, fresh.responses);
  })().catch((e) => console.error("refresh messages", e)));
}

// Edit every shared copy of the event message. Edits never notify.
async function refreshMessages(ev: Parameters<typeof summaryHtml>[0], responses: Parameters<typeof summaryHtml>[1]) {
  if (!ev.inline_message_ids.length) return;
  const text = summaryHtml(ev, responses);
  const reply_markup = await openButton(ev.id); // editMessageText drops the keyboard unless re-sent
  await Promise.all(ev.inline_message_ids.map((inline_message_id) =>
    tg("editMessageText", {
      inline_message_id, text, parse_mode: "HTML", reply_markup,
      link_preview_options: { is_disabled: true },
    })
  ));
}
