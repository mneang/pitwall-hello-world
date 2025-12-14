import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

const resolver = new Resolver();

// Config (tune later)
const BLOCKED_STATUS_NAME = 'Waiting for support';
const STALE_MEDIUM_HOURS = 24;
const STALE_HIGH_HOURS = 72;

// SLA thresholds (Option B2)
const SLA_HIGH_HOURS = 2;   // <= 2h remaining => HIGH
const SLA_MEDIUM_HOURS = 8; // <= 8h remaining => MEDIUM

function hoursSince(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, ms / (1000 * 60 * 60));
}

/**
 * Fetch “Time to first response” remaining hours from JSM SLA API.
 * Endpoint: GET /rest/servicedeskapi/request/{issueIdOrKey}/sla
 * (Best-effort: if 403/404/etc, return null and we simply don't apply SLA escalation.)
 */
async function fetchFirstResponseSlaRemainingHours(issueKey) {
  try {
    const res = await api.asUser().requestJira(
      route`/rest/servicedeskapi/request/${issueKey}/sla`
    );

    if (!res.ok) {
      // 403 can happen if not an agent / app access rules; 404 if not a request
      return null;
    }

    const data = await res.json();

    // Data is paged; SLA entries are typically in data.values
    const values = Array.isArray(data?.values) ? data.values : [];
    if (!values.length) return null;

    // Find SLA whose name matches “Time to first response”
    const first = values.find((v) => {
      const name = (v?.name || '').toLowerCase();
      return name.includes('time to first response') || name.includes('first response');
    });

    if (!first) return null;

    // If breached => treat as 0h remaining
    if (first?.ongoingCycle?.breached === true) return 0;

    const remaining = first?.ongoingCycle?.remainingTime;

    // Preferred: millis
    const millis = remaining?.millis;
    if (typeof millis === 'number') {
      return Math.max(0, millis / (1000 * 60 * 60));
    }

    // Fallback: try “friendly” like "2h 30m" (rare, but we can parse)
    const friendly = remaining?.friendly;
    if (friendly) {
      return parseFriendlyDurationToHours(friendly);
    }

    return null;
  } catch (e) {
    return null;
  }
}

// Very small “friendly” parser: "1d 2h", "2h 30m", "45m"
function parseFriendlyDurationToHours(text) {
  const t = String(text).toLowerCase().trim();
  const dayMatch = t.match(/(\d+)\s*d/);
  const hourMatch = t.match(/(\d+)\s*h/);
  const minMatch = t.match(/(\d+)\s*m/);

  const days = dayMatch ? parseInt(dayMatch[1], 10) : 0;
  const hours = hourMatch ? parseInt(hourMatch[1], 10) : 0;
  const mins = minMatch ? parseInt(minMatch[1], 10) : 0;

  if (!dayMatch && !hourMatch && !minMatch) return null;
  return days * 24 + hours + mins / 60;
}

resolver.define('getAtRiskIssues', async ({ context }) => {
  const projectKey = context?.extension?.project?.key;

  if (!projectKey) {
    return { issues: [], error: 'No project key found in context.' };
  }

  const jql = `project = ${projectKey} AND statusCategory != Done ORDER BY updated ASC`;

  // Pull core fields from Jira search
  const res = await api.asUser().requestJira(
    route`/rest/api/3/search/jql?jql=${jql}&maxResults=10&fields=summary,status,updated,assignee`
  );

  if (!res.ok) {
    const text = await res.text();
    return { issues: [], error: `Jira API failed: ${res.status} ${text}` };
  }

  const data = await res.json();
  const rawIssues = data.issues || [];

  // Fetch SLA in parallel (top 10 only = safe for demo pace)
  const slaByKey = {};
  await Promise.all(
    rawIssues.map(async (i) => {
      const key = i?.key;
      if (!key) return;
      const slaHours = await fetchFirstResponseSlaRemainingHours(key);
      slaByKey[key] = slaHours; // may be null
    })
  );

  const issues = rawIssues
    .map((i) => {
      const key = i.key;
      const status = i.fields?.status?.name || 'Unknown';
      const updated = i.fields?.updated || null;
      const staleHours = updated ? hoursSince(updated) : null;

      const summary = i.fields?.summary || '';
      const isDemoHigh = summary.includes('[DEMO-HIGH]');
      const isBlocked = status === BLOCKED_STATUS_NAME;

      const assigneeName = i.fields?.assignee?.displayName || null;
      const isUnassigned = !assigneeName;

      const firstResponseRemainingHours =
        Object.prototype.hasOwnProperty.call(slaByKey, key) ? slaByKey[key] : null;

      // ----- Reasons (explainability) -----
      const reasons = [];

      if (isDemoHigh) reasons.push('Demo override');
      if (isBlocked) reasons.push('Waiting for support');
      if (isUnassigned) reasons.push('Unassigned');

      if (staleHours !== null) {
        if (staleHours >= STALE_HIGH_HOURS) reasons.push(`Stale ${STALE_HIGH_HOURS}h+`);
        else if (staleHours >= STALE_MEDIUM_HOURS) reasons.push(`Stale ${STALE_MEDIUM_HOURS}h+`);
      }

      if (firstResponseRemainingHours !== null) {
        if (firstResponseRemainingHours <= SLA_HIGH_HOURS) reasons.push(`SLA ≤ ${SLA_HIGH_HOURS}h`);
        else if (firstResponseRemainingHours <= SLA_MEDIUM_HOURS)
          reasons.push(`SLA ≤ ${SLA_MEDIUM_HOURS}h`);
      }

      // ----- Risk calculation -----
      let risk = 'NORMAL';

      if (isBlocked) {
        // Base: blocked means at least MEDIUM
        risk = 'MEDIUM';

        // Stale escalation
        if (staleHours !== null && staleHours >= STALE_HIGH_HOURS) risk = 'HIGH';
        else if (staleHours !== null && staleHours >= STALE_MEDIUM_HOURS) risk = 'MEDIUM';

        // Owner escalation (unassigned is dangerous in ops)
        if (isUnassigned) risk = 'HIGH';

        // SLA escalation (overrides)
        if (firstResponseRemainingHours !== null) {
          if (firstResponseRemainingHours <= SLA_HIGH_HOURS) risk = 'HIGH';
          else if (firstResponseRemainingHours <= SLA_MEDIUM_HOURS && risk === 'NORMAL')
            risk = 'MEDIUM';
        }

        // Demo override is always strongest
        if (isDemoHigh) risk = 'HIGH';
      } else {
        // Non-blocked: keep NORMAL for now (we can expand later)
        if (isDemoHigh) risk = 'HIGH';
      }

      return {
        key,
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

      // Tie-breaker: older updated first (more urgent)
      const ta = a.updated ? new Date(a.updated).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.updated ? new Date(b.updated).getTime() : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

  return { issues, projectKey };
});

resolver.define('requestUpdate', async ({ payload, context }) => {
  const issueKey = payload?.issueKey;
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };

  const projectKey = context?.extension?.project?.key || 'UNKNOWN';

  const body = {
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Pit stop check: please post a quick update.' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: `Context: ${issueKey} in project ${projectKey}` },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: "What's blocking?" }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ETA for next step?' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Do you need help?' }] }],
            },
          ],
        },
      ],
    },
  };

  const res = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}/comment`,
    {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `${res.status} ${text}` };
  }

  return { ok: true };
});

resolver.define('assignToMe', async ({ payload, context }) => {
  const issueKey = payload?.issueKey;
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };

  const accountId = context?.accountId;
  if (!accountId) return { ok: false, error: 'No accountId in context' };

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
    return { ok: false, error: `${res.status} ${text}` };
  }

  return { ok: true };
});

export const handler = resolver.getDefinitions();