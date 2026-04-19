import express from 'express';
import apiApp from './api/index';

const app = express();

// Mount all API routes (Fishes + Live)
app.use(apiApp);

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    // Dev: use Vite middleware for HMR and SPA serving
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Production: serve built static files
    app.use(express.static('dist'));
    app.get('*', (_req, res) => {
      res.sendFile('index.html', { root: 'dist' });
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

startServer();
