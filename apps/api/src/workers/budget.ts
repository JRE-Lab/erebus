// Daily LLM budget guard shared by autonomous workers.
import { query } from "@erebus/db";

export async function withinBudget(): Promise<boolean> {
  const limit = Number(process.env.DAILY_LLM_BUDGET_USD ?? 10);
  if (limit <= 0) return true;
  const [row] = await query<{ total: string }>(
    "SELECT COALESCE(SUM(cost_usd),0)::text AS total FROM cost_entries WHERE created_at >= date_trunc('day', now())"
  );
  return Number(row?.total ?? 0) < limit;
}
