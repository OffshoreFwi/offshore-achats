// Scraper hebdomadaire OFFSHORE ACHATS
// Détecte les catalogues/prospectus publics des fournisseurs surveillés
// et écrit le résultat dans data/catalogues.json, lu par offshore-achats.html
//
// Deux types de sources, chacune avec sa méthode d'extraction :
//  - "promosmq" (par défaut) : promos.mq injecte son contenu en JavaScript,
//    on utilise donc un navigateur headless (Playwright/Chromium).
//  - "ileco" : les fiches ilecoapp.com sont rendues côté serveur (Joomag) et
//    contiennent un identifiant de catalogue (mID) dans leurs balises meta —
//    une simple requête HTTP suffit. La page reste la même d'une semaine à
//    l'autre (c'est la fiche de l'enseigne, pas du catalogue), donc on détecte
//    un nouveau catalogue en comparant le mID d'une semaine à l'autre plutôt
//    que le lien.
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

// ─── Extraction promos.mq (rendu JS, via navigateur headless) ───
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

    let statut = "à jour";
    if (/Expiré/i.test(windowText)) statut = "expiré";

    const slugMatch = link.match(/display\/\d+\/([^/]+)\/?$/);
    let titre = "Catalogue";
    if (slugMatch) {
      try {
        titre = decodeURIComponent(slugMatch[1]).replace(/-/g, " ");
      } catch {
        titre = slugMatch[1].replace(/-/g, " ");
      }
    }
    // empreinte = ce qui doit changer pour qu'on considère "nouveau" :
    // ici le lien lui-même (un nouveau catalogue = un nouveau lien)
    results.push({ titre, lien: link, statut, empreinte: link });
  }
  return results;
}

// ─── Extraction iLéco / Joomag (rendu serveur, simple fetch) ───
function getMetaContent(html, property) {
  const re1 = new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${property}["']`, "i");
  const m1 = html.match(re1);
  if (m1) return m1[1];
  const m2 = html.match(re2);
  if (m2) return m2[1];
  return null;
}
async function extractIleco(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const titre = getMetaContent(html, "og:title") || "Catalogue iLéco";
  const image = getMetaContent(html, "og:image") || "";
  const midMatch = image.match(/mID=(\d+)/);
  const mid = midMatch ? midMatch[1] : null;
  return [
    {
      titre,
      lien: url,
      statut: "à jour",
      // empreinte = mID Joomag : change quand l'enseigne publie un nouveau catalogue,
      // même si l'URL de la fiche reste identique
      empreinte: mid ? `${url}#${mid}` : url,
    },
  ];
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

  if (source.type === "ileco") {
    for (const url of source.urls) {
      try {
        all = all.concat(await extractIleco(url));
      } catch (e) {
        lastError = e.message;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } else {
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: "fr-FR" });
    for (const url of source.urls) {
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForTimeout(1500);
        const html = await page.content();
        all = all.concat(extractCataloguesPromosMq(html));
      } catch (e) {
        lastError = e.message;
      } finally {
        await page.close();
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    await context.close();
  }

  const dedup = new Map();
  for (const c of all) dedup.set(c.empreinte, c);
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

  const prevFingerprints = new Set();
  for (const s of previous.sources || []) {
    for (const c of s.catalogues || []) prevFingerprints.add(c.empreinte || c.lien);
  }

  const out = { generated_at: new Date().toISOString(), sources: [] };
  const browser = await chromium.launch();

  try {
    for (const source of sources) {
      console.log("Scraping:", source.fournisseur);
      const entry = await scrapeSource(browser, source);
      entry.catalogues = entry.catalogues.map((c) => ({
        ...c,
        nouveau: !prevFingerprints.has(c.empreinte),
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
