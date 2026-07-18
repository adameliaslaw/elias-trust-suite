/**
 * Pluggable persistence for the audit log. The log speaks JSONL lines;
 * a storage adapter only needs to append a line and read all lines back
 * in append order. Implementations must be append-only in spirit: the log
 * never rewrites or deletes lines, and verify() detects if anything else did.
 */
export interface AuditStorage {
  /** Append one JSONL line (no trailing newline handling required from caller). */
  append(line: string): Promise<void>;
  /** Read every line in append order. */
  readAll(): Promise<string[]>;
}

/** Process-local adapter for tests, dev, and non-durable contexts. */
export class InMemoryStorage implements AuditStorage {
  private lines: string[] = [];

  append(line: string): Promise<void> {
    this.lines.push(line);
    return Promise.resolve();
  }

  readAll(): Promise<string[]> {
    return Promise.resolve([...this.lines]);
  }

  get length(): number {
    return this.lines.length;
  }

  /** Test/simulation helper: overwrite a stored line in place (tamper simulation). */
  replaceLine(index: number, line: string): void {
    if (index < 0 || index >= this.lines.length) throw new RangeError(`line index ${index} out of range`);
    this.lines[index] = line;
  }

  /** Test/simulation helper: remove a stored line (tamper simulation). */
  removeLine(index: number): void {
    if (index < 0 || index >= this.lines.length) throw new RangeError(`line index ${index} out of range`);
    this.lines.splice(index, 1);
  }

  /** Test helper: read a raw stored line. */
  lineAt(index: number): string {
    const line = this.lines[index];
    if (line === undefined) throw new RangeError(`line index ${index} out of range`);
    return line;
  }
}
