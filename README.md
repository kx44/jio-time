# Meeting Time (@MeetingTimingBot)

A when2meet-style availability scheduler that runs as a Telegram Mini App.

- `docs/index.html`: the Mini App, served by GitHub Pages
- `supabase/functions/sched-bot`: Telegram webhook (inline mode, chosen_inline_result)
- `supabase/functions/sched-api`: create / get / save, validates Telegram initData
- `branding/`: BotFather images

The bot token and webhook secret are Supabase edge-function secrets and are not in this repo.
