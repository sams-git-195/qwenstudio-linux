import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

function digestFile(p: string, algo: string, enc: "hex" | "base64"): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash(algo);
    createReadStream(p).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest(enc))).on("error", reject);
  });
}
export const sha256File = (p: string) => digestFile(p, "sha256", "hex");
export const sha512Base64File = (p: string) => digestFile(p, "sha512", "base64");
