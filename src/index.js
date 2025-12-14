import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

const resolver = new Resolver();

// Config (tune later if needed)
const BLOCKED_STATUS_NAME = 'Waiting for support';
const STALE_MEDIUM_HOURS = 24;
const STALE_HIGH_HOURS = 72;

// SLA thresholds (Option B)
const SLA_HIGH_HOURS = 2;   // < 2h remaining => HIGH
const SLA_MEDIUM_HOURS = 8; // < 8h remaining => MEDIUM

function hoursSince(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, ms / (1000 * 60 * 60));
}

// Parse Jira Service Management SLA remaining time (best-effort)
// We support the common patterns Jira shows like: "2h 30m", "45m", "1d 3h", "Breached"
function parseSlaRemainingToHours(text) {
  if (!text) return null;

  const t = String(text).toLowerCase().trim();

  // Common breached flags
  if (t.includes('breach') || t.includes('breached') || t.includes('overdue')) {
    return 0; // treat as 0 hours remaining
  }

  // Examples: "1d 2h", "2h 30m", "45m"
  const dayMatch = t.match(/(\d+)\s*d/);
  const hourMatch = t.match(/(\d+)\s*h/);
  const minMatch = t.match(/(\d+)\s*m/);

  const days = dayMatch ? parseInt(dayMatch[1], 10) : 0;
  const hours = hourMatch ? parseInt(hourMatch[1], 10) : 0;
  const mins = minMatch ? parseInt(minMatch[1], 10) : 0;

  // If nothing matched, we can't parse
  if (!dayMatch && !hourMatch && !minMatch) return null;

  return days * 24 + hours + mins / 60;
}

// Try to extract “time to first response” remaining from fields.sla (JSM)
// Because SLA field structure can vary, we do a best-effort extraction:
// - If we can find a SLA entry whose name includes "first response", we use it.
// - Else we return null and we simply don't apply SLA escalation.
function extractFirstResponseSlaRemainingHours(fields) {
  const sla = fields?.sla;
  if (!sla) return null;

  // Some instances expose SLA as an array under sla.completedCycles / ongoingCycle, etc.
  // Others expose as an object map. We'll handle both in a defensive way.
  const candidates = [];

  if (Array.isArray(sla)) {
    candidates.push(...sla);
  } else if (typeof sla === 'object') {
    // If it's a map of SLA objects
    for (const key of Object.keys(sla)) {
      candidates.push(sla[key]);
    }
  }

  // Flatten potential entries
  for (const entry of candidates) {
    const name = entry?.name || entry?.goalName || entry?.metricName || '';
    const n = String(name).toLowerCase();

    if (!n.includes('first response')) continue;

    // Common places remaining text may appear
    const remainingText =
      entry?.ongoingCycle?.remainingTime?.friendly ||
      entry?.ongoingCycle?.remainingTime?.display ||
      entry?.ongoingCycle?.remainingTime ||
      entry?.remainingTime?.friendly ||
      entry?.remainingTime?.display ||
      entry?.remainingTime ||
      entry?.ongoingCycle?.remainingTime?.text ||
      entry?.ongoingCycle?.remainingTime?.value ||
      null;

    const hours = parseSlaRemainingToHours(remainingText);
    if (hours !== null) return hours;

    // If breached flag exists
    if (entry?.ongoingCycle?.breached === true || entry?.breached === true) return 0;
  }

  return null;
}

resolver.define('getAtRiskIssues', async ({ context }) => {
  const projectKey = context?.extension?.project?.key;

  if (!projectKey) {
    return { issues: [], error: 'No project key found in context.' };
  }

  // Request fields needed:
  // - summary, status, updated (existing)
  // - assignee (Option B, owner visibility)
  // - sla (Option B, SLA-aware escalation; may be available in JSM contexts)
  const jql = `project = ${projectKey} AND statusCategory != Done ORDER BY updated ASC`;

  const res = await api.asUser().requestJira(
    route`/rest/api/3/search/jql?jql=${jql}&maxResults=10&fields=summary,status,updated,assignee,sla`
  );

  if (!res.ok) {
    const text = await res.text();
    return { issues: [], error: `Jira API failed: ${res.status} ${text}` };
  }

  const data = await res.json();

  const issues = (data.issues || [])
    .map((i) => {
      const status = i.fields?.status?.name || 'Unknown';
      const updated = i.fields?.updated;
      const staleHours = updated ? hoursSince(updated) : null;

      const summary = i.fields?.summary || '';
      const isDemoHigh = summary.includes('[DEMO-HIGH]');
      const isBlocked = status === BLOCKED_STATUS_NAME;
      const isUnassigned = !i.fields?.assignee;
      const assigneeName = i.fields?.assignee?.displayName || null;

      // SLA remaining hours (best-effort)
      const firstResponseRemainingHours = extractFirstResponseSlaRemainingHours(i.fields);

      // Base risk
      let risk = 'NORMAL';

      if (isBlocked) {
        // Demo override is always strongest
        if (isDemoHigh) {
          risk = 'HIGH';
        } else if (staleHours !== null && staleHours >= STALE_HIGH_HOURS) {
          risk = 'HIGH';
        } else if (staleHours !== null && staleHours >= STALE_MEDIUM_HOURS) {
          risk = 'MEDIUM';
        } else {
          risk = 'MEDIUM';
        }

        // Owner escalation (Option B part 1)
        if (isUnassigned && risk === 'MEDIUM') {
          risk = 'HIGH';
        }

        // SLA escalation (Option B part 2)
        // If SLA is breached (0h) or very close (<2h), force HIGH
        // If close (<8h), ensure at least MEDIUM
        if (firstResponseRemainingHours !== null) {
          if (firstResponseRemainingHours <= SLA_HIGH_HOURS) {
            risk = 'HIGH';
          } else if (firstResponseRemainingHours <= SLA_MEDIUM_HOURS && risk === 'NORMAL') {
            risk = 'MEDIUM';
          }
        }
      }

      return {
        key: i.key,
        summary,
        status,
        updated,
        staleHours,
        assigneeName,
        firstResponseRemainingHours,
        risk,
      };
    })
    .sort((a, b) => {
      const rank = { HIGH: 0, MEDIUM: 1, NORMAL: 2 };
      const ra = rank[a.risk] ?? 9;
      const rb = rank[b.risk] ?? 9;
      if (ra !== rb) return ra - rb;

      // Tie-breaker: older updated first (more urgent)
      const ta = a.updated ? new Date(a.updated).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.updated ? new Date(b.updated).getTime() : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

  return { issues, projectKey };
});

export const handler = resolver.getDefinitions();