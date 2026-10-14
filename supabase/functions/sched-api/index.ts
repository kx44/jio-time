// sched-api: create / get / save for the scheduler Mini App.
// Every request carries Telegram initData, validated with the bot token.
import {
  db, displayName, loadEvent, openButton, summaryHtml, tg, validateInitData,
} from "../_shared/sched.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
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

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const user = await validateInitData(body.initData);
  if (!user) return json({ error: "invalid initData" }, 401);

  try {
    switch (body.action) {
      case "create": return await create(user, body);
      case "get": return await get(user, body);
      case "save": return await save(user, body);
      default: return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: "server error" }, 500);
  }
});

async function create(user: { id: number }, b: Record<string, any>) {
  const title = String(b.title ?? "").trim().slice(0, 120);
  const dates = [...new Set((Array.isArray(b.dates) ? b.dates : []).map(String))]
    .filter((d) => ISO_DATE.test(d) && !isNaN(Date.parse(d))).sort();
  const startHour = Number(b.startHour), endHour = Number(b.endHour);
  const tz = String(b.tz || "Asia/Singapore");

  if (!title) return json({ error: "Title is required" }, 400);
  if (dates.length < 1 || dates.length > 62) return json({ error: "Pick 1–62 dates" }, 400);
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) ||
      startHour < 0 || endHour > 24 || endHour <= startHour) {
    return json({ error: "End hour must be after start hour" }, 400);
  }
  if (!validTz(tz)) return json({ error: "Unknown timezone" }, 400);

  const id = newId();
  const { error } = await db.from("sched_events").insert({
    id, title, dates, start_hour: startHour, end_hour: endHour, slot_minutes: 30, tz, creator_id: user.id,
  });
  if (error) throw error;
  return json({ id });
}

async function get(user: { id: number }, b: Record<string, any>) {
  const loaded = await loadEvent(String(b.id ?? ""));
  if (!loaded) return json({ error: "Event not found" }, 404);
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
  if (!ev) return json({ error: "Event not found" }, 404);

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
  await refreshMessages(loaded.ev, loaded.responses);
  return json({
    ok: true,
    responses: loaded.responses.map((r) => ({ userId: r.user_id, name: r.name, slots: r.slots })),
  });
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
