// Operation journal: append-only JSONL under spool/. Recovery reads it; the
// same ids dedupe against spool result files.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "spool",
        "journal.jsonl",
);

export interface Op {
        id: string;
        ts: number;
        question: string;
        mode: string;
        status: string; // submitted | imported | failed | needs-attention | captured
        url?: string;
        error?: string;
        answerChars?: number;
}

function readOps(): Op[] {
        try {
                return fs
                        .readFileSync(FILE, "utf8")
                        .split("\n")
                        .filter(Boolean)
                        .map((l) => {
                                try {
                                        return JSON.parse(l) as Op;
                                } catch {
                                        return null; // tolerate a torn last line
                                }
                        })
                        .filter((o): o is Op => o !== null);
        } catch {
                return [];
        }
}

export function appendOp(op: Op) {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.appendFileSync(FILE, JSON.stringify(op) + "\n");
}

export function markOp(id: string, patch: Partial<Op>) {
        const ops = readOps();
        const i = ops.findIndex((o) => o.id === id);
        if (i === -1) return;
        ops[i] = { ...ops[i], ...patch };
        const tmp = FILE + ".tmp";
        fs.writeFileSync(
                tmp,
                ops.map((o) => JSON.stringify(o)).join("\n") + "\n",
        );
        fs.renameSync(tmp, FILE);
}

export function findOp(id: string): Op | undefined {
        return readOps().find((o) => o.id === id);
}

export function pendingOps(): Op[] {
        return readOps().filter(
                (o) => o.status !== "imported" && o.status !== "failed",
        );
}
