import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditStorage } from './storage.js';

/**
 * Node-only adapter: JSONL file on local disk, created (with parent
 * directories) on first use. Appends use O_APPEND semantics via fs.appendFile.
 *
 * Durability note: this is the minimal compliant backbone. Production
 * deployments should ship/rotate these files to tamper-resistant retention
 * storage (WORM/object-lock) — see README retention section.
 */
export class FsJsonlStorage implements AuditStorage {
  readonly filePath: string;
  private ready = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async ensureFile(): Promise<void> {
    if (this.ready) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await writeFile(this.filePath, '', { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw err;
    }
    this.ready = true;
  }

  async append(line: string): Promise<void> {
    await this.ensureFile();
    await appendFile(this.filePath, `${line}\n`, 'utf8');
  }

  async readAll(): Promise<string[]> {
    await this.ensureFile();
    const text = await readFile(this.filePath, 'utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
}
