import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

function canonicalize(value: unknown): string {
    if (typeof value === "bigint") {
        return JSON.stringify(value.toString());
    }
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalize(v)).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
    );
    return `{${entries
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
        .join(",")}}`;
}

export function sha256Hex(input: unknown): string {
    const canonical = canonicalize(input);
    return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function decodeSignature(raw: string): Buffer {
    const trimmed = raw.trim();
    if (trimmed.startsWith("0x")) {
        return Buffer.from(trimmed.slice(2), "hex");
    }
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        return Buffer.from(trimmed, "hex");
    }
    return Buffer.from(trimmed, "base64");
}

export function verifyPackSignature(params: {
    pack: unknown;
    signature: string;
    publicKeyPem: string;
}): boolean {
    const message = Buffer.from(canonicalize(params.pack), "utf8");
    const signatureBytes = decodeSignature(params.signature);
    const key = createPublicKey(params.publicKeyPem);
    return verifySignature(null, message, key, signatureBytes);
}
