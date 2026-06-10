# Repository Guidelines

## Project Structure & Module Organization

TM Code is a React + TypeScript desktop IDE packaged with Tauri. Frontend code lives in `src/`: UI in `src/components`, hooks in `src/hooks`, services in `src/services`, state in `src/stores`, theme code in `src/theme` and `src/themes`, and shared types/utilities in `src/types` and `src/utils`. Assets and browser workers are under `public/`. Native Tauri/Rust code is in `src-tauri/`, with commands grouped under `src-tauri/src/commands`. Project templates are in `src-tauri/resources/templates`. Tests are colocated in `__tests__` folders or use `*.test.ts(x)`.

## Build, Test, and Development Commands

- `yarn install`: install dependencies with Yarn 1.22.
- `yarn dev`: start the Vite web app.
- `yarn tauri dev`: run the desktop app in Tauri development mode.
- `yarn build`: type-check with `tsc` and build the Vite bundle.
- `yarn test`: run the Jest suite.
- `yarn test:watch`: run Jest in watch mode.
- `yarn test:coverage`: collect coverage for `src/**/*.{ts,tsx}`.
- `yarn preview`: build, then run the Cloudflare Worker locally with Wrangler.
- `yarn deploy`: build and deploy with Wrangler.

## Related Project Paths

- `worker`: `~/dev/deskotp/toquemedia-studio-api`
- `web`: `~/dev/web/toquemedia-studio`
- `claude-vaz`: `~/dev/claude-vaz`

## Coding Style & Naming Conventions

Use TypeScript with strict compiler settings; avoid unused locals and parameters. Prefer the `@/` alias for imports from `src`. Match the existing style: 2-space JSON indentation, React components in PascalCase, hooks named `useSomething`, services named `somethingService.ts`, and tests named `feature.test.ts` or `Component.test.tsx`. Prettier is available, but no formatting script is defined; follow nearby code.

## Testing Guidelines

Jest uses `ts-jest` and `jsdom`. React tests should use Testing Library patterns and `src/components/__tests__/setupTests.ts`. Add focused tests beside the feature being changed, usually in `src/services/__tests__`, `src/hooks/__tests__`, `src/utils/__tests__`, or a component-level `__tests__` directory. Run `yarn test` before submitting changes; use `yarn test:coverage` for shared services or riskier behavior.

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects and conventional-style prefixes such as `ci:`, plus release fixes like `Fix v0.7.4` and `Ref:`. Keep commits scoped and descriptive, for example `ci: validate release auth` or `fix: normalize windows path`. Pull requests should include a summary, test results, linked issues when applicable, and screenshots or recordings for UI changes. Note any Wrangler or Tauri packaging impact.

## Security & Configuration Tips

Do not commit secrets, local tokens, or generated credentials. Treat `wrangler.jsonc`, Firebase configuration, updater settings, and Tauri signing/release scripts as deployment-sensitive. Keep platform-specific build changes isolated.
