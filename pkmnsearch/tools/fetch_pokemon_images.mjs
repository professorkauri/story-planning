#!/usr/bin/env node
/* Fetch Pokémon images from Serebii into images/pkmn/<ID>.png
 *
 * Usage:
 *   node tools/fetch_pokemon_images.mjs --data data.json --out images/pkmn --dry-run
 *   node tools/fetch_pokemon_images.mjs --data data.json --out images/pkmn
 *
 * Requires Node 18+ (global fetch).
 */

import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";


/* ---------- CLI args (supports --k=v and --k v) ---------- */
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const tok = argv[i];
  if (!tok.startsWith("--")) continue;

  const eq = tok.indexOf("=");
  if (eq !== -1) {
    const key = tok.slice(2, eq);
    const val = tok.slice(eq + 1);
    args[key] = val === "" ? true : val;
  } else {
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
}

if (args.help || args.h) {
  console.log(`
Usage:
  node tools/fetch_pokemon_images.mjs --data data.json --out images/pkmn [--dry-run]
  node tools/fetch_pokemon_images.mjs --data=data.json --out=images/pkmn [--concurrency=4] [--delay=150]

Flags:
  --data <path>         Path to data.json (default: data.json)
  --out <dir>           Output directory (default: images/pkmn)
  --dry-run             Print actions without downloading
  --concurrency <n>     Parallel downloads (default: 4)
  --delay <ms>          Delay between jobs per worker (default: 150)
  --help, -h            Show this help
  `);
  process.exit(0);
}

const DATA_PATH   = String(args.data || "data.json");
const OUT_DIR     = String(args.out  || "images/pkmn");
const DRY_RUN     = Boolean(args["dry-run"] || args.dryrun);
const CONCURRENCY = Number.isFinite(+args.concurrency) ? +args.concurrency : 4;
const DELAY_MS    = Number.isFinite(+args.delay)       ? +args.delay       : 150;


/* ---------- Helpers ---------- */

// Zero-pad to 3 digits (001..999)
function pad3(n) { return String(n).padStart(3, "0"); }

// Extract leading numeric part from your ID ("9GM" -> "9")
function numericPrefixFromId(id) {
  const m = String(id ?? "").trim().match(/^(\d+)/);
  return m ? m[1] : null;
}

/** Decide the SINGLE Pokémon HOME suffix for this entry.
 *  We infer from explicit `form` first, then from ID suffix (e.g. 006MX).
 *  Return "" for base form.
 */
function pickHomeSuffix(p) {
  const formRaw = String(p.form ?? "").trim().toLowerCase();
  const idRaw   = String(p.id   ?? "").trim();
  // 1) explicit form text
  if (formRaw) {
    if (/(^| )galar(ian)?/.test(formRaw)) return "-g";
    if (/(^| )alola(n)?/.test(formRaw))  return "-a";
    if (/gigantamax|gmax/.test(formRaw)) return "-gi";
    if (/hisui(an)?/.test(formRaw))      return "-h";
    if (/paldea(n)?/.test(formRaw))      return "-p";
    if (/mega(\s+|-)?x\b/.test(formRaw)) return "-mx";
    if (/mega(\s+|-)?y\b/.test(formRaw)) return "-my";
    if (/mega/.test(formRaw))            return "-m"; // generic Mega when not X/Y
  }
  // 2) infer from ID suffix (e.g., 006MX, 052G, 003M)
  const suff = idRaw.replace(/^\d+/, "").toUpperCase();
  if (suff) {
    if (suff === "G"   || suff === "GAL") return "-g";
    if (suff === "A"   || suff === "ALO") return "-a";
    if (suff === "GM"  || suff === "GMAX") return "-gi";
    if (suff === "H"   || suff === "HIS") return "-h";
    if (suff === "P"   || suff === "PAL") return "-p";
    if (suff === "MX") return "-mx";
    if (suff === "MY") return "-my";
    if (suff === "M"   || suff === "MEGA") return "-m";
  }
  // base sprite
  return "";
}

// Build the single Pokémon HOME URL for this entry
function buildHomeUrl(p) {
  const num = numericPrefixFromId(p.id);
  if (!num) return null;
  const code3  = pad3(num);
  const suffix = pickHomeSuffix(p);
  return `https://www.serebii.net/pokemonhome/pokemon/${code3}${suffix}.png`;
}


async function ensureDir(dir) {
  try { await access(dir, constants.F_OK); }
  catch { await mkdir(dir, { recursive: true }); }
}

async function fileExists(fp) {
  try { await access(fp, constants.F_OK); return true; }
  catch { return false; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error("Empty file");
      return buf;
    } catch (e) {
      lastErr = e;
      await sleep(250 * (i + 1));
    }
  }
  throw lastErr;
}

/* ---------- Main ---------- */
(async () => {
  // 1) Load data.json (accept array or { pokemon, games })
  const raw = await readFile(DATA_PATH, "utf8");
  let data = JSON.parse(raw);
  if (Array.isArray(data)) {
    data = { pokemon: data, games: [] };
  }

  const list = Array.isArray(data.pokemon) ? data.pokemon : [];
  if (list.length === 0) {
    console.error("No pokemon found in data.json");
    process.exit(1);
  }

  await ensureDir(OUT_DIR);

  // 2) Work queue with simple concurrency
  const queue = list.map(p => async () => {
    const id = String(p.id ?? "").trim();
    if (!id) { console.warn("Skipping entry with no id:", p); return; }
  
    const outPath = path.join(OUT_DIR, `${id}.png`);
    if (await fileExists(outPath)) {
      console.log(`✓ Exists  ${id}.png (skip)`);
      return;
    }
  
    const url = buildHomeUrl(p);
    if (!url) {
      console.warn(`⚠️  No numeric part in id=${id}`);
      return;
    }
  
    if (DRY_RUN) {
      console.log(`[dry] ${id}.png  ←  ${url}`);
      return;
    }
  
    try {
      const buf = await fetchWithRetry(url, 2);
      await writeFile(outPath, buf);
      console.log(`↓ Saved   ${id}.png  ←  ${url}`);
    } catch (e) {
      console.warn(`✗ Miss   ${id}.png  ←  ${url}  (${e.message})`);
    }
  
    await sleep(DELAY_MS);
  });
  

  // Run with limited parallelism
  let i = 0;
  const workers = Array(Math.max(1, CONCURRENCY)).fill(0).map(async () => {
    while (i < queue.length) {
      const job = queue[i++];
      await job();
    }
  });

  await Promise.all(workers);
  console.log("Done.");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
