# Carl's Personal Hub

Carl Jones's personal hub: family, money, home, health, travel and the dog, plus links to his CV and his other hubs.
Live at https://personal-hub.carl-839.workers.dev/ . It deploys to Cloudflare Workers (static assets, no build step). Every push to `main` goes live.

- Site files live in `public/`. `wrangler.toml` serves that folder. Nothing outside `public/` goes live.
- Login: `worker.js` runs before every request (`run_worker_first`). Nothing in `public/` is served without a session cookie, which needs Carl's password (secret `HUB_PASSWORD`) and a 6-digit authenticator code (secret `TOTP_SECRET`). Sessions last 14 days, and changing either secret logs every device out. Login attempts are limited to 5 a minute per IP.
- Never weaken the gate: don't serve files outside the worker check, don't turn off `run_worker_first`, and don't put secrets in the repo. Test login changes with Node before pushing (see the TOTP RFC 6238 vectors).
- Private details are fine on the page because it sits behind the login.
- Only the files in PUBLIC_FILES (worker.js) skip the login: robots.txt, the web app manifest and the icons, so the hub can be added to a phone home screen. Never add anything private to that list.
- Backups: a cron (02:30 UTC) runs runBackup, which writes every item to R2 bucket `personal-hub-backups` as backup-YYYY-MM-DD.json and keeps 30 days. `/api/backup` downloads the same JSON when logged in.
- This is personal only. Nothing from the Duke's Head, Baseline or Lenne Lodge repos belongs here except links to their live sites.
- Plain, direct language. No em dashes.
- Look (8 Nov 2026): dark dashboard, amber accent (#f2a93b), Saira headings and Inter body, tokens in tools.css. Deliberately unlike the work hubs (no teal and copper). No money figures on the front page; money stays in Bills. hub.js adds the floating bottom menu to every page.

## Tools and data
- Pages: `bills.html`, `renewals.html`, `dog.html` (hand-built), and `home.html`, `health.html`, `travel.html`, `calendar.html`, `disputes.html` (built from section configs by `tool-engine.js`). All share `tools.css` and `hub.js`. `index.html` pulls due items from every list into Coming up.
- To add a tool: add its lists to COLLECTIONS in worker.js, write a page that calls `Hub.tool({sections, stats})`, link its tile in index.html, and add its due items to the Coming up loader.
- Data lives in D1 database `personal-hub` (binding `DB`, id in wrangler.toml), one table `items` (id, col, data JSON, created_at, updated_at). The worker creates it if missing.
- API: `/api/<list>` GET/POST and `/api/<list>/<id>` PUT/DELETE, only with a valid session. Writes need the header `X-Hub: 1`. Lists are in COLLECTIONS in worker.js. A new list must be added to COLLECTIONS in worker.js.
- Test locally with `npx wrangler dev --local` and a `.dev.vars` file holding test secrets (never committed).

Live hubs it links to:
- Duke's Head toolkit: https://dukes-head-toolkit.chef-b23.workers.dev/
- Baseline Kitchen Toolkit admin: https://baseline-kitchen-toolkit.pages.dev/admin
- Lenne Lodge tool: https://lenne-lodge-tool.pages.dev/
- CV (Claude artifact): https://claude.ai/artifact/HieQXJwfcQME8kwsBZi7DS
