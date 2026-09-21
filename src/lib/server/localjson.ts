/** Small JSON files on this machine only (collector caches that are not worth sharing). */
import fs from 'fs';
import path from 'path';

export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf-8'));
	} catch {
		return fallback;
	}
}

export function writeJson(file: string, value: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}
