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
