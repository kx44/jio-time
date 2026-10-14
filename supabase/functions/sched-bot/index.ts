// sched-bot: Telegram webhook for the availability scheduler.
//   inline_query ""        -> "Create event" web_app button
//   inline_query <eventId> -> article with summary + open-grid URL button
//   chosen_inline_result   -> remember inline_message_id for later edits
import {
  db, getBotUsername, loadEvent, MINI_APP_URL, openButton, summaryHtml, tg,
} from "../_shared/sched.ts";

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const EVENT_ID = /^[A-Za-z0-9]{10}$/;

// Bump when docs/index.html changes so Telegram's webview doesn't serve a stale cached page.
const PAGE_VERSION = "6";
const pageUrl = MINI_APP_URL ? `${MINI_APP_URL}${MINI_APP_URL.includes("?") ? "&" : "?"}v=${PAGE_VERSION}` : "";
const createButton = { text: "➕ Create a new event", web_app: { url: pageUrl } };

async function onInlineQuery(q: { id: string; query: string }) {
  const id = q.query.trim();
  const results = [];
  if (EVENT_ID.test(id)) {
    const loaded = await loadEvent(id);
    if (loaded) {
      results.push({
        type: "article",
        id,
        title: loaded.ev.title,
        description: "Share this availability poll",
        input_message_content: {
          message_text: summaryHtml(loaded.ev, loaded.responses),
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        },
        reply_markup: await openButton(id),
      });
    }
  }
  await tg("answerInlineQuery", {
    inline_query_id: q.id,
    results,
    cache_time: 0,
    is_personal: true,
    button: createButton,
  });
}

async function onChosenInlineResult(r: { result_id: string; inline_message_id?: string; from: { id: number } }) {
  if (!r.inline_message_id || !EVENT_ID.test(r.result_id)) return;
  const { error } = await db.rpc("sched_add_inline_message", {
    p_event_id: r.result_id,
    p_inline_message_id: r.inline_message_id,
    p_user_id: r.from.id,
  });
  if (error) console.error("store inline_message_id", error);
}

async function onMessage(m: { chat: { id: number; type: string }; text?: string }) {
  if (m.chat.type !== "private" || !m.text?.startsWith("/start")) return;
  const username = await getBotUsername();
  await tg("sendMessage", {
    chat_id: m.chat.id,
    text: `Find a time that works for everyone.\n\nIn any chat, type @${username} and tap “Create a new event”, ` +
      `or start one here.`,
    reply_markup: { inline_keyboard: [[createButton]] },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (!WEBHOOK_SECRET || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const update = await req.json();
    if (update.inline_query) await onInlineQuery(update.inline_query);
    else if (update.chosen_inline_result) await onChosenInlineResult(update.chosen_inline_result);
    else if (update.message) await onMessage(update.message);
  } catch (e) {
    console.error(e);
  }
  // Always 200 so Telegram doesn't retry-loop on a bad update.
  return new Response("ok");
});
