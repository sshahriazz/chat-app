# Chat App

TypeScript pnpm monorepo powered by Turborepo.

## Structure

```
apps/
  web/       → Next.js (port 3000)
  server/    → Express.js (port 3001)
packages/
  shared/    → Shared types and utilities
```

## Getting Started

```bash
pnpm install
pnpm dev        # Start all apps in dev mode
pnpm build      # Build all packages
pnpm type-check # Run type checking across all packages
```

## Tech Stack

- **Build system:** Turborepo
- **Package manager:** pnpm (workspaces)
- **Frontend:** Next.js with Turbopack, Tailwind CSS
- **Backend:** Express.js with tsx (dev) and tsup (build)
- **Shared:** tsup for building, shared types across apps
