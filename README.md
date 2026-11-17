# Vercel for Herdr

A [Herdr](https://herdr.dev) mod: your Vercel deployments in a popup. The current production deployment is green. Open a deployment to see its URL, aliases, commit, pull request and the end of its build log. Redeploy, promote or cancel it. One key starts an agent on a failed build.

![Vercel](preview.png)

`RECIPE.md` tells how the mod looks and behaves, and how to build it from scratch.

## Install

With the Herdr CLI (macOS and Linux):

1. Run `herdr plugin install shoobah/herdr-vercel`.
2. Run `vercel login`, or set `VERCEL_TOKEN`.
3. In the Herdr app, push ⌘E.

The install copies `mods/vercel/` into `~/.config/herdr-app/mods/` (or `$HERDR_APP_HOME/mods/`). It also adds the keys of `keys.json` to the `keys.json` of the app. If ⌘E is already bound, the install does not change it. Then bind `mod.open:vercel` to a different key yourself. `herdr plugin update` installs the new version of the mod and replaces the files in `mods/vercel/`.

The repo is a mod for the Herdr desktop app, not a TUI plugin. `herdr-plugin.toml` only lists it on the [Herdr marketplace](https://herdr.dev/plugins/) and runs `scripts/install-app-mod.sh`. It adds no actions or panes to the TUI.

By hand:

1. Copy `mods/vercel/` into `~/.config/herdr-app/mods/`.
2. Merge `keys.json` into `~/.config/herdr-app/keys.json`. It binds ⌘E to open the popup.
3. Run `vercel login`, or set `VERCEL_TOKEN`.
4. Run `herdr-app check ~/.config/herdr-app/mods/vercel`.

To try it without a token, open the popup and run `herdr-app do vercel.demo`.

The mod runs `sh`, `curl`, `git` and `vercel whoami` to reach Vercel's API and to renew the CLI's token. It reads the Vercel CLI's `auth.json` and `config.json`, and `.vercel/project.json` in the shown repo.

## Credits

`mods/vercel/look.js` and the icons in `mods/vercel/icons/` come from the `linear` mod that ships with Herdr. They give this popup the same look as Herdr's Linear popup. They belong to Herdr's authors and are not covered by this repo's MIT license. The rest of the code is under the MIT license in `LICENSE`.
