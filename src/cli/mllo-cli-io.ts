import type { Readable, Writable } from "node:stream";

export type MlloCliIo = {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stderr: Writable;
};

export function writeCliLine(stream: Writable, line = ""): void {
  stream.write(`${line}\n`);
}

export function writeCliText(stream: Writable, text: string): void {
  stream.write(text);
}

export async function readMlloCliStdin(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
