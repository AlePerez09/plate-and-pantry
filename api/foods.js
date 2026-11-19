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

module.exports = async (req, res) => {
  const key = process.env.FDC_API_KEY || "DEMO_KEY";
  const q = String((req.query && req.query.q) || "").trim().slice(0, 100);
  const ids = String((req.query && req.query.ids) || "").split(",").map((s) => parseInt(s, 10)).filter((n) => n > 0).slice(0, 20);
  res.setHeader("Content-Type", "application/json");
  try {
    if (ids.length) {
      const list = await fdc("/foods", { fdcIds: ids, format: "full" }, key);
      res.setHeader("Cache-Control", "s-maxage=604800, stale-while-revalidate=86400");
      res.status(200).send(JSON.stringify({ foods: (list || []).map(food), demoKey: key === "DEMO_KEY" }));
      return;
    }
    if (!q) { res.status(400).send(JSON.stringify({ error: "Add ?q=food or ?ids=123" })); return; }
    const [generic, branded] = await Promise.all([
      fdc("/foods/search", { query: q, dataType: ["Foundation", "SR Legacy"], pageSize: 12 }, key),
      fdc("/foods/search", { query: q, dataType: ["Branded"], pageSize: 12 }, key)
    ]);
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).send(JSON.stringify({
      generic: (generic.foods || []).map(food),
      branded: (branded.foods || []).map(food),
      demoKey: key === "DEMO_KEY"
    }));
  } catch (e) {
    const status = e.status || 500;
    res.status(status).send(JSON.stringify({ error: status === 429 ? "rate" : "lookup failed" }));
  }
};
