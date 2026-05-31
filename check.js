// Monitors Provence at Valencia for a given floor plan and pushes a phone
// notification (ntfy) when units are available — both what's listed on the site
// right now AND what's coming before the site lists it.
//
// How it works (reverse-engineered from the property's RealPage site):
//   - The site reads availability from an authenticated JSON API:
//       GET https://api.ws.realpage.com/v2/property/<PROPERTY_ID>/units?...&dateneeded=YYYY-MM-DD
//     authenticated with a single header `x-ws-authkey` (the key the site ships publicly).
//   - `dateneeded` is a MOVING window: it returns units leasable for a move-in around that
//     date (roughly +/- a few weeks), not everything from now on. The website always asks for
//     `dateneeded=today`, so its list = units available now or within ~6 weeks.
//   - So we query in two layers:
//       LIVE       — dateneeded=today. Exactly what a visitor sees on the site right now.
//       LOOK-AHEAD — dateneeded stepped out to HORIZON_DAYS. Surfaces units whose move-in is
//                    further out than the site currently shows; these are real upcoming
//                    vacancies the site will list as their date approaches (a soft forecast —
//                    they can still get leased elsewhere or pulled).
//   - We alert only on CHANGE: a small state file (STATE_FILE, committed by the workflow)
//     remembers which units we've already notified about, so a unit that stays available
//     doesn't keep buzzing — we push only when a new unit appears or gets listed.
//   - A unit's customer-facing move-in date is `vacantDate` (NOT `internalAvailableDate`, an
//     earlier internal "ready" date), and its listed price is `rent` (the site's "Starting At"
//     figure; `totalRent` tacks on a small recurring fee).
//   - We match units by the plan's id (resolved from the plan name via /floorplans).

const fs = require('fs');

const PROPERTY_ID = process.env.PROPERTY_ID || '9152442';
const PLAN_NAME = process.env.PLAN_NAME || 'Nice';
const WS_AUTHKEY = process.env.WS_AUTHKEY || '6b3c1831-4a94-466a-ad81-8a8580a50e6d';
const HORIZON_DAYS = parseInt(process.env.HORIZON_DAYS || '180', 10); // how far ahead to look
const STEP_DAYS = parseInt(process.env.STEP_DAYS || '14', 10); // scan granularity (<= the API window)
const SITE = 'https://www.provenceatvalencia.com';
const APPLY_URL = process.env.APPLY_URL || `${SITE}/Floor-plans.aspx`;
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const STATE_FILE = process.env.STATE_FILE || 'state.json';

const API = `https://api.ws.realpage.com/v2/property/${PROPERTY_ID}`;
const HEADERS = { 'x-ws-authkey': WS_AUTHKEY, Origin: SITE, Referer: `${SITE}/`, Accept: 'application/json' };

const today = new Date().toISOString().slice(0, 10);
const ymd = (daysFromNow) => new Date(Date.now() + daysFromNow * 864e5).toISOString().slice(0, 10);
const d10 = (s) => String(s || '').slice(0, 10);
const money = (v) => (v == null ? '' : `$${Number(v).toLocaleString('en-US')}`);
const unitsUrl = (dn) => `${API}/units?available=true&honordisplayorder=true&siteid=${PROPERTY_ID}&bestprice=true&leaseterm=12&baseRent=true&dateneeded=${dn}`;
const unitsOf = (data) => (data.response && data.response.units) || [];

// State is just the sorted set of unit keys we've already alerted on. We omit any timestamp so
// an unchanged set serializes byte-identically — that's what lets the workflow skip the commit
// (and the git history itself records exactly when availability changed).
const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { keys: [] };
  }
};
const saveState = (keys) => fs.writeFileSync(STATE_FILE, JSON.stringify({ keys: [...keys].sort() }, null, 2) + '\n');

async function getJSON(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function notify(title, message, { priority = 3, tags = '', click = APPLY_URL } = {}) {
  if (!NTFY_TOPIC) {
    console.log(`[notify skipped: no NTFY_TOPIC]\n  ${title}\n  ${message.replace(/\n/g, '\n  ')}`);
    return;
  }
  try {
    const res = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: title, Tags: tags, Priority: String(priority), Click: click },
      body: message,
    });
    console.log(`[ntfy] HTTP ${res.status}`);
  } catch (e) {
    console.error('[ntfy] push failed:', e.message);
  }
}

const details = (u) => ({
  unit: u.unitNumber,
  date: d10(u.vacantDate) || d10(u.internalAvailableDate) || 'n/a',
  rent: u.rent || u.totalRent || null,
  building: u.buildingName && u.buildingName !== 'N/A' ? u.buildingName : '',
  onHold: !!u.unitOnHold,
});

const fmt = (u) => {
  const when = u.date !== 'n/a' && u.date <= today ? 'available now' : `available ${u.date}`;
  return `#${u.unit} ${when}${u.rent ? ` (${money(u.rent)})` : ''}${u.onHold ? ' (on hold)' : ''}${u.building ? ` – ${u.building}` : ''}`;
};

(async () => {
  // 1) Resolve the plan name -> id (robust to id changes; catches rename/removal).
  let planId;
  try {
    const fp = await getJSON(`${API}/floorplans`);
    const plans = (fp.response && fp.response.floorplans) || [];
    const plan = plans.find((p) => String(p.name).trim().toLowerCase() === PLAN_NAME.toLowerCase());
    if (!plan) {
      await notify(`⚠️ "${PLAN_NAME}" not listed`, `No floor plan named "${PLAN_NAME}" in the property feed — it may have been renamed/removed. Check the monitor.`, { priority: 4, tags: 'warning' });
      return;
    }
    planId = String(plan.id);
  } catch (e) {
    await notify(`⚠️ ${PLAN_NAME} monitor error`, `Couldn't read floor plans (the public API key may have rotated, or the API is down): ${e.message}`, { priority: 4, tags: 'warning' });
    process.exit(1);
  }

  // 2) LIVE: dateneeded=today — exactly what the website shows right now.
  const live = new Map(); // unit id -> details
  try {
    for (const u of unitsOf(await getJSON(unitsUrl(today)))) {
      if (String(u.floorplanId) !== planId) continue;
      const id = String(u.id || u.unitNumber);
      if (!live.has(id)) live.set(id, details(u));
    }
  } catch (e) {
    await notify(`⚠️ ${PLAN_NAME} monitor error`, `Live units lookup failed (auth/API): ${e.message}`, { priority: 4, tags: 'warning' });
    process.exit(1);
  }

  // 3) LOOK-AHEAD: future move-in windows — units not yet on the site. Best-effort: a failure
  //    here degrades the early-warning but must not lose the live alert, so we only log it.
  const coming = new Map(); // unit id -> details (excludes anything already live)
  try {
    for (let d = STEP_DAYS; d <= HORIZON_DAYS; d += STEP_DAYS) {
      for (const u of unitsOf(await getJSON(unitsUrl(ymd(d))))) {
        if (String(u.floorplanId) !== planId) continue;
        const id = String(u.id || u.unitNumber);
        if (live.has(id) || coming.has(id)) continue;
        coming.set(id, details(u));
      }
    }
  } catch (e) {
    console.error('[look-ahead] scan failed (live alert unaffected):', e.message);
  }

  const liveList = [...live.values()].sort((a, b) => a.date.localeCompare(b.date));
  const comingList = [...coming.values()].sort((a, b) => a.date.localeCompare(b.date));
  console.log(`${new Date().toISOString()}  ${PLAN_NAME} (planId=${planId})  live=${liveList.length} coming=${comingList.length}`, JSON.stringify({ live: liveList, coming: comingList }));

  // 4) Alert only on change. Compare the current unit set against what we last notified about,
  //    persist the new set, then bail if nothing is new (a still-available unit must not re-buzz).
  const prev = new Set(loadState().keys);
  const curKeys = [...liveList.map((u) => `live:${u.unit}`), ...comingList.map((u) => `soon:${u.unit}`)];
  saveState(curKeys);
  const newKeys = curKeys.filter((k) => !prev.has(k));

  if (curKeys.length === 0) {
    console.log(`No "${PLAN_NAME}" availability (listed or upcoming). No alert.`);
    return;
  }
  if (newKeys.length === 0) {
    console.log(`No change since last check — ${curKeys.length} unit(s) still tracked. No alert.`);
    return;
  }

  // 5) Build a two-section alert. Priority reflects what's NEW: a newly-listed unit is actionable
  //    (5); an early heads-up that isn't on the site yet is lower (4). Both sections show the full
  //    current picture so the notification stands alone.
  const sections = [];
  if (liveList.length) sections.push(`Available now / soon (on the site):\n${liveList.slice(0, 8).map(fmt).join('\n')}`);
  if (comingList.length) sections.push(`Coming later (not yet listed):\n${comingList.slice(0, 8).map(fmt).join('\n')}`);

  const newLive = liveList.filter((u) => newKeys.includes(`live:${u.unit}`));
  const newComing = comingList.filter((u) => newKeys.includes(`soon:${u.unit}`));
  const onSiteNew = newLive.length > 0;
  const lead = onSiteNew
    ? `${newLive.length} new unit(s) now listed — go!`
    : `${newComing.length} unit(s) coming soon — not yet listed on the site.`;
  await notify(
    onSiteNew ? `🏠 "${PLAN_NAME}" is available!` : `👀 "${PLAN_NAME}" coming soon`,
    `${lead}\n\n${sections.join('\n\n')}\n\nApply: ${APPLY_URL}`,
    { priority: onSiteNew ? 5 : 4, tags: onSiteNew ? 'house,tada' : 'eyes' }
  );
  console.log(`ALERT sent (${newKeys.length} new: ${newKeys.join(', ')}).`);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
