import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  earlyAccess: true,
  schema: "prisma/schema.prisma",
  migrate: {
    adapter: async () => {
      const { PrismaPg } = await import("@prisma/adapter-pg");
      return new PrismaPg({ connectionString: env("DATABASE_URL") });
    },
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
