// ============================================================================
// LOOM M1 — GDELT 2.0 via BigQuery (STUB until the GCP project exists).
//
// Why BigQuery and not the free DOC API: the DOC API 429s persistently from
// cloud/VPS IPs (EREBUS already hit this and disabled it). The BigQuery route
// is the spec's answer — partition-filtered GKG pulls, ~$10-50/mo.
//
// To activate:
//   1. Create a GCP project, enable the BigQuery API, add billing + a $75 alert.
//   2. Create a service account with BigQuery Job User; download its JSON key.
//   3. On the VPS: mount the key and set
//        GOOGLE_APPLICATION_CREDENTIALS=/opt/erebus/gcp-key.json
//        GDELT_BQ_PROJECT=<project-id>
//        GDELT_BQ_ENABLED=1
//   4. pnpm add @google-cloud/bigquery --filter @erebus/loom, then replace the
//      stub body below with a real client call using GKG_QUERY.
// ============================================================================

// Partition-filtered GKG pull (cost discipline per spec §8): only the last
// N minutes, only allowlisted themes, only the columns we store.
export const GKG_QUERY = `
SELECT
  GKGRECORDID,
  DATE,
  SourceCommonName,
  DocumentIdentifier,
  V2Themes,
  V2Locations,
  V2Tone
FROM \`gdelt-bq.gdeltv2.gkg_partitioned\`
WHERE _PARTITIONTIME >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @minutes MINUTE)
  AND (
    V2Themes LIKE '%ECON_%' OR V2Themes LIKE '%ENERGY%' OR V2Themes LIKE '%CENTRAL_BANK%'
    OR V2Themes LIKE '%SANCTION%' OR V2Themes LIKE '%ARMEDCONFLICT%' OR V2Themes LIKE '%ELECTION%'
    OR V2Themes LIKE '%HEALTH_PANDEMIC%' OR V2Themes LIKE '%SUPPLY_CHAIN%'
  )
LIMIT 5000`;

export interface GdeltPullResult {
  enabled: boolean;
  pulled: number;
  skipped?: string;
}

export async function pullGdelt(): Promise<GdeltPullResult> {
  if (process.env.GDELT_BQ_ENABLED !== "1" || !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return {
      enabled: false,
      pulled: 0,
      skipped: "GDELT BigQuery not configured — set GDELT_BQ_ENABLED=1, GDELT_BQ_PROJECT, GOOGLE_APPLICATION_CREDENTIALS",
    };
  }
  // Real implementation lands once the GCP project exists (see header).
  return { enabled: true, pulled: 0, skipped: "BigQuery client not yet wired — @google-cloud/bigquery pending" };
}
