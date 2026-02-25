export interface Logger {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}

export interface LoggerOptions {
    level?: string;
    /** Output JSON lines instead of human-readable text. Default: false */
    json?: boolean;
}

export function createLogger(levelOrOpts: string | LoggerOptions): Logger {
    const opts = typeof levelOrOpts === "string"
        ? { level: levelOrOpts, json: false }
        : levelOrOpts;
    const canInfo = opts.level !== "silent";
    const json = opts.json ?? (process.env.LOG_FORMAT === "json");

    if (json) {
        return createJsonLogger(canInfo);
    }

    return {
        info: (...args: unknown[]) => {
            if (!canInfo) return;
            console.log(`[${new Date().toISOString()}] [INFO]`, ...args);
        },
        warn: (...args: unknown[]) => {
            console.warn(`[${new Date().toISOString()}] [WARN]`, ...args);
        },
        error: (...args: unknown[]) => {
            console.error(`[${new Date().toISOString()}] [ERROR]`, ...args);
        },
    };
}

/** JSON structured logger — one JSON object per line, compatible with cloud log aggregators */
function createJsonLogger(canInfo: boolean): Logger {
    const emit = (level: string, args: unknown[]) => {
        const entry: Record<string, unknown> = {
            ts: new Date().toISOString(),
            level,
            msg: args.map(a =>
                typeof a === "string" ? a : JSON.stringify(a)
            ).join(" "),
        };

        // Extract tokenId from message for structured queries
        const tokenMatch = entry.msg && typeof entry.msg === "string"
            ? entry.msg.match(/\[(\d+)\]/)
            : null;
        if (tokenMatch) {
            entry.tokenId = tokenMatch[1];
        }

        const line = JSON.stringify(entry);
        if (level === "error") {
            process.stderr.write(line + "\n");
        } else {
            process.stdout.write(line + "\n");
        }
    };

    return {
        info: (...args: unknown[]) => {
            if (!canInfo) return;
            emit("info", args);
        },
        warn: (...args: unknown[]) => emit("warn", args),
        error: (...args: unknown[]) => emit("error", args),
    };
}
