# Repository Guidelines

## Project Structure & Module Organization
This repo has two processes: `bot-node/` (strict TypeScript Discord bot, `src/index.ts` ➜ `dist/`) and `stt-web/` (Vite + React speech UI with `App.jsx`, `main.jsx`, `style.css`). Both import the root-level `config.json` for keywords, volumes, `cooldownMs`, and `wsPort`; make sure its mp3 entries exist under `bot-node/sounds/`. Keep Discord credentials only in the git-ignored `bot-node/.env`.

## Build, Test, and Development Commands
- `npm run init` – install dependencies across the workspace.
- `npm run dev` – run both processes (bot via `tsx`, web via `vite --host`); `dev:bot` or `dev:web` target a single process.
- `npm run build` – run `tsc` for the bot and `vite build` for the web client.
- `npm run start` – serve the compiled bot (`node dist/index.js`) plus `vite preview --host`.
- `cd bot-node && npm run deploy:commands` – register slash commands after changing names, descriptions, or guild scopes.

## Coding Style & Naming Conventions
Stick to 2-space indentation and the strict TypeScript compiler settings already enabled. Types/interfaces use PascalCase, runtime variables camelCase, and environment variables upper snake case. Keep helper functions near their usage inside `bot-node/src/index.ts`. React files under `stt-web/src` stay as PascalCase function components. When editing `config.json`, normalize keyword casing, keep filenames descriptive, and confirm the `sounds/` file exists before pushing.

## Testing Guidelines
Automated tests are not configured yet. Before opening a PR, run `npm run dev`, hit `/join` and `/testplay`, and speak a keyword so you see the WebSocket hit and cooldown behavior end-to-end. If you introduce Vitest/Jest, co-locate specs as `*.test.ts(x)` files, wire the command in `package.json`, and document how to run it here.

## Commit & Pull Request Guidelines
With no existing history, use concise imperative commit titles such as `bot: clamp invalid volumes` or `web: show reconnect banner`, and keep unrelated edits in separate commits. Pull requests need a short summary of the user-visible change, explicit notes on config/env updates, screenshots or console logs for UI/audio work, and the manual test steps you executed. Reference any Discord issue IDs if they exist.

## Configuration & Security Tips
Run the bot locally after editing `config.json`; it validates mappings and file paths during boot. Keep `volume` between 0 and 2, align `config.wsPort` to `WS_PORT`, and avoid committing production tokens—use local `.env` files or your secret manager.
