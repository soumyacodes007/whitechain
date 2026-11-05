import { createHash, randomBytes } from "node:crypto";

export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

export const newSecret = (prefix: string) => `${prefix}_${randomBytes(24).toString("hex")}`;

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
