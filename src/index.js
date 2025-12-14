import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

const resolver = new Resolver();

// Config (tune later if needed)
const BLOCKED_STATUS_NAME = 'Waiting for support';
const STALE_MEDIUM_HOURS = 24;
const STALE_HIGH_HOURS = 72;

// SLA thresholds (Option B)
const SLA_HIGH_HOURS = 2;   // <= 2h remaining => HIGH
const SLA_MEDIUM_HOURS = 8; // <= 8h remaining => at least MEDIUM

function hoursSince(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, ms / (1000 * 60 * 60));
}

// Parse Jira Service Management SLA remaining time (best-effort)
function parseSlaRemainingToHours(text) {
  if (!text) return null;

  const t = String(text).toLowerCase().trim();
  if (t.includes('breach') || t.includes('breached') || t.includes('overdue')) return 0;

  const dayMatch = t.match(/(\d+)\s*d/);
  const hourMatch = t.match(/(\d+)\s*h/);
  const minMatch = t.match(/(\d+)\s*m/);

  const days = dayMatch ? parseInt(dayMatch[1], 10) : 0;
  const hours = hourMatch ? parseInt(hourMatch[1], 10) : 0;
  const mins = minMatch ? parseInt(minMatch[1], 10) : 0;

  if (!dayMatch && !hourMatch && !minMatch) return null;

  return days * 24 + hours + mins / 60;
}

function extractFirstResponseSlaRemainingHours(fields) {
  const sla = fields?.sla;
  if (!sla) return null;

  const candidates = [];
  if (Array.isArray(sla)) {
    candidates.push(...sla);
  } else if (typeof sla === 'object') {
    for (const key of Object.keys(sla)) candidates.push(sla[key]);
  }

  for (const entry of candidates) {
    const name = entry?.name || entry?.goalName || entry?.metricName || '';
    const n = String(name).toLowerCase();
    if (!n.includes('first response')) continue;

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

    if (entry?.ongoingCycle?.breached === true || entry?.breached === true) return 0;
  }

  return null;
}

resolver.define('getAtRiskIssues', async ({ context }) => {
  const projectKey = context?.extension?.project?.key;

  if (!projectKey) {
    return { issues: [], error: 'No project key found in context.' };
  }

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

      const firstResponseRemainingHours = extractFirstResponseSlaRemainingHours(i.fields);

      let risk = 'NORMAL';

      if (isBlocked) {
        if (isDemoHigh) {
          risk = 'HIGH';
        } else if (staleHours !== null && staleHours >= STALE_HIGH_HOURS) {
          risk = 'HIGH';
        } else if (staleHours !== null && staleHours >= STALE_MEDIUM_HOURS) {
          risk = 'MEDIUM';
        } else {
          risk = 'MEDIUM';
        }

        if (isUnassigned && risk === 'MEDIUM') {
          risk = 'HIGH';
        }

        if (firstResponseRemainingHours !== null) {
          if (firstResponseRemainingHours <= SLA_HIGH_HOURS) {
            risk = 'HIGH';
          } else if (firstResponseRemainingHours <= SLA_MEDIUM_HOURS && risk === 'NORMAL') {
            risk = 'MEDIUM';
          }
        }
      }

      const reasons = [];
      if (status === BLOCKED_STATUS_NAME) reasons.push('Waiting for support');
      if (isUnassigned) reasons.push('Unassigned');
      if (isDemoHigh) reasons.push('Demo override');

      if (staleHours !== null) {
        if (staleHours >= STALE_HIGH_HOURS) reasons.push(`Stale ${STALE_HIGH_HOURS}h+`);
        else if (staleHours >= STALE_MEDIUM_HOURS) reasons.push(`Stale ${STALE_MEDIUM_HOURS}h+`);
      }

      if (firstResponseRemainingHours !== null) {
        if (firstResponseRemainingHours <= SLA_HIGH_HOURS) reasons.push(`SLA ≤ ${SLA_HIGH_HOURS}h`);
        else if (firstResponseRemainingHours <= SLA_MEDIUM_HOURS) reasons.push(`SLA ≤ ${SLA_MEDIUM_HOURS}h`);
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
        reasons,
      };
    })
    .sort((a, b) => {
      const rank = { HIGH: 0, MEDIUM: 1, NORMAL: 2 };
      const ra = rank[a.risk] ?? 9;
      const rb = rank[b.risk] ?? 9;
      if (ra !== rb) return ra - rb;

      const ta = a.updated ? new Date(a.updated).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.updated ? new Date(b.updated).getTime() : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

  return { issues, projectKey };
});

// ✅ Option B1: Assign to me (pit-crew action)
resolver.define('assignToMe', async ({ payload, context }) => {
  const issueKey = payload?.issueKey;
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };

  // Forge gives us the current user's Atlassian accountId in context
  const accountId = context?.accountId;
  if (!accountId) return { ok: false, error: 'No accountId found in context' };

  // Update assignee via Jira REST API v3
  const res = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}/assignee`,
    {
      method: 'PUT',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `Assign failed: ${res.status} ${text}` };
  }

  return { ok: true };
});

export const handler = resolver.getDefinitions();