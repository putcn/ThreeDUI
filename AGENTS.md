# Working in ThreeDUI

When creating or changing GlassUI interfaces in this repository, read [the build-glassui skill](./.agents/skills/build-glassui/SKILL.md) first. It points to the current setup, generated component API manifest, and runnable examples.

Use the actual workspace packages and verify changes with `pnpm typecheck`, relevant `pnpm test` cases, and `pnpm playground:build`. The spatial demo and component gallery are in `examples/playground`; package metadata changes require `pnpm manifest`.
