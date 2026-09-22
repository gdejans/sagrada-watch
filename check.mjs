// Sagrada Família ticket watcher.
// Opens each ticket site in headless Chrome, checks the target dates for an English-language
// option with room for PEOPLE, and emails when one becomes bookable.
//   node check.mjs                            normal run
//   node check.mjs --only headout             run one site (official|headout)
//   TARGET_DATES=2026-10-20 node check.mjs    other dates (comma-separated)
//   DRY_RUN=1 node check.mjs                  log instead of sending email
// Config comes from environment variables (GitHub secrets) or a local .env file:
//   GMAIL_USER, GMAIL_APP_PASSWORD, NOTIFY_TO
import { chromium } from 'playwright-core';
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(DIR, 'state.json');
const LOG_FILE = path.join(DIR, 'watch.log');
const SHOT_DIR = path.join(DIR, 'debug');

const TARGET_DATES = (process.env.TARGET_DATES || '2026-09-25,2026-09-26').split(',').map(s => s.trim());
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

// Requirements: an English-language option with room for this many people.
const LANGUAGE = 'English';
const PEOPLE = Number(process.env.PEOPLE || 2);
const MAX_PRICE = Number(process.env.MAX_PRICE || 100); // € per person — must be strictly below this
const URGENT_PRICE = Number(process.env.URGENT_PRICE || 50); // below this: urgent phone alert
// Lowest € amount in a piece of text (discounted price is always below the struck-through one).
const minPrice = t => { const v = [...t.matchAll(/€\s?([\d.,]+)/g)].map(m => Number(m[1].replace(/,/g, ''))).filter(n => n > 0); return v.length ? Math.min(...v) : null; };
const OTHER_LANGS = /\b(Spanish|French|Italian|German|Catalan|Portuguese|Russian|Chinese|Japanese|Korean|Dutch|Polish)\b/i;

// ---- date label helpers ----
const d = iso => new Date(iso + 'T12:00:00Z');
const fmt = (iso, locale, opts) => d(iso).toLocaleDateString(locale, { timeZone: 'UTC', ...opts });
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labels = {
  official: iso => fmt(iso, 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),                        // 25 September 2026
  headout: iso => fmt(iso, 'en-US', { month: 'long', day: 'numeric', year: 'numeric' }),                         // September 25, 2026
  headoutShort: iso => fmt(iso, 'en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }), // Fri, Sep 25, 2026
};

// ---- sites ----
const OFFICIAL_BASE = 'https://tickets.sagradafamilia.org/en/1-individual/';
const OFFICIAL = [
  ['Official: Sagrada Familia (basic)', '4375-sagrada-familia', false],
  ['Official: with Guided Tour', '4374-sagrada-familia-with-guided-tour', true],
  ['Official: with Towers', '4443-sagrada-familia-with-towers', false],
  ['Official: Guide + Towers', '4779-sagrada-familia-with-guide-and-visit-to-the-towers', true],
].map(([name, slug, guided]) => ({ site: 'official', name, url: OFFICIAL_BASE + slug, guided }));

// barcelona-tickets.com (Headout) — product IDs from its Sagrada Familia page
const HEADOUT = [
  ['barcelona-tickets: Fast-Track Tickets', 17925],
  ['barcelona-tickets: Fast-Track Guided Tour', 10117],
  ['barcelona-tickets: Small Group Guided Tour', 25727],
  ['barcelona-tickets: Guided Tour + Towers', 9497],
  ['barcelona-tickets: Fast-Track + Audio Guide', 11352],
  ['barcelona-tickets: Best of Barcelona day tour', 48828],
].map(([name, id]) => ({
  site: 'headout', name,
  url: `https://book.barcelona-tickets.com/book/${id}/select/?currencyCode=EUR&openCalendar=true&cookieBanner=false`,
  dateUrl: iso => `https://book.barcelona-tickets.com/book/${id}/select/?currencyCode=EUR&date=${iso}`,
}));

// (Viator and GetYourGuide block automated browsers, so they are not checked.)

// ---- config ----
function loadEnv() {
  const f = path.join(DIR, '.env');
  const file = !fs.existsSync(f) ? {} : Object.fromEntries(
    fs.readFileSync(f, 'utf8').split('\n')
      .map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('='))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
  const pick = k => process.env[k] || file[k];
  return { GMAIL_USER: pick('GMAIL_USER'), GMAIL_APP_PASSWORD: pick('GMAIL_APP_PASSWORD'), NOTIFY_TO: pick('NOTIFY_TO'), NTFY_TOPIC: pick('NTFY_TOPIC') };
}
const env = loadEnv();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const writeState = s => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

async function sendEmail(subject, text) {
  if (process.env.DRY_RUN) { log(`(dry run) would email: ${subject}\n${text}`); return; }
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) throw new Error('No GMAIL_USER / GMAIL_APP_PASSWORD configured');
  const t = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') },
  });
  await t.sendMail({ from: env.GMAIL_USER, to: env.NOTIFY_TO || env.GMAIL_USER, subject, text });
  log(`Email sent: ${subject}`);
}

// Phone push via the ntfy app (https://ntfy.sh). Tapping the notification opens `url`.
async function sendPush(title, message, url, urgent) {
  if (!env.NTFY_TOPIC) { log('(no NTFY_TOPIC — skipping push)'); return; }
  if (process.env.DRY_RUN) { log(`(dry run) would push [${urgent ? 'URGENT' : 'high'}]: ${title} — ${message} → ${url}`); return; }
  const res = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
    method: 'POST',
    body: message,
    headers: {
      Title: title.replace(/[^\x20-\x7E]/g, ''), // header must be ASCII
      Priority: urgent ? '5' : '4',
      Tags: urgent ? 'rotating_light,ticket' : 'ticket',
      Click: url,
      Actions: `view, Book now, ${url}, clear=true`,
    },
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
  log(`Push sent: ${title}`);
}

// Each checker returns { [isoDate]: { available, detail, link? } } (missing date = could not determine)

async function checkOfficial(page, p) {
  await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const days = page.getByRole('button', { name: /September 2026|October 2026/ });
  await days.first().waitFor({ timeout: 45000 });
  await page.waitForTimeout(2500);
  const all = await days.evaluateAll(els => els.map(e => e.getAttribute('aria-label') || e.textContent || ''));
  const out = {};
  for (const iso of TARGET_DATES) {
    const l = all.find(x => new RegExp(`\\b${esc(labels.official(iso))}$`).test(x.trim()));
    if (!l) continue;
    if (/^not available/i.test(l.trim())) { out[iso] = { available: false, detail: l }; continue; }
    if (!p.guided) { out[iso] = { available: true, detail: `${l} (audio guide, any language) — check ${PEOPLE} seats` }; continue; }
    // Guided tour: pick the day and read the time-slot section for the tour language.
    await page.getByRole('button', { name: l }).first().click({ timeout: 10000 });
    await page.waitForTimeout(3000);
    const body = await page.locator('main').innerText().catch(() => '');
    const slots = (body.split(/AT WHAT TIME\?/i)[1] || '').split(/OTHER DETAILS/i)[0];
    const mentionsLang = new RegExp(`${LANGUAGE}|${OTHER_LANGS.source}`, 'i').test(slots);
    if (!mentionsLang) out[iso] = { available: true, detail: `${l} — guided tour, language NOT verified, check it's ${LANGUAGE}` };
    else out[iso] = new RegExp(LANGUAGE, 'i').test(slots)
      ? { available: true, detail: `${l} — ${LANGUAGE} time slot listed` }
      : { available: false, detail: `open, but no ${LANGUAGE} slot` };
  }
  return out;
}

async function checkHeadout(page, p) {
  await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Wait for any calendar day ("October 13, 2026, Price €149, Available") to render.
  await page.getByRole('button', { name: /^[A-Z][a-z]+ \d{1,2}, \d{4},/ }).first().waitFor({ timeout: 45000 });
  await page.waitForTimeout(1500);
  const out = {};
  const open = [];
  for (const iso of TARGET_DATES) {
    const btn = page.getByRole('button', { name: new RegExp(`^${esc(labels.headout(iso))},`) });
    if (await btn.count()) {
      const l = (await btn.first().getAttribute('aria-label')) || (await btn.first().innerText());
      const dayPrice = minPrice(l);
      if (!/available/i.test(l) || /sold out/i.test(l)) out[iso] = { available: false, detail: l };
      else if (dayPrice !== null && dayPrice >= MAX_PRICE) out[iso] = { available: false, detail: `open, but cheapest is €${dayPrice} (not under €${MAX_PRICE})` };
      else open.push(iso);
    } else {
      // A fully sold-out month is skipped entirely, with a "Dates not available in <Month>" note.
      const month = fmt(iso, 'en-US', { month: 'long' });
      if (await page.getByText(new RegExp(`not available in ${month}`, 'i')).count())
        out[iso] = { available: false, detail: `Dates not available in ${month}` };
    }
  }
  // The day has *something* — now check for an English option with room for PEOPLE.
  for (const iso of open) out[iso] = await headoutOptions(page, p, iso);
  return out;
}

const headoutCards = page => page.locator('button').filter({ hasText: /^(Select|Sold out)$/ });

// Open the product on the given date with English selected. Returns an error detail, or null when ready.
async function headoutPrepare(page, p, iso) {
  await page.goto(p.dateUrl(iso), { waitUntil: 'domcontentloaded', timeout: 60000 });
  const langBtn = page.getByRole('button', { name: /Select your language/ });
  await Promise.race([headoutCards(page).first().waitFor({ timeout: 30000 }), langBtn.first().waitFor({ timeout: 30000 })]).catch(() => {});
  await page.waitForTimeout(1500);
  if (await langBtn.count()) {
    const cur = (await langBtn.first().getAttribute('aria-label')) || '';
    if (!new RegExp(`${LANGUAGE}$`, 'i').test(cur)) {
      await langBtn.first().click();
      const opt = page.getByText(new RegExp(`^${LANGUAGE}$`)).first();
      const optRow = await opt.evaluate(e => { let c = e; for (let i = 0; i < 3 && c.parentElement; i++) c = c.parentElement; return c.innerText; }).catch(() => null);
      if (optRow === null) return `open, but no ${LANGUAGE} option`;
      if (/Next available|Closest availability|Sold out/i.test(optRow)) return `open, but ${LANGUAGE} not available (${optRow.replace(/\s+/g, ' ').slice(0, 80)})`;
      await opt.click();
      await page.waitForTimeout(2500);
    }
  }
  // If the requested date can't be served the site silently jumps to another day — make sure it didn't.
  if (!(await page.getByText(labels.headoutShort(iso), { exact: true }).count()))
    return `open, but not for ${LANGUAGE} (site switched to another date)`;
  return null;
}

async function headoutOptions(page, p, iso) {
  const err = await headoutPrepare(page, p, iso);
  if (err) return { available: false, detail: err };
  const hasLangs = (await page.getByRole('button', { name: /Select your language/ }).count()) > 0;

  const cards = await headoutCards(page).evaluateAll(btns => btns.map((bt, i) => {
    let c = bt; for (let k = 0; k < 8 && c.parentElement; k++) { c = c.parentElement; if (c.innerText.split('\n').length > 6) break; }
    return { i, text: c.innerText.replace(/\s*\n+\s*/g, ' | '), enabled: !bt.disabled && /^Select$/.test(bt.innerText.trim()) };
  }));
  const candidates = cards.filter(c => {
    if (!c.enabled) return false;
    const title = c.text.split(' | ').slice(0, 3).join(' ');
    if (!new RegExp(LANGUAGE, 'i').test(title) && OTHER_LANGS.test(title)) return false; // another language only
    if (hasLangs && !new RegExp(LANGUAGE, 'i').test(c.text) && OTHER_LANGS.test(c.text)) return false;
    const price = minPrice(c.text.split(/\| Select\b/)[0]);
    if (price !== null && price >= MAX_PRICE) return false;
    const left = c.text.match(/(\d+) tickets? left/i);
    return !left || Number(left[1]) >= PEOPLE;
  });

  // Verify the real seat count on step 2 ("Guests — Only 1 ticket left"). Read-only: no form is filled.
  const good = [];
  const rejected = cards.filter(c => c.enabled && !candidates.includes(c)).map(c => shortCard(c.text));
  for (const c of candidates) {
    if (good.length) break; // one confirmed option is enough to alert
    if (c !== candidates[0] && await headoutPrepare(page, p, iso)) break;
    const { seats, time, price, checkoutUrl } = await headoutSeats(page, c.i);
    if (seats == null || seats >= PEOPLE) good.push({ ...c, seats, time, price: price ?? minPrice(c.text.split(/\| Select\b/)[0]), checkoutUrl });
    else rejected.push(`${shortCard(c.text)} (${seats ? `only ${seats} left` : 'none suitable'}${time ? ` — ${time}` : ''})`);
  }
  if (!good.length)
    return { available: false, detail: `open, but nothing for ${PEOPLE}× ${LANGUAGE}: ${rejected.join('; ') || 'no bookable options'}` };
  const g = good[0];
  return {
    available: true,
    detail: `${shortCard(g.text)}${g.time ? ` at ${g.time}` : ''}${g.seats === undefined ? ' (seat count not verified)' : g.seats === null ? '' : ` (${g.seats} left)`}`,
    link: g.checkoutUrl || p.dateUrl(iso),
    price: g.price,
  };
}

const shortCard = t => t.split(' | ').filter(s => !/^(Select|Cancel for free.*|Duration.*|Meeting point|Old price:|€[\d.,]+ ?|\d+% off)$/.test(s)).slice(0, 2).join(' ')
  + ' ' + ((t.match(/€[\d.,]+(?=[^€]*\| (\d+% off \| )?Select)/) || [''])[0]);

// Click the option's Select (and a suitable time slot, if the option has several), go to step 2
// and read "Only N ticket(s) left". Read-only: no form is filled.
// Returns { seats: N | null (no limit shown) | undefined (couldn't reach step 2), time }.
async function headoutSeats(page, cardIndex) {
  await headoutCards(page).nth(cardIndex).click({ timeout: 10000 });
  await page.waitForTimeout(1500);
  let time = null, price = null;
  const slotPicker = page.getByText(/^Select a time slot$/);
  if (await slotPicker.count()) {
    const slotTimes = page.getByText(/^\d{1,2}:\d{2}\s?(am|pm)$/i);
    if (!(await slotTimes.count())) { await slotPicker.first().click({ timeout: 5000 }); await page.waitForTimeout(800); } // list usually opens by itself
    const slots = await slotTimes.evaluateAll(els => els.map(e => {
      let c = e; for (let k = 0; k < 4 && c.parentElement; k++) { c = c.parentElement; if (/Duration/.test(c.innerText)) break; }
      return c.innerText.replace(/\s*\n+\s*/g, ' | ');
    }));
    const okPrice = t => { const pr = minPrice(t); return pr === null || pr < MAX_PRICE; };
    const idx = slots.findIndex(t => { const m = t.match(/(\d+) tickets? left/i); return okPrice(t) && (!m || Number(m[1]) >= PEOPLE); });
    if (slots.length && !slots.some(okPrice)) return { seats: 0, time: `no slot under €${MAX_PRICE}` };
    if (!slots.length) return { seats: undefined, time: null }; // couldn't read the slot list
    // No slot has both an OK price and enough seats: report the best seat count among affordable slots.
    if (idx < 0) return { seats: Math.max(...slots.filter(okPrice).map(t => Number((t.match(/(\d+) tickets? left/i) || [0, 0])[1]))), time: `every slot under €${MAX_PRICE}` };
    price = minPrice(slots[idx]);
    time = `${slots[idx].split(' | ')[0]} (€${price ?? '?'})`;
    await slotTimes.nth(idx).click({ timeout: 5000 });
    await page.waitForTimeout(1000);
  }
  const next = page.getByRole('button', { name: /^Next$/ });
  for (let k = (await next.count()) - 1; k >= 0; k--) {
    await next.nth(k).click({ timeout: 5000 }).catch(() => {});
    try { await page.getByText(/^Guests$/).first().waitFor({ timeout: 8000 }); break; } catch {}
  }
  if (!(await page.getByText(/^Guests$/).count())) return { seats: undefined, time }; // couldn't reach step 2
  const m = (await page.locator('body').innerText()).match(/Only (\d+) tickets? left/i);
  // Step-2 URL carries date, option, time and ticket counts: set it to PEOPLE adults for a one-tap link.
  const checkoutUrl = page.url().includes('/checkout/') ? page.url().replace(/pax\.adult=\d+/, `pax.adult=${PEOPLE}`) : null;
  return { seats: m ? Number(m[1]) : null, time, price, checkoutUrl };
}

const CHECKERS = { official: checkOfficial, headout: checkHeadout };

async function main() {
  if (new Date() > new Date(`${TARGET_DATES.at(-1)}T20:00:00+02:00`)) { log('Past target dates — nothing to do.'); return; }
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const state = readState();
  state.alerted ??= {};
  state.failStreak ??= {};
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/Madrid', viewport: { width: 1280, height: 900 } });

  const groups = { official: OFFICIAL, headout: HEADOUT };
  const found = [];
  // Sites run in parallel (one tab each); products within a site run one after another.
  await Promise.all(Object.entries(groups).filter(([s]) => !ONLY || s === ONLY).map(async ([site, products]) => {
    const page = await ctx.newPage();
    for (const p of products) {
      let res = {};
      try { res = await CHECKERS[site](page, p); }
      catch (e) {
        log(`!! ${p.name}: ${e.message.split('\n')[0]}`);
        await page.screenshot({ path: path.join(SHOT_DIR, `${site}-error.png`) }).catch(() => {});
      }
      for (const iso of TARGET_DATES) {
        const key = `${p.url}|${iso}`;
        const r = res[iso];
        if (!r) {
          state.failStreak[p.name] = (state.failStreak[p.name] || 0) + 1;
          log(`??        ${p.name} / ${iso}: could not read availability`);
          continue;
        }
        state.failStreak[p.name] = 0;
        log(`${r.available ? 'AVAILABLE' : 'sold out '} ${p.name} / ${iso}  [${r.detail}]`);
        if (r.available && !state.alerted[key]) found.push({ p, iso, key, r });
        if (!r.available) delete state.alerted[key]; // re-arm if it sells out again
      }
    }
    await page.close();
  }));
  await browser.close();

  if (found.length) {
    // Official tickets are ~€26–50; resale options carry their own price.
    const priceOf = f => f.r.price ?? (f.p.site === 'official' ? 0 : null);
    found.sort((a, b) => (priceOf(a) ?? 999) - (priceOf(b) ?? 999));
    const urgent = found.some(f => priceOf(f) !== null && priceOf(f) < URGENT_PRICE);
    const best = found[0];
    const lines = found.map(f => {
      const deep = Boolean(f.r.link) && f.r.link.includes('/checkout/');
      return `• ${f.p.name} — ${fmt(f.iso, 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}\n`
        + `  BOOK: ${f.r.link || f.p.url}\n`
        + `  ${deep ? `(opens checkout with ${PEOPLE} adults, date and time already set)` : '(pick the date and time on this page)'}\n`
        + `  ${f.r.detail}`;
    }).join('\n\n');
    const bestDay = fmt(best.iso, 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    await sendPush(
      `${urgent ? 'BOOK NOW - ' : ''}Sagrada Familia ${bestDay}${best.r.price ? ` EUR ${best.r.price}pp` : ''}`,
      `${best.p.name}: ${best.r.detail}${found.length > 1 ? ` (+${found.length - 1} more, see email)` : ''}`,
      best.r.link || best.p.url, urgent,
    ).catch(e => log(`!! Push failed: ${e.message}`));
    const dates = [...new Set(found.map(f => fmt(f.iso, 'en-GB', { day: 'numeric', month: 'short' })))].join(' & ');
    try {
      await sendEmail(`🎟️ BOOK NOW: Sagrada Família ${dates}${best.r.price ? ` — €${best.r.price} pp` : ''}`,
        `Tickets for ${PEOPLE} people (${LANGUAGE}, under €${MAX_PRICE} pp) just showed up. Book fast:\n\n${lines}\n\n(Checked ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/Madrid' })} Barcelona time)`);
      for (const f of found) state.alerted[f.key] = new Date().toISOString();
    } catch (e) {
      log(`!! Email failed: ${e.message}`);
    }
  }

  // Warn once if a product has been unreadable for 10 runs in a row (site changed / blocked).
  const broken = Object.entries(state.failStreak).filter(([, n]) => n === 10 * TARGET_DATES.length).map(([k]) => k);
  if (broken.length) {
    await sendEmail('⚠️ Sagrada Família watcher cannot read some sites',
      `These have failed 10 runs in a row:\n${broken.join('\n')}\n\nCheck the GitHub Actions logs.`).catch(() => {});
  }
  writeState(state);
}

main().catch(e => { log(`!! Fatal: ${e.stack}`); process.exit(1); });
