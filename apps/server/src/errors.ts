import type { ErrorCode } from "@sweatbox/shared";
import type { z } from "zod";

/** Any error with a status and machine code; rendered as { error, code, ... }. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** 409 REJECTED: the instruction isn't possible right now. The text is shown to the host verbatim. */
export const reject = (message: string): HttpError => new HttpError(409, "REJECTED", message);
export const badInput = (message: string, details?: unknown): HttpError => new HttpError(400, "BAD_INPUT", message, details ? { details } : {});
export const notFound = (code: "NO_SESSION" | "NO_AIRCRAFT" | "NO_SCENARIO", message: string): HttpError => new HttpError(404, code, message);

/** Validate a request body; 400 BAD_INPUT with the zod issues as details on failure. */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const res = schema.safeParse(body ?? {});
  if (!res.success) {
    const first = res.error.issues[0];
    const msg = first ? (first.path.length ? `${first.path.join(".")}: ${first.message}` : first.message) : "Bad input";
    throw badInput(msg, res.error.issues.map((i) => ({ path: i.path, message: i.message })));
  }
  return res.data;
}
