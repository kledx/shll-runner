export interface Logger {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}

export function createLogger(level: string): Logger {
    const canInfo = level !== "silent";
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

