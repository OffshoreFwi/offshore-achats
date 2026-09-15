// Scraper hebdomadaire OFFSHORE ACHATS
// Détecte les catalogues/prospectus publics des fournisseurs surveillés
// et écrit le résultat dans data/catalogues.json, lu par offshore-achats.html
//
// N'extrait PAS les prix ligne par ligne (trop risqué en automatique) :
// il détecte les NOUVEAUX catalogues disponibles, pour analyse ensuite
// via l'onglet Scanner de l'application (IA sur la page exacte).

import fetch from "node-fetch";
import fs from "fs";

const SOURCES_PATH = new URL("./sources.json", import.meta.url);
const OUT_PATH = "data/catalogues.json";
const USER_AGENT = "Mozilla/5.0 (compatible; OffshoreAchatsBot/1.0; usage interne veille prix Offshore FWI Martinique)";

function loadSources() {
  return JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
}

function loadPrevious() {
  try {
    return JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
  } catch {
    return { generated_at: null, sources: [] };
  }
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    timeout: 20000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// Extraction générique pour les pages promos.mq (structure stable observée :
// lien /catalogue/display/<id>/<slug>/ suivi de "Valable encore X jours" ou "Expiré")
function extractCataloguesPromosMq(html) {
  const results = [];
  const linkRegex = /href="(https?:\/\/www\.promos\.mq\/catalogue\/display\/\d+\/[^"?#]+)\/?"/g;
  const seen = new Set();
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const link = m[1].endsWith("/") ? m[1] : m[1] + "/";
    if (seen.has(link)) continue;
    seen.add(link);

    const windowText = html
      .slice(Math.max(0, m.index - 700), m.index + 300)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");

    let statut = "à vérifier";
    if (/Expiré/i.test(windowText)) statut = "expiré";
    else if (/Valable encore\s*\d+\s*jours?/i.test(windowText)) statut = "à jour";

    const slugMatch = link.match(/display\/\d+\/([^/]+)\/?$/);
    let titre = "Catalogue";
    if (slugMatch) {
      try {
        titre = decodeURIComponent(slugMatch[1]).replace(/-/g, " ");
      } catch {
        titre = slugMatch[1].replace(/-/g, " ");
      }
    }
    results.push({ titre, lien: link, statut });
  }
  return results;
}

async function scrapeSource(source) {
  const entry = {
    fournisseur: source.fournisseur,
    statut: "ok",
    derniere_verification: new Date().toISOString(),
    catalogues: [],
    erreur: null,
    note: source.note || null,
  };

  if (!source.urls || source.urls.length === 0) {
    entry.statut = "à vérifier manuellement";
    return entry;
  }

  let all = [];
  let lastError = null;

  for (const url of source.urls) {
    try {
      const html = await fetchPage(url);
      all = all.concat(extractCataloguesPromosMq(html));
    } catch (e) {
      lastError = e.message;
    }
    await new Promise((r) => setTimeout(r, 1200)); // politesse entre requêtes
  }

  const dedup = new Map();
  for (const c of all) dedup.set(c.lien, c);
  entry.catalogues = Array.from(dedup.values());

  if (entry.catalogues.length === 0 && lastError) {
    entry.statut = "inaccessible";
    entry.erreur = lastError;
  } else if (entry.catalogues.length === 0) {
    entry.statut = "aucun catalogue trouvé";
  }
  return entry;
}

async function run() {
  const sources = loadSources();
  const previous = loadPrevious();

  const prevLinks = new Set();
  for (const s of previous.sources || []) {
    for (const c of s.catalogues || []) prevLinks.add(c.lien);
  }

  const out = { generated_at: new Date().toISOString(), sources: [] };

  for (const source of sources) {
    console.log("Scraping:", source.fournisseur);
    const entry = await scrapeSource(source);
    entry.catalogues = entry.catalogues.map((c) => ({
      ...c,
      nouveau: !prevLinks.has(c.lien),
    }));
    out.sources.push(entry);
  }

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log("Écrit dans", OUT_PATH);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
