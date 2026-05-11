import type { Tokens } from "./types.ts";

export async function loadTokens(): Promise<Tokens> {
  const envDev = process.env.AM_DEV_TOKEN?.trim();
  const envUser = process.env.AM_USER_TOKEN?.trim();

  const devToken = envDev || (await promptMasked("AM_DEV_TOKEN: "));
  const userToken = envUser || (await promptMasked("AM_USER_TOKEN: "));

  if (!devToken || !userToken) {
    throw new Error(
      "Both AM_DEV_TOKEN and AM_USER_TOKEN are required. " +
        "Set them in .env or paste them at the prompt."
    );
  }
  return { devToken, userToken };
}

async function promptMasked(message: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `${message.trim()} is required but no TTY is attached. ` +
        `Set the corresponding env var or run with -it.`
    );
  }

  process.stdout.write(message);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<string>((resolve) => {
    let input = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r" || char === "\u0004") {
          // Enter, or Ctrl+D (EOT)
          cleanup();
          process.stdout.write("\n");
          resolve(input);
          return;
        } else if (char === "\u0003") {
          // Ctrl+C (ETX)
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        } else if (char === "\u007f" || char === "\b") {
          // Backspace (DEL or BS)
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}
