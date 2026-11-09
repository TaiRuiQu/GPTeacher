import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

let loaded = false;

/** Never expose server environment values to Vite's client-side defines. */
export function loadServerEnvironment() {
  if (loaded) return;
  loaded = true;
  // Node preserves values already present in the process. Local overrides defaults.
  for (const name of ['.env.local', '.env']) {
    const target = resolve(process.cwd(), name);
    if (existsSync(target)) process.loadEnvFile(target);
  }
}
