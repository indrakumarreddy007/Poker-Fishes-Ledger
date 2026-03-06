import { createServer as createViteServer } from "vite";
import path from "path";
import express from "express";
import apiApp from "./api/index.js";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Mount API routes
  app.use(apiApp);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // In production, we're likely on Vercel handling standard static routing,
    // but we can keep this fallback for manual local production builds
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
