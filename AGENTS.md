# ypi

- Keep `ypi` completely user-agnostic and provider-agnostic. Never commit personal accounts, hostnames, credentials, or provider-specific defaults.
- Follow Pi's package conventions: host-provided packages (`@earendil-works/pi-*`, `typebox`) belong in `peerDependencies` with `"*"`, never `dependencies`.
- No code comments or docstrings in `src/` or `e2e/`. Express intent through clear names, types, and small functions.
- Validate configuration at the boundary with `zod`.
- Keep tests small, fast, and end-to-end against real files and manifests. Do not write unit tests that mirror implementation internals.
- Write documentation in plain sentences using plain hyphens, never em dashes.
