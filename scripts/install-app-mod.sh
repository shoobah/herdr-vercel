#!/bin/sh
# Installs the Vercel mod into the Herdr desktop app. `herdr plugin install`
# and `herdr plugin update` run it from the root of this repo.
#
# 1. Copies mods/vercel/ to <app home>/mods/vercel/. An update replaces the
#    files there.
# 2. Adds the keys of keys.json to <app home>/keys.json: cmd-e opens the
#    popup, and the "mod:vercel" block gives Esc to the mod. A key
#    that is already bound stays as it is.
#
# The app home is $HERDR_APP_HOME, else ~/.config/herdr-app.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
dest="$app/mods/vercel"

mkdir -p "$app/mods"
tmp="$app/mods/.vercel.new"
rm -rf "$tmp"
cp -R "$root/mods/vercel" "$tmp"
rm -rf "$dest"
mv "$tmp" "$dest"
echo "Installed the Vercel mod in $dest"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is not available, so keys.json did not change."
  echo "Merge $root/keys.json into $app/keys.json yourself."
  exit 0
fi

python3 - "$root/keys.json" "$app/keys.json" <<'PY'
import json, os, sys

src, dst = sys.argv[1], sys.argv[2]
add = json.load(open(src))
keys = {}
if os.path.exists(dst):
    try:
        keys = json.load(open(dst))
    except ValueError:
        print(f"{dst} is not valid JSON, so it did not change. Merge {src} into it yourself.")
        sys.exit(0)

added, kept = [], []
for section, binds in add.items():
    have = keys.setdefault(section, {})
    for k, cmd in binds.items():
        if k in have and have[k] != cmd:
            kept.append(f"{section} {k} ({have[k]})")
        elif k not in have:
            have[k] = cmd
            added.append(f"{section} {k}")

if added:
    tmp = dst + ".vercel-tmp"
    with open(tmp, "w") as f:
        json.dump(keys, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, dst)
    print("Added keys: " + ", ".join(added))
for k in kept:
    print(f"Did not change {k}: it is already bound. Bind mod.open:vercel to another key.")
PY
