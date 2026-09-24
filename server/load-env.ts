/**
 * Environment bootstrap - MUST be the first import in app.ts.
 *
 * ES modules are fully evaluated before the importing module's own top-level
 * statements run, so calling dotenv.config() inside app.ts's body executes
 * AFTER every imported module (server/auth.ts, server/db_pool.ts, ...) has
 * already been evaluated. Any module that captures process.env at import time
 * - e.g. server/auth.ts reading JWT_SECRET into a module-scope constant - would
 * therefore see the pre-dotenv, unset value. Importing this file first fixes
 * the ordering: dependencies are evaluated in source order, so this runs before
 * the rest.
 *
 * Locally this loads .env.local (where DATABASE_URL, JWT_SECRET and the SEED_*
 * values live). dotenv never overrides variables that are already set, so on
 * Vercel the injected process environment wins and this is a no-op. A missing
 * file is also harmless - the server simply falls back to the real process env.
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
