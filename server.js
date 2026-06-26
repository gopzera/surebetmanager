require('dotenv').config();
// Local dev overrides (gitignored). On Vercel these files don't exist, so this is
// a no-op and the platform-injected env vars are used.
require('dotenv').config({ path: '.env.local', override: true });

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET não definido. Defina no .env antes de iniciar.');
  process.exit(1);
}

const app = require('./app');
const db = require('./db/database');

const PORT = process.env.PORT || 3000;

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Surebet Manager rodando em http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Falha ao inicializar banco de dados:', err);
  process.exit(1);
});
