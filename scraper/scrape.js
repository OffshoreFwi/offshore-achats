// Scraper hebdomadaire OFFSHORE ACHATS
// Détecte les catalogues/prospectus publics des fournisseurs surveillés
// et écrit le résultat dans data/catalogues.json, lu par offshore-achats.html
//
// promos.mq injecte son contenu en JavaScript après le chargement initial :
// une simple requête HTTP ne suffit pas, on utilise donc un navigateur headless
// (Playwright/Chromium) pour obtenir le HTML final, réellement rendu.
//
// N'extrait PAS les prix ligne par ligne (trop risqué en automatique) :
// il détecte les NOUVEAUX catalogues disponibles, pour analyse ensuite
// via l'onglet Scanner de l'application (IA sur la page exacte).

import { chromium } from "playwright";
import fs from "fs";

const SOURCES_PATH = new URL("./sources.json", import.meta.url);
const OUT_PATH = "data/catalogues.json";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

// Extraction générique pour les pages promos.mq : lien /catalogue/display/<id>/<slug>/
// suivi (avant ou après selon le rendu) de "Valable encore X jours" ou "Expiré"
function extractCataloguesPromosMq(html) {
  const results = [];
  const linkRegex = /href="([^"]*\/catalogue\/display\/\d+\/[^"?#]+)\/?"/g;
  const seen = new Set();
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    let link = m[1];
    if (link.startsWith("//")) link = "https:" + link;
    else if (link.startsWith("/")) link = "https://www.promos.mq" + link;
    if (!link.endsWith("/")) link += "/";
    if (seen.has(link)) continue;
    seen.add(link);

    const windowText = html
      .slice(Math.max(0, m.index - 2000), m.index + 1000)
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

async function scrapeSource(browser, source) {
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
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "fr-FR" });

  for (const url of source.urls) {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(1500); // laisse le JS finir d'injecter le contenu
      const html = await page.content();
      all = all.concat(extractCataloguesPromosMq(html));
    } catch (e) {
      lastError = e.message;
    } finally {
      await page.close();
    }
    await new Promise((r) => setTimeout(r, 1000)); // politesse entre requêtes
  }
  await context.close();

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
  const browser = await chromium.launch();

  try {
    for (const source of sources) {
      console.log("Scraping:", source.fournisseur);
      const entry = await scrapeSource(browser, source);
      entry.catalogues = entry.catalogues.map((c) => ({
        ...c,
        nouveau: !prevLinks.has(c.lien),
      }));
      out.sources.push(entry);
    }
  } finally {
    await browser.close();
  }

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log("Écrit dans", OUT_PATH);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
