import { readFileSync } from 'fs';

export function parseConfig(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const config = JSON.parse(raw);

  return {
    port: config.port ?? 3000,
    dataDir: config.dataDir ?? 'data',
    theme: config.theme ?? 'light',
    features: config.features ?? {},
  };
}
