# SolarJournal

> **⚠️ INSTRUCTION TO CLAUDE:** This file is the source of truth for the project. **Any time we make a meaningful change to SolarJournal — new feature, architectural decision, deploy gotcha, dependency change, file restructure, schema change, env var, or hard-won bug fix — you must update this CLAUDE.md before considering the task done.** Treat it as part of the deliverable, not optional documentation. Bump the "Last updated" date at the bottom every time you edit it. If you're unsure whether something is worth recording, record it.

---


A daily learning journal PWA for a solar tech in training. The user logs 3 key highlights from their workday and Claude generates an AI expansion for each one with relevant technical depth, specs, and practical tips.

**Live:** https://solarjournal.onrender.com
**Repo:** https://github.com/ciinkwia/SolarJournal
**Owner:** ciinkwia (jarridbaldwin@gmail.com), solar tech in training at RevoluSun Hawaii (Tesla / Enphase / SolarEdge / Franklin systems).

---

## Architecture

```
Phone/Browser
   │
   │  HTTPS
   ▼
Render (free tier, auto-deploy from GitHub master)
   │
   ├── Express server (server.js)
   │     ├── Reverse proxy: /__/auth/*, /__/firebase/*  →  solarnotes-9c059.firebaseapp.com
   │     ├── Static files: public/
   │     └── API routes (Bearer-token auth via Firebase Admin)
   │
   ├── Firestore (collection: journal_entries)
   │     {userId, date, title, notes, highlights[3], status, completedAt, createdAt}
   │
   └── Anthropic API (Claude Sonnet 4.5) — generates highlight expansions in parallel
```

**Firebase project:** `solarnotes-9c059` — shared with the user's other app, SolarNotes. Both apps live in the same Firebase project but use different Firestore collections.

---

## Key files

- `server.js` — Express server, all API routes, Firebase Admin init, Anthropic client, auth middleware, reverse proxy.
- `public/index.html` — Single-page app shell. Auth screen + Today view (form) + Journal view + Firebase SDK init.
- `public/app.js` — Front-end logic. Auth state, today form submit, journal rendering, markdown→HTML for AI expansions. **Cache-busted via `?v=N` query string** — bump this number any time you ship JS changes or stale clients won't pick them up.
- `public/style.css` — Dark theme, amber accent (`--accent: #f59e0b`).
- `public/sw.js` — Self-unregistering service worker (cleans up after the original SW that got us into cache trouble). Leave it alone unless you're intentionally re-introducing offline support.
- `public/manifest.json` — PWA manifest.
- `system_prompt_journal.txt` — System prompt for Claude expansions. Edit this to tune the AI tone/depth.
- `firebase-service-account.json` — local-only, gitignored. Render reads `FIREBASE_SERVICE_ACCOUNT` env var (full JSON).
- `.env` — local-only, contains `ANTHROPIC_API_KEY`. Render has its own env var.

---

## Today view UX

Single-page form modeled after the user's BJJ journal app:
1. **Entry Title** (optional text input)
2. Three numbered **Key Highlight** cards, each with a large textarea
3. **General Notes** (optional textarea)
4. **"Finish & Generate Expansions"** submit button

**Save-as-you-go:** Highlights auto-save as drafts 2 seconds after you stop typing (`PUT /api/entries/:id/save`). A subtle "Saving..." / "Saved" indicator appears above the finish button. You can fill in highlights throughout the day and come back to the form — your work persists.

On submit ("Finish"), the front-end POSTs `{highlights: [t1,t2,t3], title, notes}` to `/api/entries/:id/complete`. Server fires 3 parallel `callClaude` requests, stores results, and returns the completed entry, which is then rendered read-only with the AI expansions inline under each highlight.

---

## API routes

All require `Authorization: Bearer <Firebase ID token>`.

- `GET /api/entries/today?date=YYYY-MM-DD` — get or lazily create today's in-progress entry.
- `PUT /api/entries/:id/save` — body `{highlights: [strings], title, notes}`. Saves draft without completing. Used by auto-save (2s debounce after typing stops). Returns `{success: true}`.
- `POST /api/entries/:id/complete` — body `{highlights: [3 strings], title, notes}`. Generates expansions, marks completed.
- `GET /api/entries?before=YYYY-MM-DD` — paginated list of completed entries (20 per page). Filters/sorts in JS to avoid Firestore composite index requirements.
- `DELETE /api/entries/:id` — delete an entry.

---

## Deploy flow

1. Commit + push to `master`
2. Render auto-deploys (~1-2 minutes on free tier)
3. Bump `app.js?v=N` in `index.html` if you changed front-end JS, otherwise stale clients will run the old code

Render env vars that must be set:
- `ANTHROPIC_API_KEY`
- `FIREBASE_SERVICE_ACCOUNT` (full JSON, single line)

---

## Hard-won gotchas (read before debugging)

### 1. Storage partitioning broke Firebase Auth
Modern Chrome/Safari partition `sessionStorage` per eTLD+1. When `authDomain` was the default `solarnotes-9c059.firebaseapp.com` but the app ran on `solarjournal.onrender.com`, `signInWithRedirect` failed with *"Unable to process request due to missing initial state"*.

**Fix:** reverse-proxy `/__/auth/*` and `/__/firebase/*` from our Express server to `solarnotes-9c059.firebaseapp.com`, then set `authDomain: "solarjournal.onrender.com"` in `firebaseConfig`. This makes the auth handler same-origin with the app, sidestepping the partition. The proxy middleware lives in `server.js` and **must be registered BEFORE `express.json()`** so it can pipe the raw request through.

### 2. OAuth redirect URIs
After fixing storage partitioning, Google OAuth threw `Error 400: redirect_uri_mismatch`. The Firebase-managed OAuth client only had the firebaseapp.com redirect registered.

**Fix (manual, in Google Cloud Console > APIs & Services > Credentials):**
- Authorized JavaScript origin: `https://solarjournal.onrender.com`
- Authorized redirect URI: `https://solarjournal.onrender.com/__/auth/handler`
(The original firebaseapp.com URIs stay — both are needed.)

### 3. Firebase API key referrer restriction
The Firebase Browser API key in Google Cloud Console has HTTP referrer restrictions. `https://solarjournal.onrender.com` must be in the allowed list, or sign-in fails with `auth/requests-from-referer-blocked`.

### 4. Claude model name is a landmine
Made-up model identifiers will silently fail. Stick to known-good ones from the Anthropic docs and pin a date. Currently using `claude-sonnet-4-5-20250929` with `maxRetries: 1, timeout: 60000`. If you change this, test by actually completing an entry — invalid models cause `/complete` to look like it's working then return "Failed to fetch" on the client.

### 5. Service worker cache traps
Original SW aggressively cached `app.js`. After shipping fixes, phones kept running old code. Current SW (`public/sw.js`) self-unregisters and clears all caches on activate. Combined with `?v=N` query-string bumps on the script tag, this is the safe way to ship JS updates. Don't reintroduce caching logic without a versioning strategy.

### 6. Firestore composite indexes
The `GET /api/entries` query originally used `.where('userId').where('status', '==', 'completed').orderBy('date', 'desc')`, which requires a composite index. Without one, the query silently returns nothing. Fixed by fetching all user entries and filtering/sorting in JS on the server. For a single-user personal journal the data volume is negligible.

### 7. Render free-tier cold starts
Service spins down after ~15 min idle. First request after a cold start can take 30-60s. If `/complete` ever times out, suspect Anthropic latency × 3 parallel calls + cold start, not necessarily a bug.

---

## Coding conventions

- No build step. Plain ES6 JS, vanilla DOM, no framework. Keep it that way unless there's a strong reason.
- Server uses CommonJS (`require`).
- Dark theme, mobile-first. The user uses this exclusively on iPhone.
- Don't add dependencies casually — current deps are just `express`, `firebase-admin`, `@anthropic-ai/sdk`. The Firebase auth proxy is hand-rolled with `node:https` to avoid pulling in `http-proxy`.

---

## Pending / future ideas

(none committed — add as they come up)

---

**Last updated:** 2026-04-17 (save-as-you-go drafts, journal query fix for composite index issue)
