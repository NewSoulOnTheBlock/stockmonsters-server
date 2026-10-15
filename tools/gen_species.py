"""Regenerate species.json and moves.json from the stockred decomp.
Usage: python -I tools/gen_species.py ../stockred
Rerun whenever species names, stats, types or moves change in the ROM.

species.json: {numSpecies, names: {id: name}, info: {id: {slot, ticker, base, types}}}
  base = [hp, atk, def, speed, spAtk, spDef] (the in-game struct order)
moves.json:   {names: {id: name}}"""
import json, re, sys, pathlib

root = pathlib.Path(sys.argv[1])
out = pathlib.Path(__file__).resolve().parent.parent

# Stockmonsters type names (GLOSSARY.md), indexed by TYPE_* value.
TYPE_NAMES = ["NEUTRAL", "COMBAT", "WIND", "TOXIC", "TERRA", "STONE", "SWARM", "SPECTRE", "ALLOY",
              "???", "BLAZE", "TIDE", "FLORA", "VOLT", "PSIONIC", "FROST", "WYRM", "SHADOW"]
TYPE_IDS = {f"TYPE_{n}": i for i, n in enumerate(["NORMAL", "FIGHTING", "FLYING", "POISON", "GROUND", "ROCK", "BUG",
            "GHOST", "STEEL", "MYSTERY", "FIRE", "WATER", "GRASS", "ELECTRIC", "PSYCHIC", "ICE", "DRAGON", "DARK"])}

species_h = (root / "include/constants/species.h").read_text()
ids = {m[1]: int(m[2]) for m in re.finditer(r"#define (SPECIES_\w+) (\d+)\b", species_h)}

names = {}
for m in re.finditer(r'\[(SPECIES_\w+)\]\s*=\s*_\("([^"]*)"\)', (root / "src/data/text/species_names.h").read_text(encoding="utf-8")):
    if m[1] in ids:
        names[ids[m[1]]] = m[2]

tickers = {}
roster = json.loads((root / "tools/stockmonsters/roster.json").read_text(encoding="utf-8"))
for e in roster:
    sid = ids.get("SPECIES_" + e["slot"])
    if sid is not None:
        tickers[sid] = e["ticker"]

info = {}
src = (root / "src/data/pokemon/species_info.h").read_text(encoding="utf-8")
# Blocks open with "[SPECIES_X] =" then "{" on its own line; one-liners like
# "[SPECIES_NONE] = {0}," must not swallow the next block.
for m in re.finditer(r"\[(SPECIES_\w+)\]\s*=\s*\n\s*\{(.*?)\n    \},", src, re.S):
    sid = ids.get(m[1])
    if sid is None:
        continue
    body = m[2]
    stat = lambda k: int(re.search(rf"\.{k}\s*=\s*(\d+)", body)[1])
    t = re.search(r"\.types\s*=\s*\{\s*(TYPE_\w+),\s*(TYPE_\w+)", body)
    types = [TYPE_NAMES[TYPE_IDS[t[1]]], TYPE_NAMES[TYPE_IDS[t[2]]]] if t else []
    info[sid] = {
        "slot": m[1][len("SPECIES_"):],
        "ticker": tickers.get(sid),
        "base": [stat("baseHP"), stat("baseAttack"), stat("baseDefense"), stat("baseSpeed"), stat("baseSpAttack"), stat("baseSpDefense")],
        "types": sorted(set(types), key=types.index),
    }

num_species = ids.get("NUM_SPECIES", ids.get("SPECIES_EGG"))
(out / "species.json").write_text(json.dumps({"numSpecies": num_species, "names": names, "info": info}, indent=0), encoding="utf-8")

move_ids = {m[1]: int(m[2]) for m in re.finditer(r"#define (MOVE_\w+) (\d+)\b", (root / "include/constants/moves.h").read_text())}
moves = {}
for m in re.finditer(r'\[(MOVE_\w+)\]\s*=\s*_\("([^"]*)"\)', (root / "src/data/text/move_names.h").read_text(encoding="utf-8")):
    if m[1] in move_ids and move_ids[m[1]] != 0:
        moves[move_ids[m[1]]] = m[2]
(out / "moves.json").write_text(json.dumps({"names": moves}, indent=0), encoding="utf-8")
print(f"species {len(names)} (info {len(info)}, tickers {len(tickers)}), moves {len(moves)}")
