import "dotenv/config";
import express from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth";
import { env } from "./env";
import centrifugoRoutes from "./routes/centrifugo";
import chatRoutes from "./routes/chat";
import userRoutes from "./routes/users";
import attachmentRoutes from "./routes/attachments";
import pushRoutes from "./routes/push";
import { authLimiter } from "./middleware/rate-limit";
import { logger } from "./lib/logger";

const app = express();

const allowedOrigins: string[] = (
  env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3000,http://192.168.0.103:3000"
)
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

// better-auth handler MUST come before express.json()
// Brute-force gating on the unauthenticated auth endpoints. Registered
// BEFORE the catch-all so `next()` in the limiter falls through to
// `toNodeHandler(auth)` — same-path middleware is processed in order.
// Better-auth has its own internal limiter too, but it's per-process and
// lenient; ours caps at 10/min/IP for sign-in and sign-up.
app.use(["/api/auth/sign-in", "/api/auth/sign-up"], authLimiter);

app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json());

// Routes
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/centrifugo", centrifugoRoutes);
app.use("/api/users", userRoutes);
app.use("/api/attachments", attachmentRoutes);
app.use("/api/push", pushRoutes);
app.use("/api", chatRoutes);

app.listen(env.PORT, () => {
  logger.info("server listening", { port: env.PORT });
});

// Background jobs — only register when this process owns them. Under a
// multi-instance deploy this is safe per-instance because gcOrphanAttachments
// is idempotent (row deletes race harmlessly).
import("node-cron").then(({ default: cron }) => {
  import("./lib/attachments-gc").then(({ gcOrphanAttachments }) => {
    // Every 6 hours at :05 past the hour.
    cron.schedule("5 */6 * * *", async () => {
      try {
        const result = await gcOrphanAttachments();
        if (result.deleted > 0 || result.s3Errors > 0) {
          logger.info("cron attachments-gc", {
            deleted: result.deleted,
            s3Errors: result.s3Errors,
          });
        }
      } catch (err) {
        logger.error("cron attachments-gc failed", { err: err as Error });
      }
    });
  });
});
