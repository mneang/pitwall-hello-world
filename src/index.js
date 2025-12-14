import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

const resolver = new Resolver();

// === Risk tuning (hours) ===
// MEDIUM = blocked + stale >= 24h
// HIGH   = blocked + stale >= 72h
// You can tune these later for demo/realism.
const STALE_MEDIUM_HOURS = 24;
const STALE_HIGH_HOURS = 72;

// The status that represents "blocked / danger" in your project
const BLOCKED_STATUS_NAME = 'Waiting for support';

function hoursSince(isoDateString) {
  const t = Date.parse(isoDateString);
  if (Number.isNaN(t)) return null;
  const diffMs = Date.now() - t;
  return diffMs / (1000 * 60 * 60);
}

resolver.define('getAtRiskIssues', async ({ context }) => {
  const projectKey = context?.extension?.project?.key;

  if (!projectKey) {
    return { issues: [], error: 'No project key found in context.' };
  }

  // Oldest updated first helps us understand "stale"
  const jql = `project = ${projectKey} AND statusCategory != Done ORDER BY updated ASC`;

  const res = await api.asUser().requestJira(
    route`/rest/api/3/search/jql?jql=${jql}&maxResults=10&fields=summary,status,updated`
  );

  if (!res.ok) {
    const text = await res.text();
    return { issues: [], error: `Jira API failed: ${res.status} ${text}` };
  }

  const data = await res.json();

  const issues = (data.issues || [])
    .map((i) => {
      const status = i.fields?.status?.name;
      const updated = i.fields?.updated;

      const isBlocked = status === BLOCKED_STATUS_NAME;
      const staleHours = updated ? hoursSince(updated) : null;

      let risk = 'NORMAL';
      if (isBlocked) {
        if (staleHours !== null && staleHours >= STALE_HIGH_HOURS) risk = 'HIGH';
        else if (staleHours !== null && staleHours >= STALE_MEDIUM_HOURS) risk = 'MEDIUM';
        else risk = 'MEDIUM'; // blocked even if fresh = still needs attention
      }

      return {
        key: i.key,
        summary: i.fields?.summary,
        status,
        updated,
        staleHours,
        risk,
      };
    })
    .sort((a, b) => {
      const rank = (r) => (r === 'HIGH' ? 0 : r === 'MEDIUM' ? 1 : 2);
      const ra = rank(a.risk);
      const rb = rank(b.risk);
      if (ra !== rb) return ra - rb;

      // Within same risk, older updated first
      const ta = Date.parse(a.updated || '') || 0;
      const tb = Date.parse(b.updated || '') || 0;
      return ta - tb;
    });

  return { issues, projectKey };
});

// PIT STOP ACTION: add a templated comment to the issue (mentions assignee if present)
resolver.define('requestUpdate', async ({ payload }) => {
  const { issueKey } = payload || {};
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };

  const issueRes = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}?fields=assignee,summary`
  );

  if (!issueRes.ok) {
    const text = await issueRes.text();
    return { ok: false, error: `Fetch issue failed: ${issueRes.status} ${text}` };
  }

  const issue = await issueRes.json();
  const assigneeId = issue?.fields?.assignee?.accountId;
  const summary = issue?.fields?.summary || '';

  const mention = assigneeId ? `[~accountid:${assigneeId}]` : '';
  const bodyText =
    `${mention} Pit stop check: please post a quick update.\n\n` +
    `Context: ${issueKey} — ${summary}\n\n` +
    `• What’s blocking?\n` +
    `• ETA for next step?\n` +
    `• Do you need help?`;

  const commentRes = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}/comment`,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: bodyText }],
            },
          ],
        },
      }),
    }
  );

  if (!commentRes.ok) {
    const text = await commentRes.text();
    return { ok: false, error: `Comment failed: ${commentRes.status} ${text}` };
  }

  return { ok: true };
});

export const handler = resolver.getDefinitions();