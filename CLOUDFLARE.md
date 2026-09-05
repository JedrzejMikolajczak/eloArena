# Cloudflare Pages setup

1. In Cloudflare Dashboard, open **Workers & Pages** and create a Pages project from `JedrzejMikolajczak/eloArena`.
2. Set the production branch to `main`.
3. Use these build settings:
   - Framework preset: `None`
   - Build command: leave empty
   - Build output directory: `.`
4. Create a KV namespace, for example `elo-arena-state`.
5. In the Pages project, open **Settings -> Functions -> KV namespace bindings** and add:
   - Variable name: `STATE`
   - KV namespace: `elo-arena-state`
6. In **Settings -> Environment variables**, add `ADMIN_PASSWORD` with your own password. Mark it as secret if Cloudflare offers that option.
7. Trigger a new deployment after adding the binding and variable.

The app uses the Cloudflare Pages Function at `/state`. The KV namespace stores the shared queue, players, matches and settings.
