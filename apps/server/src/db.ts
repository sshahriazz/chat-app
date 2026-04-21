/**
 * Legacy re-export — the real singleton lives at `infra/prisma.ts`.
 * All new code should import from `./infra/prisma` directly; this shim
 * only exists so the large number of pre-existing `import { prisma }
 * from "./db"` sites don't need a mass rewrite in this pass.
 */
export { prisma } from "./infra/prisma";
