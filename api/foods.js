// Plate and Pantry food search, a Vercel serverless function.
// Talks to USDA FoodData Central so the API key never reaches the browser.
//   GET /api/foods?q=avocado        search (generic foods + branded foods)
//   GET /api/foods?ids=171705,2345  look up specific foods by FDC id
// Set FDC_API_KEY in Vercel > Project > Settings > Environment Variables.
// Without it, the shared DEMO_KEY is used, which runs out after a few searches.

const BASE = "https://api.nal.usda.gov/fdc/v1";

// FDC nutrient number -> our key. Values from FDC are per 100 g.
const MAP = {
  "208": "kcal", "958": "kcal_b", "957": "kcal_c",
  "203": "p",
  "204": "f", "298": "f_b",
  "205": "c", "205.2": "c_b",
  "291": "fib", "269": "sug", "539": "asug", "606": "sat", "601": "chol",
  "307": "na", "306": "k", "301": "ca", "303": "fe", "304": "mg", "309": "zn", "305": "ph",
  "320": "vita", "401": "vitc", "328": "vitd", "324": "vitd_iu", "323": "vite", "430": "vitk",
  "415": "b6", "418": "b12", "435": "fol"
};

function round(v) { return Math.round(v * 1000) / 1000; }

function nutrients(list) {
  const raw = {};
  (list || []).forEach((n) => {
    const num = String(n.nutrientNumber || n.number || (n.nutrient && n.nutrient.number) || "");
    const unit = String(n.unitName || (n.nutrient && n.nutrient.unitName) || "").toUpperCase();
    const val = n.value !== undefined ? n.value : n.amount;
    const key = MAP[num];
    if (!key || typeof val !== "number" || isNaN(val)) return;
    if (key.indexOf("kcal") === 0 && unit && unit !== "KCAL") return; // skip kJ
    if (raw[key] === undefined) raw[key] = val;
  });
  const out = {};
  Object.keys(raw).forEach((k) => { if (k.indexOf("_") < 0) out[k] = raw[k]; });
  if (out.f === undefined && raw.f_b !== undefined) out.f = raw.f_b;
  if (out.c === undefined && raw.c_b !== undefined) out.c = raw.c_b;
  if (out.vitd === undefined && raw.vitd_iu !== undefined) out.vitd = raw.vitd_iu / 40;
  if (out.kcal === undefined) {
    if (raw.kcal_b !== undefined) out.kcal = raw.kcal_b;
    else if (raw.kcal_c !== undefined) out.kcal = raw.kcal_c;
    else if (out.p !== undefined || out.f !== undefined || out.c !== undefined) out.kcal = 4 * (out.p || 0) + 4 * (out.c || 0) + 9 * (out.f || 0);
  }
  Object.keys(out).forEach((k) => { out[k] = round(out[k]); });
  return out;
}

// Some branded entries have broken serving sizes, giving impossible values (e.g. 8000 kcal per 100 g).
function plausible(f) {
  const n = f.n;
  if (n.kcal !== undefined && n.kcal > 950) return false;
  if ((n.p || 0) + (n.f || 0) + (n.c || 0) > 105) return false;
  return true;
}

// Put foods whose name starts with the search words first, keeping USDA's order otherwise.
function rank(list, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const score = (f) => {
    const name = f.name.toLowerCase();
    let sc = 0;
    if (words.length && name.indexOf(words[0]) === 0) sc += 2;
    if (words.every((w) => name.indexOf(w) >= 0)) sc += 1;
    return sc;
  };
  return list.map((f, i) => ({ f, i, s: score(f) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.f);
}

function food(f) {
  const unit = String(f.servingSizeUnit || "").toLowerCase();
  const gramServing = (unit === "g" || unit === "grm" || unit === "ml" || unit === "mlt") && f.servingSize ? round(f.servingSize) : null;
  return {
    id: f.fdcId,
    name: f.description || "",
    brand: f.brandName || f.brandOwner || "",
    type: f.dataType || "",
    serving: gramServing,
    servingText: f.householdServingFullText || "",
    n: nutrients(f.foodNutrients)
  };
}

async function fdc(path, body, key) {
  const r = await fetch(BASE + path + "?api_key=" + encodeURIComponent(key), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (r.status === 429) { const e = new Error("rate"); e.status = 429; throw e; }
  if (!r.ok) { const e = new Error("fdc " + r.status); e.status = 502; throw e; }
  return r.json();
}

// ---- Rate limiting ----
// USDA allows 1,000 requests an hour per key, and going over blocks the key for an hour.
// Repeat searches are served from Vercel's cache and never reach this code, so these limits
// only count fresh lookups. Limits are kept per server instance (best effort, no database needed).
const PER_IP_LIMIT = 30;            // fresh searches per visitor...
const PER_IP_WINDOW = 10 * 60e3;    // ...per 10 minutes
const UPSTREAM_HOURLY_BUDGET = 400; // USDA calls per hour per instance, leaving headroom under 1,000
const visitors = new Map();         // ip -> { count, start }
let upstream = { count: 0, start: Date.now() };

function clientIp(req) {
  const fwd = String((req.headers && req.headers["x-forwarded-for"]) || "");
  return (fwd.split(",")[0] || (req.headers && req.headers["x-real-ip"]) || "unknown").trim();
}
function overLimit(ip, now) {
  if (visitors.size > 5000) { for (const [k, v] of visitors) if (now - v.start > PER_IP_WINDOW) visitors.delete(k); }
  const v = visitors.get(ip);
  if (!v || now - v.start > PER_IP_WINDOW) { visitors.set(ip, { count: 1, start: now }); return 0; }
  v.count += 1;
  return v.count > PER_IP_LIMIT ? Math.ceil((v.start + PER_IP_WINDOW - now) / 1000) : 0;
}
function spendUpstream(calls, now) {
  if (now - upstream.start > 3600e3) upstream = { count: 0, start: now };
  if (upstream.count + calls > UPSTREAM_HOURLY_BUDGET) return Math.ceil((upstream.start + 3600e3 - now) / 1000);
  upstream.count += calls;
  return 0;
}
function tooMany(res, seconds) {
  res.setHeader("Retry-After", String(Math.max(1, seconds)));
  res.setHeader("Cache-Control", "no-store");
  res.status(429).send(JSON.stringify({ error: "rate", retryAfter: seconds }));
}

module.exports = async (req, res) => {
  const key = process.env.FDC_API_KEY || "DEMO_KEY";
  const q = String((req.query && req.query.q) || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 100);
  const ids = String((req.query && req.query.ids) || "").split(",").map((s) => parseInt(s, 10)).filter((n) => n > 0).slice(0, 20);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method && req.method !== "GET") { res.setHeader("Allow", "GET"); res.status(405).send(JSON.stringify({ error: "GET only" })); return; }
  if (!ids.length && !q) { res.status(400).send(JSON.stringify({ error: "Add ?q=food or ?ids=123" })); return; }
  const now = Date.now();
  const wait = overLimit(clientIp(req), now) || spendUpstream(ids.length ? 1 : 2, now);
  if (wait) { tooMany(res, wait); return; }
  try {
    if (ids.length) {
      const list = await fdc("/foods", { fdcIds: ids, format: "full" }, key);
      res.setHeader("Cache-Control", "s-maxage=604800, stale-while-revalidate=86400");
      res.status(200).send(JSON.stringify({ foods: (list || []).map(food).filter(plausible), demoKey: key === "DEMO_KEY" }));
      return;
    }
    const [generic, branded] = await Promise.all([
      fdc("/foods/search", { query: q, dataType: ["Foundation", "SR Legacy"], pageSize: 12 }, key),
      fdc("/foods/search", { query: q, dataType: ["Branded"], pageSize: 12 }, key)
    ]);
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).send(JSON.stringify({
      generic: rank((generic.foods || []).map(food).filter(plausible), q),
      branded: rank((branded.foods || []).map(food).filter(plausible), q),
      demoKey: key === "DEMO_KEY"
    }));
  } catch (e) {
    const status = e.status || 500;
    res.setHeader("Cache-Control", "no-store");
    res.status(status).send(JSON.stringify({ error: status === 429 ? "rate" : "lookup failed" }));
  }
};
