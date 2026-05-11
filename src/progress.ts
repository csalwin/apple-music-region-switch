export class Progress {
  private fields = new Map<string, string>();
  private active = false;
  private startTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.active = true;
    this.startTime = Date.now();
    this.timer = setInterval(() => this.render(), 1000);
    this.render();
  }

  set(key: string, value: string | number): void {
    this.fields.set(key, String(value));
    if (this.active) this.render();
  }

  finish(finalMessage?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.active) {
      process.stdout.write("\n");
      this.active = false;
    }
    if (finalMessage) {
      process.stdout.write(finalMessage);
      const elapsed = this.startTime > 0 ? Date.now() - this.startTime : 0;
      if (elapsed > 0) {
        process.stdout.write(`  elapsed:   ${formatElapsed(elapsed)}\n`);
      }
    }
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
    if (!this.active) return;
    const parts: string[] = [];
    const elapsedMs = Date.now() - this.startTime;
    parts.push(`elapsed ${formatElapsed(elapsedMs)}`);

    // Aggregate ETA across any fields shaped as "N/M".
    let totalDone = 0;
    let totalTodo = 0;
    for (const v of this.fields.values()) {
      const m = v.match(/^(\d+)\/(\d+)/);
      if (m) {
        totalDone += Number(m[1]);
        totalTodo += Number(m[2]);
      }
    }
    if (totalTodo > totalDone && totalDone > 0 && elapsedMs > 1000) {
      const ratePerMs = totalDone / elapsedMs;
      const etaMs = (totalTodo - totalDone) / ratePerMs;
      parts.push(`eta ${formatElapsed(etaMs)}`);
    }

    for (const [k, v] of this.fields) parts.push(`${k} ${v}`);
    process.stdout.write("\r\x1b[2K" + parts.join(" · "));
  }
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
