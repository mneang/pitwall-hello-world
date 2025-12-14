import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

const resolver = new Resolver();

// ===== Config (tune later) =====
const BLOCKED_STATUS_NAME = 'Waiting for support';
const STALE_MEDIUM_HOURS = 24;
const STALE_HIGH_HOURS = 72;

// SLA thresholds (Option B)
const SLA_HIGH_HOURS = 2;   // <= 2h remaining => HIGH
const SLA_MEDIUM_HOURS = 8; // <= 8h remaining => at least MEDIUM

const ESCALATION_LABEL = 'pitwall-escalated';

// ===== Helpers =====
function hoursSince(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, ms / (1000 * 60 * 60));
}

// Jira Cloud v3 comment body wants ADF. This avoids 400 “Comment body is not valid”.
function toAdfDoc(text) {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: String(text ?? '') }],
      },
    ],
  };
}

async function addComment(issueKey, text) {
  const res = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}/comment`,
    {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: toAdfDoc(text) }),
    }
  );

  if (!res.ok) {
    const raw = await res.text();
    return { ok: false, error: `Comment failed: ${res.status} ${raw}` };
  }
  return { ok: true };
}

// Parse friendly SLA remaining time: "1d 2h", "2h 30m", "45m", "Breached"
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

// Best-effort extraction of “Time to first response” remaining hours from fields.sla
function extractFirstResponseSlaRemainingHours(fields) {
  const sla = fields?.sla;
  if (!sla) return null;

  const candidates = [];
  if (Array.isArray(sla)) {
    candidates.push(...sla);
  } else if (typeof sla === 'object') {
    for (const k of Object.keys(sla)) candidates.push(sla[k]);
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
      null;

    const hours = parseSlaRemainingToHours(remainingText);
    if (hours !== null) return hours;

    if (entry?.ongoingCycle?.breached === true || entry?.breached === true) return 0;
  }

  return null;
}

// Compute risk + reasons from fields (single source of truth)
function computeRiskAndReasons({ issueKey, summary, fields }) {
  const status = fields?.status?.name || 'Unknown';
  const updated = fields?.updated || null;
  const staleHours = updated ? hoursSince(updated) : null;
  const isUnassigned = !fields?.assignee;
  const assigneeName = fields?.assignee?.displayName || null;

  const firstResponseRemainingHours = extractFirstResponseSlaRemainingHours(fields);

  const isDemoHigh = (summary || '').includes('[DEMO-HIGH]');
  const isBlocked = status === BLOCKED_STATUS_NAME;

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
    else if (firstResponseRemainingHours <= SLA_MEDIUM_HOURS) reasons.push(`SLA ≤ ${SLA_MEDIUM_HOURS}h`);
  }

  // Risk model (Option B)
  let risk = 'NORMAL';

  if (isBlocked) {
    // baseline
    risk = 'MEDIUM';

    // demo override strongest
    if (isDemoHigh) risk = 'HIGH';

    // stale escalation
    if (staleHours !== null && staleHours >= STALE_HIGH_HOURS) risk = 'HIGH';
    else if (staleHours !== null && staleHours >= STALE_MEDIUM_HOURS && risk === 'NORMAL') risk = 'MEDIUM';

    // owner escalation (unassigned + blocked => HIGH)
    if (isUnassigned) risk = 'HIGH';

    // SLA escalation
    if (firstResponseRemainingHours !== null) {
      if (firstResponseRemainingHours <= SLA_HIGH_HOURS) risk = 'HIGH';
      else if (firstResponseRemainingHours <= SLA_MEDIUM_HOURS && risk === 'NORMAL') risk = 'MEDIUM';
    }
  }

  return {
    key: issueKey,
    summary: summary || '',
    status,
    updated,
    staleHours,
    assigneeName,
    firstResponseRemainingHours,
    risk,
    reasons,
  };
}

async function fetchIssue(issueKey) {
  // Pull the same fields we use for scoring + actions
  const res = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}?fields=summary,status,updated,assignee,sla,labels`
  );
  if (!res.ok) {
    const raw = await res.text();
    return { ok: false, error: `Fetch issue failed: ${res.status} ${raw}` };
  }
  const data = await res.json();
  return { ok: true, data };
}

// ===== Core list =====
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
    .map((i) => computeRiskAndReasons({ issueKey: i.key, summary: i.fields?.summary, fields: i.fields }))
    .sort((a, b) => {
      const rank = { HIGH: 0, MEDIUM: 1, NORMAL: 2 };
      const ra = rank[a.risk] ?? 9;
      const rb = rank[b.risk] ?? 9;
      if (ra !== rb) return ra - rb;

      // Tie-breaker: older updated first
      const ta = a.updated ? new Date(a.updated).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.updated ? new Date(b.updated).getTime() : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

  return { issues, projectKey };
});

// ===== B2 Actions =====

// B2.1 Assign to me (assignee)
resolver.define('assignToMe', async ({ payload, context }) => {
  const issueKey = payload?.issueKey;
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };

  const accountId = context?.accountId;
  if (!accountId) return { ok: false, error: 'No accountId in context (cannot assign)' };

  const res = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}/assignee`, {
    method: 'PUT',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId }),
  });

  if (!res.ok) {
    const raw = await res.text();
    return { ok: false, error: `Assign failed: ${res.status} ${raw}` };
  }

  return { ok: true };
});

// B2.2 Request update (simple comment)
resolver.define('requestUpdate', async ({ payload }) => {
  const issueKey = payload?.issueKey;
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };

  const { ok, error } = await fetchIssue(issueKey);
  // even if fetch fails, we can still post a generic request
  const message = ok
    ? `Pit stop check: please post a quick update.\n\n• What's blocking?\n• ETA for next step?\n• Do you need help?`
    : `Pit stop check: please post a quick update.\n\n• What's blocking?\n• ETA for next step?\n• Do you need help?`;

  return addComment(issueKey, message);
});

// B2.3 Post playbook note (structured internal note)
resolver.define('postPlaybookNote', async ({ payload }) => {
  const issueKey = payload?.issueKey;
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };

  const fetched = await fetchIssue(issueKey);
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const summary = fetched.data?.fields?.summary || '';
  const computed = computeRiskAndReasons({ issueKey, summary, fields: fetched.data?.fields });

  const reasonsLine = computed.reasons?.length ? computed.reasons.join(' • ') : 'No reasons computed';

  // Pit Wall style note: short, actionable, repeatable (judges love this)
  const note =
`[Pit Wall] Playbook note
Issue: ${issueKey} — ${summary}
Risk: ${computed.risk}
Reasons: ${reasonsLine}

Next actions:
1) Confirm owner
2) Confirm block + workaround
3) Confirm next update time

Status now: ${computed.status}
SLA(1st response): ${computed.firstResponseRemainingHours !== null ? `${computed.firstResponseRemainingHours}h remaining` : 'N/A'}
`;

  return addComment(issueKey, note);
});

// B2.4 Generate customer update (draft returned to UI)
resolver.define('generateCustomerUpdate', async ({ payload }) => {
  const issueKey = payload?.issueKey;
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };

  const fetched = await fetchIssue(issueKey);
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const summary = fetched.data?.fields?.summary || '';
  const computed = computeRiskAndReasons({ issueKey, summary, fields: fetched.data?.fields });

  const nextUpdateText =
    computed.firstResponseRemainingHours !== null && computed.firstResponseRemainingHours <= SLA_HIGH_HOURS
      ? 'within the next couple of hours'
      : 'within the next business day (or sooner if we make progress)';

  const doingNow =
    computed.reasons.includes('Unassigned')
      ? 'We are assigning an owner and beginning investigation immediately.'
      : computed.reasons.some((r) => r.startsWith('Stale'))
        ? 'We are unblocking the request and confirming next steps.'
        : 'We are investigating and working toward the next action.';

  const draft =
`Update on "${summary}" (${issueKey})
Current status: ${computed.status}

What we're doing now: ${doingNow}
Next update: ${nextUpdateText}

Thanks for your patience — we’ll keep you posted.`;

  return { ok: true, draft };
});

// B2.5 Escalate (label + escalation comment)
resolver.define('escalate', async ({ payload }) => {
  const issueKey = payload?.issueKey;
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };

  const fetched = await fetchIssue(issueKey);
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const summary = fetched.data?.fields?.summary || '';
  const computed = computeRiskAndReasons({ issueKey, summary, fields: fetched.data?.fields });
  const reasonsLine = computed.reasons?.length ? computed.reasons.join(' • ') : 'No reasons computed';

  // Add a label (non-destructive escalation signal)
  const updateRes = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      update: {
        labels: [{ add: ESCALATION_LABEL }],
      },
    }),
  });

  if (!updateRes.ok) {
    const raw = await updateRes.text();
    return { ok: false, error: `Escalate label failed: ${updateRes.status} ${raw}` };
  }

  // Post escalation note
  const msg =
`[Pit Wall] Escalation triggered
Issue: ${issueKey} — ${summary}
Risk: ${computed.risk}
Reasons: ${reasonsLine}

Action: Added label "${ESCALATION_LABEL}" and flagged for immediate attention.`;

  return addComment(issueKey, msg);
});

export const handler = resolver.getDefinitions();