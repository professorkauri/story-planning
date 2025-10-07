// node build-data.js

const fs = require("fs/promises");

const API = "https://pokeapi.co/api/v2";
const CONCURRENCY = 10;       // be nice to PokéAPI
const SLEEP_MS_BETWEEN = 70;  // small delay to reduce burstiness

// ----------------------------- helpers --------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toTitle = s => s ? s.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : s;

async function getJSON(url, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "pkmn-data-importer/2.1" } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) {
      if (t === tries - 1) throw e;
      await sleep(250 + 250 * t);
    }
  }
}

// Stats/types extractors
function extractStats(statsArr) {
  const get = name => statsArr?.find(s => s.stat?.name === name)?.base_stat ?? null;
  return {
    hp: get("hp"),
    attack: get("attack"),
    defense: get("defense"),
    spAtk: get("special-attack"),
    spDef: get("special-defense"),
    speed: get("speed"),
  };
}
function extractTypes(typesArr) {
  const sorted = (typesArr || []).slice().sort((a, b) => a.slot - b.slot);
  return {
    type1: sorted[0]?.type?.name ? toTitle(sorted[0].type.name) : "",
    type2: sorted[1]?.type?.name ? toTitle(sorted[1].type.name) : ""
  };
}

// --- New: nicer names for items/methods
function niceName(s) {
  return s ? s.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : s;
}

// --- New: pull the suffix from our "<dexNo><SUFFIX>" id (e.g., "37A" -> "A")
function suffixFromId(id) {
  const m = String(id || "").match(/^(\d+)(.*)$/);
  return m ? (m[2] || "") : "";
}

// --- New: compact evolution method string builder (covers common cases)
function formatEvolutionMethod(det) {
  if (!det) return "Evolves";
  const trig = det.trigger?.name || "";

  // Items (stones etc.)
  if (trig === "use-item" && det.item?.name) {
    return niceName(det.item.name);
  }

  // Level-up variants
  if (trig === "level-up") {
    if (det.min_level != null) return `Lv.${det.min_level}`;
    if (det.min_happiness != null) return `High Friendship`;
    if (det.min_beauty != null) return `High Beauty`;
    if (det.min_affection != null) return `High Affection`;
    if (det.known_move?.name) return `Lv. (knows ${niceName(det.known_move.name)})`;
    if (det.known_move_type?.name) return `Lv. (${niceName(det.known_move_type.name)}-type move)`;
    if (det.location?.name) return `Lv. (${niceName(det.location.name)})`;
    if (det.time_of_day) return `Lv. (${niceName(det.time_of_day)})`;
    if (det.needs_overworld_rain) return `Lv. (raining)`;
    if (det.turn_upside_down) return `Lv. (hold 3DS upside-down)`;
    if (det.gender === 1) return `Lv. (Female)`;
    if (det.gender === 2) return `Lv. (Male)`;
    return `Lv.`;
  }

  // Trade-based
  if (trig === "trade") {
    if (det.held_item?.name) return `Trade (holding ${niceName(det.held_item.name)})`;
    if (det.trade_species?.name) return `Trade (${niceName(det.trade_species.name)})`;
    return `Trade`;
  }

  // Other triggers you'll occasionally see
  if (trig) return niceName(trig);

  return "Evolves";
}

// ----------------------- suffix + form label logic ----------------------
// ID style "<dexNo><SUFFIX>" and should sort like 9, 9GM, 9M, …
function deriveSuffixAndLabel({ pokemonName, formName, isMega, isGmax }) {
  const name = (pokemonName || "").toLowerCase();
  const form = (formName || "").toLowerCase();

  // Mega first
  if (isMega) {
    if (form.includes("x")) return { suffix: "MX", label: "Mega X" };
    if (form.includes("y")) return { suffix: "MY", label: "Mega Y" };
    return { suffix: "M", label: "Mega" };
  }
  // Gmax
  if (isGmax || form.includes("gmax") || name.includes("gmax") || form.includes("gigantamax")) {
    return { suffix: "GM", label: "Gigantamax" };
  }

  // Regional forms
  const REGIONAL = [
    ["alola", "A", "Alolan"],
    ["alolan", "A", "Alolan"],
    ["galar", "G", "Galarian"],
    ["galarian", "G", "Galarian"],
    ["hisui", "H", "Hisuian"],
    ["hisuian", "H", "Hisuian"],
    ["paldea", "P", "Paldean"],
    ["paldean", "P", "Paldean"],
  ];
  for (const [kw, s, lab] of REGIONAL) {
    if (name.includes(kw) || form.includes(kw)) return { suffix: s, label: lab };
  }

  // Known special forms (extend as desired)
  const KNOWN = [
    ["primal", "PR", "Primal"],
    ["origin", "O", "Origin"],
    ["therian", "T", "Therian"],
    ["incarnate", "I", "Incarnate"],
    ["sky", "S", "Sky"],
    ["dusk", "D", "Dusk"],
    ["dawn", "DN", "Dawn"],
    ["totem", "TT", "Totem"],
    ["blade", "B", "Blade"],
    ["shield", "SD", "Shield"],
    ["attack", "AT", "Attack"],
    ["defense", "DF", "Defense"],
    ["speed", "SP", "Speed"],
    ["heat", "HT", "Heat"],
    ["wash", "WS", "Wash"],
    ["frost", "FR", "Frost"],
    ["fan", "FN", "Fan"],
    ["mow", "MW", "Mow"],
    ["black", "BK", "Black"],
    ["white", "WH", "White"],
    ["resolute", "R", "Resolute"],
    ["pirouette", "PIR", "Pirouette"],
    ["ash", "ASH", "Ash"],
  ];
  for (const [kw, s, lab] of KNOWN) {
    if (name.includes(kw) || form.includes(kw)) return { suffix: s, label: toTitle(lab) };
  }

  // Base/default form?
  if (!form || form === "default" || form === "standard" || form === "normal") {
    return { suffix: "", label: "" };
  }

  // Fallback: short code from form name
  const parts = form.split(/[^a-z0-9]+/).filter(Boolean);
  let code = parts.map(p => p[0]).join("").toUpperCase().slice(0, 3);
  if (!code) code = "F";
  return { suffix: code, label: toTitle(form) };
}

// ---------------------------- pokedex builder ---------------------------
/** Normalise PokéAPI flavor text (joins broken lines, trims) */
function normalizeFlavorText(text) {
  if (!text) return "";
  return String(text)
    .replace(/\s+/g, " ")     // collapse newlines/tabs into spaces
    .replace(/\u000c/g, " ")  // form-feed sometimes appears in old entries
    .trim();
}

/**
 * Returns ALL English Pokédex entries as a flat array, preserving one item per version entry.
 * Example:
 * [
 *   { version: "red", text: "..." },
 *   { version: "blue", text: "..." },
 *   { version: "yellow", text: "..." },
 *   ...
 * ]
 */
// ---------------------------- pokedex builder ---------------------------
function buildDexEntries(species, versionIdByName, VERSION_TO_GAME_ID) {
  // Keep exactly ONE English entry per game (the first we encounter).
  // Shape: { [gameId]: { regionalDexNumber: string, entry: string } }
  const out = {};
  const seenGame = new Set();

  for (const ft of species.flavor_text_entries || []) {
    if (ft?.language?.name !== "en") continue;

    const vName = ft?.version?.name;
    if (!vName) continue;

    const gameId = VERSION_TO_GAME_ID.get(vName) || vName;
    if (seenGame.has(gameId)) continue; // already captured first for this game

    const text = normalizeFlavor(ft.flavor_text);
    if (!text) continue;

    // Try to fetch a regional dex number for this game
    let regionalDexNumber = "";
    const prefs = VERSION_TO_POKEDEX_PREFS.get(vName);
    if (prefs) {
      regionalDexNumber = getRegionalDexNumber(species, prefs);
    }

    out[gameId] = { regionalDexNumber, entry: text };
    seenGame.add(gameId);
  }

  return out;
}

/**
 * Returns ALL English Pokédex entries grouped by game version, keeping every entry for that version.
 * Example:
 * {
 *   red:   ["line 1", "line 2", ...],
 *   blue:  ["line 1", ...],
 *   yellow:["line 1", ...],
 *   ...
 * }
 */
function buildDexEntriesByVersion(species) {
  const grouped = {};
  const all = buildDexEntries(species);

  for (const { version, text } of all) {
    if (!grouped[version]) grouped[version] = [];
    grouped[version].push(text);
  }

  return grouped;
}

// -------------------- caches for species/evolution pass -----------------
const SPECIES_META = new Map();         // species.name -> { id, name_en, chainUrl }
const SPECIES_SUFFIX_INDEX = new Map(); // species.name -> Set of suffixes we emitted
const CHAIN_CACHE = new Map();          // chainUrl -> chain JSON

// Build map of species.name -> { rootName, prevByName: Map(targetName -> {fromName, detail}) }
async function getChainInfo(chainUrl) {
  if (!chainUrl) return null;
  if (CHAIN_CACHE.has(chainUrl)) return CHAIN_CACHE.get(chainUrl);
  let chain;
  try {
    chain = await getJSON(chainUrl);
  } catch { return null; }

  const info = { rootName: chain?.chain?.species?.name || null, prevByName: new Map() };

  function walk(node, parentName) {
    const here = node?.species?.name;
    if (here && parentName) {
      // choose the first detail (usually enough)
      const det = (node.evolution_details && node.evolution_details[0]) ? node.evolution_details[0] : null;
      info.prevByName.set(here, { fromName: parentName, detail: det });
    }
    for (const nxt of (node?.evolves_to || [])) walk(nxt, here || parentName);
  }
  walk(chain?.chain, null);

  CHAIN_CACHE.set(chainUrl, info);
  return info;
}

async function applySpeciesAndEvolution(pokemonOut) {
  // Fast lookups by species name and by current id
  const bySpeciesName = new Map(); // species.name -> entries[]
  const byId = new Map();          // "37A" -> entry

  for (const p of pokemonOut) {
    byId.set(p.id, p);
  }

  // Rebuild mapping from species.name to its entries by numeric dex prefix
  for (const [sName, meta] of SPECIES_META.entries()) {
    const entries = [];
    const n = meta.id.toString();
    for (const p of pokemonOut) {
      const m = String(p.id).match(/^(\d+)/);
      if (m && m[1] === n) entries.push(p);
    }
    bySpeciesName.set(sName, entries);
  }

  // For each species, fetch chain info once, then update entries
  for (const [sName, meta] of SPECIES_META.entries()) {
    if (!meta.chainUrl) continue;
    const chainInfo = await getChainInfo(meta.chainUrl);
    if (!chainInfo) continue;

    const lowest = chainInfo.rootName;
    const lowestMeta = lowest ? SPECIES_META.get(lowest) : null;
    const lowestDisplay = lowestMeta?.name_en || niceName(lowest || "");

    // Update species field for ALL entries of this species (lowest-stage name for the whole line)
    for (const entry of (bySpeciesName.get(sName) || [])) {
      entry.species = lowestDisplay;
    }

    // Evolution: if this species has a parent in the chain, set "ID (Method)" using a matching suffix
    const prev = chainInfo.prevByName.get(sName);
    if (prev) {
      const fromMeta = SPECIES_META.get(prev.fromName);
      if (fromMeta) {
        const fromDex = String(fromMeta.id);

        // For each entry in this species, pick a predecessor ID that matches its suffix when possible
        const fromSuffixes = SPECIES_SUFFIX_INDEX.get(prev.fromName) || new Set([""]);
        for (const entry of (bySpeciesName.get(sName) || [])) {
          const mySuffix = suffixFromId(entry.id);
          // Prefer same suffix on previous stage; else fall back to base (no suffix)
          const chosenSuffix = fromSuffixes.has(mySuffix) ? mySuffix : "";
          const prevIdStr = fromDex + chosenSuffix;

          const method = formatEvolutionMethod(prev.detail);
          entry.evolution = `${prevIdStr} (${method})`;
        }
      }
    }
  }
}

// ---- Pokédex helpers ---------------------------------------------------

// Normalise PokéAPI flavor text (joins broken lines, trims)
function normalizeFlavor(text) {
  return String(text || "")
    .replace(/\u000c/g, " ") // stray form-feed in old games
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * For a given species JSON, return the regional dex number for the first
 * matching Pokédex name in `preferredPokedexNames` (ordered by preference).
 * If none match, returns "".
 */
function getRegionalDexNumber(species, preferredPokedexNames) {
  if (!species || !Array.isArray(species.pokedex_numbers)) return "";
  const byName = new Map(
    species.pokedex_numbers.map(p => [p.pokedex?.name, p.entry_number])
  );
  for (const name of preferredPokedexNames) {
    if (byName.has(name)) return String(byName.get(name));
  }
  return "";
}

/**
 * Map a VERSION (game) name -> ordered preference list of Pokédexes to read
 * a regional number from. This isn’t exhaustive, but it covers the mainlines.
 * Missing entries just fall back to "" (left blank).
 */
const VERSION_TO_POKEDEX_PREFS = new Map([
  // GB / GBC
  ["red", ["kanto", "updated-kanto"]],
  ["blue", ["kanto", "updated-kanto"]],
  ["yellow", ["kanto", "updated-kanto"]],
  ["gold", ["original-johto", "updated-johto"]],
  ["silver", ["original-johto", "updated-johto"]],
  ["crystal", ["original-johto", "updated-johto"]],

  // GBA
  ["ruby", ["hoenn"]],
  ["sapphire", ["hoenn"]],
  ["emerald", ["hoenn"]],
  ["firered", ["updated-kanto", "kanto"]],
  ["leafgreen", ["updated-kanto", "kanto"]],

  // DS
  ["diamond", ["original-sinnoh"]],
  ["pearl", ["original-sinnoh"]],
  ["platinum", ["extended-sinnoh"]],
  ["heartgold", ["updated-johto", "original-johto"]],
  ["soulsilver", ["updated-johto", "original-johto"]],

  // DS (Unova)
  ["black", ["original-unova"]],
  ["white", ["original-unova"]],
  ["black-2", ["updated-unova"]],
  ["white-2", ["updated-unova"]],

  // 3DS
  ["x", ["kalos-central", "kalos-coastal", "kalos-mountain"]],
  ["y", ["kalos-central", "kalos-coastal", "kalos-mountain"]],
  ["omega-ruby", ["hoenn"]],
  ["alpha-sapphire", ["hoenn"]],
  ["sun", ["original-alola", "alola", "updated-alola"]],
  ["moon", ["original-alola", "alola", "updated-alola"]],
  ["ultra-sun", ["updated-alola", "alola", "original-alola"]],
  ["ultra-moon", ["updated-alola", "alola", "original-alola"]],

  // Switch
  ["lets-go-pikachu", ["updated-kanto", "kanto"]],
  ["lets-go-eevee", ["updated-kanto", "kanto"]],
  ["sword", ["galar", "isle-of-armor", "crown-tundra"]],
  ["shield", ["galar", "isle-of-armor", "crown-tundra"]],
  ["brilliant-diamond", ["original-sinnoh"]],
  ["shining-pearl", ["original-sinnoh"]],
  ["legends-arceus", ["hisui"]],
  ["scarlet", ["paldea", "kitakami", "blueberry"]],
  ["violet", ["paldea", "kitakami", "blueberry"]],
]);


// ------------------------------- main -----------------------------------
async function main() {
  console.log("Loading versions…");
  const versions = await getJSON(`${API}/version?limit=1000`);
  const versionResults = versions.results || [];
  const versionIdByName = new Map();
  const VERSION_TO_GAME_ID = new Map();
  const VERSION_GROUP_CONSOLE_HINT = {
    "red-blue": "Game Boy", "yellow": "Game Boy",
    "gold-silver": "Game Boy Color", "crystal": "Game Boy Color",
    "ruby-sapphire": "Game Boy Advance", "emerald": "Game Boy Advance", "firered-leafgreen": "Game Boy Advance",
    "diamond-pearl": "Nintendo DS", "platinum": "Nintendo DS", "heartgold-soulsilver": "Nintendo DS", "black-white": "Nintendo DS", "black-2-white-2": "Nintendo DS",
    "x-y": "Nintendo 3DS", "omega-ruby-alpha-sapphire": "Nintendo 3DS", "sun-moon": "Nintendo 3DS", "ultra-sun-ultra-moon": "Nintendo 3DS",
    "lets-go-pikachu-lets-go-eevee": "Nintendo Switch", "sword-shield": "Nintendo Switch",
    "brilliant-diamond-and-shining-pearl": "Nintendo Switch", "legends-arceus": "Nintendo Switch", "scarlet-violet": "Nintendo Switch"
  };

  const versionDetails = [];
  for (const v of versionResults) {
    const det = await getJSON(v.url);
    versionDetails.push(det);
    versionIdByName.set(det.name, det.id);
    VERSION_TO_GAME_ID.set(det.name, det.name); // 1:1 for now
    await sleep(SLEEP_MS_BETWEEN);
  }

  // Seed games from versions
  const games = [];
  for (const det of versionDetails) {
    const vg = det.version_group?.name;
    games.push({
      id: det.name,
      title: toTitle(det.name),
      releaseDate: "",          // optional: fill later
      console: vg ? (VERSION_GROUP_CONSOLE_HINT[vg] || "") : "",
      colorHex: "#888888",
      imageSlug: det.name
    });
  }

  console.log("Fetching species index…");
  const idx = await getJSON(`${API}/pokemon-species?limit=20000`);
  const speciesUrls = (idx.results || []).map(r => r.url);
  console.log(`Species count: ${speciesUrls.length}`);

  const pokemonOut = [];
  let processed = 0;

  // async pool
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (speciesUrls.length) {
      const url = speciesUrls.shift();
      try {
        const species = await getJSON(url);

        // English display name + category + evolves-from
        const speciesNameEn = species.names?.find(n => n.language?.name === "en")?.name || toTitle(species.name);
        const category = species.genera?.find(g => g.language?.name === "en")?.genus || "";

        // Record meta so we can resolve lowest stage + previous stage later
        SPECIES_META.set(species.name, {
          id: species.id,
          name_en: speciesNameEn,
          chainUrl: species.evolution_chain?.url || null
        });

        // Build dex entries once per species
        const pokedex = buildDexEntries(species, versionIdByName, VERSION_TO_GAME_ID);

        // For each variety: fetch pokemon + its first form
        const varieties = species.varieties || [];
        for (const v of varieties) {
          if (!v?.pokemon?.url) continue;
          const pkmn = await getJSON(v.pokemon.url);
          const formUrl = pkmn.forms?.[0]?.url;
          let form = null;
          if (formUrl) {
            try { form = await getJSON(formUrl); }
            catch { /* older entries may 404; ignore */ }
          }

          const isDefault = !!v.is_default;
          const isMega = !!form?.is_mega || /mega/.test((pkmn.name || ""));
          const isGmax = !!form?.is_gmax || /(gmax|gigantamax)/.test((pkmn.name || ""));
          const formName = form?.form_name || form?.name || "";

          const { suffix, label } = isDefault
            ? { suffix: "", label: "" }
            : deriveSuffixAndLabel({
              pokemonName: pkmn.name,
              formName,
              isMega,
              isGmax
            });

          const nationalDex = String(species.id);  // National number
          const id = nationalDex + (suffix || "");

          const { type1, type2 } = extractTypes(pkmn.types || []);
          const stats = extractStats(pkmn.stats || []);

          // Species will be replaced later with lowest-stage across the chain
          // Evolution will be set later as "PREV_ID (Method)" based on the chain
          pokemonOut.push({
            id,
            name: speciesNameEn,
            category,                 // "Mouse Pokémon" etc.
            form: label,              // human-readable ("" for default)
            species: speciesNameEn,   // temporary; replaced in applySpeciesAndEvolution()
            evolution: "",            // set later
            type1, type2,
            ...stats,
            pokedex
          });

          // Track which suffixes exist for this species (to match regional/mega/gmax lines)
          if (!SPECIES_SUFFIX_INDEX.has(species.name)) SPECIES_SUFFIX_INDEX.set(species.name, new Set());
          SPECIES_SUFFIX_INDEX.get(species.name).add(suffix || ""); // base form uses ""

          await sleep(SLEEP_MS_BETWEEN);
        }
      } catch (e) {
        console.warn("Species fail:", url, e.message);
      } finally {
        processed++;
        if (processed % 25 === 0) console.log(` …${processed} species processed`);
      }
    }
  });

  await Promise.all(workers);

  // Apply lowest-stage species name + evolution "PREV_ID (Method)"
  await applySpeciesAndEvolution(pokemonOut);

  // Sort: numeric dex, then suffix (so 9, 9A, 9G, 9GM, 9M, …)
  function parseIdForSort(raw) {
    const m = String(raw || "").match(/^(\d+)(.*)$/);
    return m ? { num: parseInt(m[1], 10), suf: m[2] || "" } : { num: Number.MAX_SAFE_INTEGER, suf: "" };
  }
  pokemonOut.sort((a, b) => {
    const A = parseIdForSort(a.id), B = parseIdForSort(b.id);
    if (A.num !== B.num) return A.num - B.num;
    if (A.suf === B.suf) return 0;
    if (A.suf === "") return -1;
    if (B.suf === "") return 1;
    return A.suf.localeCompare(B.suf);
  });

  const out = { games, pokemon: pokemonOut };
  await fs.writeFile("data.json", JSON.stringify(out, null, 2), "utf8");
  console.log("Wrote data.json with", pokemonOut.length, "pokemon entries and", games.length, "games");
}

main().catch(e => { console.error(e); process.exit(1); });
