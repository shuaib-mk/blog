// Local server (`npm run dev`, `npm start`).
//
// This used to be a second, hand-maintained copy of the whole API. It drifted
// from api/index.js (what Vercel runs in production): fixes landed in one and
// not the other, and local dev was missing routes such as /api/search
// (Archive search) and /api/media/presign. It now runs the exact same app as
// production, so local behaviour - including the realtime SSE stream and
// broadcast routes - always matches the live site.

// Load .env before the API module (and its Supabase/B2 clients) initialise.
import 'dotenv/config';
import app from '../api/index.js';

export * from '../api/index.js';

const PORT = process.env.PORT || 3001;

if (!process.env.VERCEL && process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Backend server active on http://localhost:${PORT} connected to Supabase & Backblaze B2.`);
  });
}

export default app;
