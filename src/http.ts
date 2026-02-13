import type { IncomingMessage, ServerResponse } from "node:http";

export function parseBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
            try {
                const body = Buffer.concat(chunks).toString("utf8");
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on("error", reject);
    });
}

export function withCors(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-api-key");
}

export function writeJson(
    res: ServerResponse,
    statusCode: number,
    payload: unknown
): void {
    withCors(res);
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json");
    res.end(
        JSON.stringify(payload, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value
        )
    );
}

export function getUrl(req: IncomingMessage, fallbackHost: string): URL {
    return new URL(req.url ?? "/", `http://${fallbackHost}`);
}
