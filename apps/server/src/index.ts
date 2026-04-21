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

const app = express();

app.use(
  cors({
    origin: ["http://localhost:3000", "http://192.168.0.101:3000"],
    credentials: true,
  }),
);

// better-auth handler MUST come before express.json()
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
  console.log(`Server running on http://localhost:${env.PORT}`);
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
          console.log(
            `[cron] orphan-attachments: deleted=${result.deleted} s3Errors=${result.s3Errors}`,
          );
        }
      } catch (err) {
        console.error("[cron] orphan-attachments failed:", err);
      }
    });
  });
});
