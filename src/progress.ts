export class Progress {
  private fields = new Map<string, string>();
  private active = false;

  start(): void {
    this.active = true;
    this.render();
  }

  set(key: string, value: string | number): void {
    this.fields.set(key, String(value));
    if (this.active) this.render();
  }

  finish(finalMessage?: string): void {
    if (this.active) {
      process.stdout.write("\n");
      this.active = false;
    }
    if (finalMessage) process.stdout.write(finalMessage + "\n");
  }

  log(message: string): void {
    // Print a permanent line above the status line.
    if (this.active) {
      process.stdout.write("\r\x1b[2K"); // clear current line
      process.stdout.write(message + "\n");
      this.render();
    } else {
      process.stdout.write(message + "\n");
    }
  }

  private render(): void {
    const parts: string[] = [];
    for (const [k, v] of this.fields) parts.push(`${k} ${v}`);
    process.stdout.write("\r\x1b[2K" + parts.join(" · "));
  }
}
