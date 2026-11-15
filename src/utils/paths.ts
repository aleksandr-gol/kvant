import { join } from 'node:path';

const KVANT_DIR = '.kvant';

export function getKvantDir(): string {
  return KVANT_DIR;
}

export function kvantPath(...segments: string[]): string {
  return join(getKvantDir(), ...segments);
}
