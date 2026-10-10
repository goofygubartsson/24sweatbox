import { ApiError } from "../../lib/api";
import { toast } from "../../components/Toast";
import { useScope } from "../store";

/** Run a host action; 409 texts are shown verbatim (message area + toast). */
export async function act<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof ApiError || e instanceof Error ? e.message : String(e);
    useScope.getState().say(msg, "error-local");
    toast(msg, "error");
    return null;
  }
}

export const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
};
