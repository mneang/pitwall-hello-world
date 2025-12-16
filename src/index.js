import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

const resolver = new Resolver();

/**
 * =========================
 * Config (tune later)
 * =========================
 */
const BLOCKED_STATUS_NAME = 'Waiting for support';

const STALE_MEDIUM_HOURS = 24;
const STALE_HIGH_HOURS = 72;

// SLA thresholds (remaining time)
const SLA_HIGH_HOURS = 2; // <= 2h remaining => HIGH
const SLA_MEDIUM_HOURS = 8; // <= 8h remaining => at least MEDIUM

// Smart-playbook spam protection (skip if we already posted recently)
const SKIP_REQUEST_UPDATE_WITHIN_HOURS = 6;
const SKIP_PLAYBOOK_NOTE_WITHIN_HOURS = 12;

// Labels / markers (these are your “audit trail”)
const PITWALL_MARK = '[PITWALL]';
const LABEL_ESCALATED = 'pitwall-escalated';

const MARK_REQUEST_UPDATE = `${PITWALL_MARK} Request update`;
const MARK_PLAYBOOK_NOTE = `${PITWALL_MARK} Playbook note`;
const MARK_ESCALATION = `${PITWALL_MARK} Escalation`;

/**
 * =========================
 * Helpers
 * =========================
 */
function hoursSince(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, ms / (1000 * 60 * 60));
}

function hoursSinceDate(dateIsoOrCreated) {
  const ms = Date.now() - new Date(dateIsoOrCreated).getTime();
  return Math.max(0, ms / (1000 * 60 * 60));
}

// ADF builder for Jira Cloud comment body
function adfDocFromLines(lines) {
  const safeLines = Array.isArray(lines) ? lines : [String(lines ?? '')];
  return {
    type: 'doc',
    version: 1,
    content: safeLines.map((line) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: String(line) }],
    })),
  };
}

// Extract plain-ish text from ADF (best-effort) for marker detection
function adfToText(adf) {
  try {
    const paragraphs = adf?.content || [];
    const texts = [];
    for (const p of paragraphs) {
      const bits = p?.content || [];
      for (const b of bits) {
        if (typeof b?.text === 'string') texts.push(b.text);
      }
      texts.push('\n');
    }
    return texts.join('').trim();
  } catch {
    return '';
  }
}

// Parse Jira Service Management SLA remaining time (best-effort)
// Handles patterns like: "2h 30m", "45m", "1d 3h", and "Breached"
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
    if (!String(name).toLowerCase().includes('first response')) continue;

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

function rankRisk(risk) {
  if (risk === 'HIGH') return 0;
  if (risk === 'MEDIUM') return 1;
  return 2;
}

/**
 * Defensive wrapper for Jira API
 * IMPORTANT: Jira sometimes returns 204 No Content for writes (e.g., assignee PUT).
 * If we always call res.json() we can get "Unexpected end of JSON input".
 */
async function jiraRequest(path, options = {}) {
  const res = await api.asUser().requestJira(path, options);

  const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Jira API failed: ${res.status} ${text}`);
  }

  // 204 / empty body => return null
  if (!text) return null;

  // If JSON, parse; else return text
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      // If Jira returns non-JSON but content-type lies, still don't crash the app
      return text;
    }
  }

  return text;
}

async function getIssue(issueKey) {
  return jiraRequest(route`/rest/api/3/issue/${issueKey}?fields=summary,status,updated,assignee,labels,sla`);
}

async function getComments(issueKey) {
  return jiraRequest(route`/rest/api/3/issue/${issueKey}/comment?maxResults=50&orderBy=-created`);
}

function hasRecentMarkedComment(comments, marker, withinHours) {
  const list = comments?.comments || [];
  for (const c of list) {
    const text = adfToText(c?.body);
    if (!text.includes(marker)) continue;

    const ageHours = hoursSinceDate(c?.created);
    if (ageHours <= withinHours) return true;
  }
  return false;
}

// NEW: find most recent marker age (hours) for cooldown UX
function lastMarkedCommentAgeHours(comments, marker) {
  const list = comments?.comments || [];
  let best = null;
  for (const c of list) {
    const text = adfToText(c?.body);
    if (!text.includes(marker)) continue;

    const age = hoursSinceDate(c?.created);
    if (best === null || age < best) best = age;
  }
  return best; // null means never posted
}

function computeCooldown(markerAgeHours, windowHours) {
  if (markerAgeHours === null) {
    return { posted: false, ageHours: null, windowHours, remainingHours: 0 };
  }
  const remaining = Math.max(0, windowHours - markerAgeHours);
  return { posted: true, ageHours: markerAgeHours, windowHours, remainingHours: remaining };
}

async function addComment(issueKey, lines) {
  const body = adfDocFromLines(lines);
  return jiraRequest(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

async function assignToMe(issueKey, accountId) {
  await jiraRequest(route`/rest/api/3/issue/${issueKey}/assignee`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId }),
  });
  return { ok: true };
}

async function escalateByLabel(issueKey) {
  const issue = await getIssue(issueKey);
  const labels = issue?.fields?.labels || [];
  if (labels.includes(LABEL_ESCALATED)) return { ok: true, skipped: true };

  const next = Array.from(new Set([...labels, LABEL_ESCALATED]));
  await jiraRequest(route`/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { labels: next } }),
  });

  await addComment(issueKey, [`${MARK_ESCALATION}`, `Escalation applied: label "${LABEL_ESCALATED}"`]);

  return { ok: true };
}

function buildCustomerDraft(issueKey, summary, statusName) {
  return `Update on "${summary}" (${issueKey})
Current status: ${statusName}
What we're doing now: We are assigning an owner and beginning investigation immediately.
Next update: within the next business day (or sooner if we make progress)
Thanks for your patience — we'll keep you posted.`;
}

/**
 * =========================
 * Risk model (used by list + playbook decisions)
 * =========================
 */
function computeRiskAndReasons(fields) {
  const status = fields?.status?.name || 'Unknown';
  const updated = fields?.updated;
  const staleHours = updated ? hoursSince(updated) : null;

  const summary = fields?.summary || '';
  const isDemoHigh = summary.includes('[DEMO-HIGH]');
  const isBlocked = status === BLOCKED_STATUS_NAME;

  const isUnassigned = !fields?.assignee;
  const assigneeName = fields?.assignee?.displayName || null;

  const firstResponseRemainingHours = extractFirstResponseSlaRemainingHours(fields);

  // Reasons (explainability)
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

  // Base risk
  let risk = 'NORMAL';

  if (isBlocked) {
    if (isDemoHigh) risk = 'HIGH';
    else if (staleHours !== null && staleHours >= STALE_HIGH_HOURS) risk = 'HIGH';
    else if (staleHours !== null && staleHours >= STALE_MEDIUM_HOURS) risk = 'MEDIUM';
    else risk = 'MEDIUM';

    // Owner escalation: unassigned + blocked => bump to HIGH
    if (isUnassigned && risk === 'MEDIUM') risk = 'HIGH';

    // SLA escalation
    if (firstResponseRemainingHours !== null) {
      if (firstResponseRemainingHours <= SLA_HIGH_HOURS) risk = 'HIGH';
      else if (firstResponseRemainingHours <= SLA_MEDIUM_HOURS && risk === 'NORMAL') risk = 'MEDIUM';
    }
  }

  // Recommended next actions (ordered)
  const recommended = [];
  if (isUnassigned) recommended.push('Assign to me');

  if (isBlocked) {
    recommended.push('Request update');
    recommended.push('Post playbook note');
    recommended.push('Generate customer update');
  }

  if (firstResponseRemainingHours !== null && firstResponseRemainingHours <= SLA_HIGH_HOURS) {
    recommended.push('Escalate');
  }

  if (!isBlocked && isDemoHigh && !recommended.length) {
    recommended.push('Generate customer update');
  }

  let pitWallCall = '';
  if (risk === 'HIGH' && isBlocked) pitWallCall = 'Post playbook note — Blocked — document the plan and next steps.';
  else if (risk === 'HIGH') pitWallCall = 'Run recommended — HIGH risk — take action now.';
  else if (risk === 'MEDIUM' && isBlocked) pitWallCall = 'Request update — check blockers and ETA.';
  else if (risk === 'MEDIUM') pitWallCall = 'Quick check — run recommended when ready.';

  const nextAction = recommended.length ? recommended[0] : null;

  return {
    status,
    updated,
    staleHours,
    assigneeName,
    firstResponseRemainingHours,
    risk,
    reasons,
    recommended,
    pitWallCall,
    nextAction,
  };
}

/**
 * =========================
 * Resolver: list (scoreboard included)
 * =========================
 */
resolver.define('getAtRiskIssues', async ({ context }) => {
  const projectKey = context?.extension?.project?.key;
  if (!projectKey) return { issues: [], error: 'No project key found in context.' };

  const jql = `project = ${projectKey} AND statusCategory != Done ORDER BY updated ASC`;

  const data = await jiraRequest(
    route`/rest/api/3/search/jql?jql=${jql}&maxResults=10&fields=summary,status,updated,assignee,labels,sla`
  );

  const rawIssues = data?.issues || [];

  const issues = rawIssues
    .map((i) => {
      const fields = i.fields || {};
      const computed = computeRiskAndReasons(fields);

      return {
        key: i.key,
        summary: fields.summary || '',
        status: computed.status,
        updated: computed.updated,
        staleHours: computed.staleHours,
        assigneeName: computed.assigneeName,
        firstResponseRemainingHours: computed.firstResponseRemainingHours,
        risk: computed.risk,
        reasons: computed.reasons,
        recommended: computed.recommended,
        pitWallCall: computed.pitWallCall,
        nextAction: computed.nextAction,
      };
    })
    .sort((a, b) => {
      const ra = rankRisk(a.risk);
      const rb = rankRisk(b.risk);
      if (ra !== rb) return ra - rb;

      const ta = a.updated ? new Date(a.updated).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.updated ? new Date(b.updated).getTime() : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

  const stats = {
    high: issues.filter((x) => x.risk === 'HIGH').length,
    medium: issues.filter((x) => x.risk === 'MEDIUM').length,
    normal: issues.filter((x) => x.risk === 'NORMAL').length,
    unassignedHigh: issues.filter((x) => x.risk === 'HIGH' && !x.assigneeName).length,
    slaHot: issues.filter((x) => x.firstResponseRemainingHours !== null && x.firstResponseRemainingHours <= SLA_HIGH_HOURS)
      .length,
  };

  return { issues, projectKey, stats };
});

/**
 * =========================
 * NEW: per-issue cooldown meta for UX (on-demand)
 * =========================
 */
resolver.define('getIssueCooldowns', async ({ payload }) => {
  const issueKey = payload?.issueKey;
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };

  const comments = await getComments(issueKey);

  const reqAge = lastMarkedCommentAgeHours(comments, MARK_REQUEST_UPDATE);
  const noteAge = lastMarkedCommentAgeHours(comments, MARK_PLAYBOOK_NOTE);

  return {
    ok: true,
    issueKey,
    cooldowns: {
      requestUpdate: computeCooldown(reqAge, SKIP_REQUEST_UPDATE_WITHIN_HOURS),
      playbookNote: computeCooldown(noteAge, SKIP_PLAYBOOK_NOTE_WITHIN_HOURS),
    },
  };
});

/**
 * =========================
 * Individual actions (keep stable)
 * =========================
 */
resolver.define('requestUpdate', async ({ payload }) => {
  const issueKey = payload?.issueKey;
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };

  await addComment(issueKey, [
    `${MARK_REQUEST_UPDATE}`,
    'Pit stop check: please post a quick update.',
    '',
    '• What’s blocking?',
    '• ETA for next step?',
    '• Do you need help?',
  ]);

  return { ok: true };
});

resolver.define('postPlaybookNote', async ({ payload }) => {
  const issueKey = payload?.issueKey;
  const reasons = payload?.reasons || [];
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };

  const reasonLine = reasons.length ? `Reasons: ${reasons.join(' • ')}` : 'Reasons: (not provided)';
  await addComment(issueKey, [
    `${MARK_PLAYBOOK_NOTE}`,
    reasonLine,
    '',
    'Plan:',
    '1) Assign an owner',
    '2) Get an update from the blocker',
    '3) Prepare customer-facing comms',
    '4) Escalate if SLA is hot / risk remains HIGH',
  ]);

  return { ok: true };
});

resolver.define('assignToMe', async ({ payload, context }) => {
  const issueKey = payload?.issueKey;
  const accountId = context?.accountId;
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };
  if (!accountId) return { ok: false, error: 'No accountId in context' };

  await assignToMe(issueKey, accountId);
  return { ok: true };
});

resolver.define('escalate', async ({ payload }) => {
  const issueKey = payload?.issueKey;
  if (!issueKey) return { ok: false, error: 'Missing issueKey' };

  const res = await escalateByLabel(issueKey);
  return { ok: true, skipped: !!res?.skipped };
});

/**
 * =========================
 * Smart macro: runPlaybook (B2) - unchanged behavior
 * =========================
 */
resolver.define('runPlaybook', async ({ payload, context }) => {
  const issueKey = payload?.issueKey;
  const accountId = context?.accountId;

  if (!issueKey) return { ok: false, error: 'Missing issueKey' };
  if (!accountId) return { ok: false, error: 'No accountId in context' };

  const issue = await getIssue(issueKey);
  const comments = await getComments(issueKey);

  const fields = issue?.fields || {};
  const computed = computeRiskAndReasons(fields);

  const steps = [];

  // Step 1: Assign (only if unassigned)
  if (!fields?.assignee) {
    try {
      await assignToMe(issueKey, accountId);
      steps.push({ key: 'assign', label: 'Assign to me', status: 'done', message: `Assigned ${issueKey}` });
    } catch (e) {
      steps.push({ key: 'assign', label: 'Assign to me', status: 'failed', message: String(e) });
    }
  } else {
    steps.push({ key: 'assign', label: 'Assign to me', status: 'skipped', message: 'Skipped — already assigned' });
  }

  // Step 2: Post playbook note (skip if posted recently)
  try {
    const skip = hasRecentMarkedComment(comments, MARK_PLAYBOOK_NOTE, SKIP_PLAYBOOK_NOTE_WITHIN_HOURS);
    if (skip) {
      steps.push({
        key: 'note',
        label: 'Post playbook note',
        status: 'skipped',
        message: `Skipped — posted within ${SKIP_PLAYBOOK_NOTE_WITHIN_HOURS}h`,
      });
    } else {
      await addComment(issueKey, [
        `${MARK_PLAYBOOK_NOTE}`,
        `Reasons: ${computed.reasons.join(' • ') || 'n/a'}`,
        '',
        'Plan:',
        '1) Assign owner (if missing)',
        '2) Request update on blockers',
        '3) Generate customer update draft',
        '4) Escalate if SLA hot / risk HIGH persists',
      ]);
      steps.push({ key: 'note', label: 'Post playbook note', status: 'done', message: `Playbook note posted for ${issueKey}` });
    }
  } catch (e) {
    steps.push({ key: 'note', label: 'Post playbook note', status: 'failed', message: String(e) });
  }

  // Step 3: Request update (skip if posted recently)
  try {
    const skip = hasRecentMarkedComment(comments, MARK_REQUEST_UPDATE, SKIP_REQUEST_UPDATE_WITHIN_HOURS);
    if (skip) {
      steps.push({
        key: 'req',
        label: 'Request update',
        status: 'skipped',
        message: `Skipped — requested within ${SKIP_REQUEST_UPDATE_WITHIN_HOURS}h`,
      });
    } else {
      await addComment(issueKey, [
        `${MARK_REQUEST_UPDATE}`,
        'Pit stop check: please post a quick update.',
        '',
        '• What’s blocking?',
        '• ETA for next step?',
        '• Do you need help?',
      ]);
      steps.push({ key: 'req', label: 'Request update', status: 'done', message: `Request update posted for ${issueKey}` });
    }
  } catch (e) {
    steps.push({ key: 'req', label: 'Request update', status: 'failed', message: String(e) });
  }

  // Step 4: Customer draft (always produce; no Jira write)
  const draft = buildCustomerDraft(issueKey, fields?.summary || issueKey, computed.status);
  steps.push({ key: 'draft', label: 'Generate customer update', status: 'done', message: `Draft ready for ${issueKey}` });

  // Step 5: Escalate (policy)
  try {
    const shouldEscalate =
      computed.risk === 'HIGH' &&
      (computed.firstResponseRemainingHours !== null
        ? computed.firstResponseRemainingHours <= SLA_HIGH_HOURS
        : computed.reasons.includes(`Stale ${STALE_HIGH_HOURS}h+`) || computed.reasons.includes('Unassigned'));

    if (!shouldEscalate) {
      steps.push({ key: 'esc', label: 'Escalate', status: 'skipped', message: 'Skipped — escalation not required by policy' });
    } else {
      const labels = fields?.labels || [];
      if (labels.includes(LABEL_ESCALATED)) {
        steps.push({ key: 'esc', label: 'Escalate', status: 'skipped', message: 'Skipped — already escalated' });
      } else {
        await escalateByLabel(issueKey);
        steps.push({ key: 'esc', label: 'Escalate', status: 'done', message: `Escalated ${issueKey}` });
      }
    }
  } catch (e) {
    steps.push({ key: 'esc', label: 'Escalate', status: 'failed', message: String(e) });
  }

  const outcome = {
    owner: fields?.assignee?.displayName || 'Unassigned',
    risk: computed.risk,
    reasons: computed.reasons,
    recommended: computed.recommended,
    nextUpdate: 'Next business day (or sooner if progress)',
    escalationLabel: LABEL_ESCALATED,
  };

  return { ok: true, issueKey, steps, draft, outcome };
});

/**
 * =========================
 * runRecommended (single issue)
 * =========================
 */
resolver.define('runRecommended', async ({ payload, context }) => {
  const issueKey = payload?.issueKey;
  const accountId = context?.accountId;

  if (!issueKey) return { ok: false, error: 'Missing issueKey' };
  if (!accountId) return { ok: false, error: 'No accountId in context' };

  const issue = await getIssue(issueKey);
  const comments = await getComments(issueKey);

  const fields = issue?.fields || {};
  const computed = computeRiskAndReasons(fields);

  const steps = [];
  const rec = computed.recommended || [];

  const runStep = async (key, label, fn) => {
    try {
      const out = await fn();
      if (out?.skipped) steps.push({ key, label, status: 'skipped', message: out.message || 'Skipped' });
      else steps.push({ key, label, status: 'done', message: out?.message || `${label} complete for ${issueKey}` });
    } catch (e) {
      steps.push({ key, label, status: 'failed', message: String(e) });
    }
  };

  for (const action of rec) {
    if (action === 'Assign to me') {
      if (fields?.assignee) {
        steps.push({ key: 'assign', label: 'Assign to me', status: 'skipped', message: 'Skipped — already assigned' });
      } else {
        await runStep('assign', 'Assign to me', async () => {
          await assignToMe(issueKey, accountId);
          return { message: `Assign to me complete for ${issueKey}` };
        });
      }
    }

    if (action === 'Request update') {
      const skip = hasRecentMarkedComment(comments, MARK_REQUEST_UPDATE, SKIP_REQUEST_UPDATE_WITHIN_HOURS);
      if (skip) {
        steps.push({
          key: 'req',
          label: 'Request update',
          status: 'skipped',
          message: `Skipped — requested within ${SKIP_REQUEST_UPDATE_WITHIN_HOURS}h`,
        });
      } else {
        await runStep('req', 'Request update', async () => {
          await addComment(issueKey, [
            `${MARK_REQUEST_UPDATE}`,
            'Pit stop check: please post a quick update.',
            '',
            '• What’s blocking?',
            '• ETA for next step?',
            '• Do you need help?',
          ]);
          return { message: `Request update posted for ${issueKey}` };
        });
      }
    }

    if (action === 'Post playbook note') {
      const skip = hasRecentMarkedComment(comments, MARK_PLAYBOOK_NOTE, SKIP_PLAYBOOK_NOTE_WITHIN_HOURS);
      if (skip) {
        steps.push({
          key: 'note',
          label: 'Post playbook note',
          status: 'skipped',
          message: `Skipped — posted within ${SKIP_PLAYBOOK_NOTE_WITHIN_HOURS}h`,
        });
      } else {
        await runStep('note', 'Post playbook note', async () => {
          await addComment(issueKey, [
            `${MARK_PLAYBOOK_NOTE}`,
            `Reasons: ${computed.reasons.join(' • ') || 'n/a'}`,
            '',
            'Plan:',
            '1) Assign owner (if missing)',
            '2) Request update on blockers',
            '3) Generate customer update draft',
            '4) Escalate if SLA hot / risk HIGH persists',
          ]);
          return { message: `Playbook note posted for ${issueKey}` };
        });
      }
    }

    if (action === 'Generate customer update') {
      steps.push({ key: 'draft', label: 'Generate customer update', status: 'done', message: `Draft ready for ${issueKey}` });
    }

    if (action === 'Escalate') {
      await runStep('esc', 'Escalate', async () => {
        const labels = fields?.labels || [];
        if (labels.includes(LABEL_ESCALATED)) return { skipped: true, message: 'Skipped — already escalated' };
        await escalateByLabel(issueKey);
        return { message: `Escalate complete for ${issueKey}` };
      });
    }
  }

  const draft = buildCustomerDraft(issueKey, fields?.summary || issueKey, computed.status);

  return {
    ok: true,
    issueKey,
    steps,
    draft,
    outcome: {
      risk: computed.risk,
      reasons: computed.reasons,
      recommended: computed.recommended,
      pitWallCall: computed.pitWallCall,
      next: computed.nextAction,
    },
  };
});

/**
 * =========================
 * Bulk mode - runRecommended across a set
 * scope = "HIGH" => only HIGH from Top 10 list
 * scope = "VISIBLE" => all Top 10
 * =========================
 */
resolver.define('runBulkRecommended', async ({ payload, context }) => {
  const scope = payload?.scope || 'HIGH';
  const accountId = context?.accountId;
  const projectKey = context?.extension?.project?.key;

  if (!accountId) return { ok: false, error: 'No accountId in context' };
  if (!projectKey) return { ok: false, error: 'No project key found in context.' };

  const jql = `project = ${projectKey} AND statusCategory != Done ORDER BY updated ASC`;
  const data = await jiraRequest(
    route`/rest/api/3/search/jql?jql=${jql}&maxResults=10&fields=summary,status,updated,assignee,labels,sla`
  );

  const raw = data?.issues || [];
  const enriched = raw.map((i) => {
    const computed = computeRiskAndReasons(i.fields || {});
    return { key: i.key, computed };
  });

  const targets = scope === 'VISIBLE' ? enriched : enriched.filter((x) => x.computed?.risk === 'HIGH');

  const results = [];
  let okCount = 0;
  let failedCount = 0;
  let failedSteps = 0;
  let skippedSteps = 0;

  for (const t of targets) {
    try {
      const issueKey = t.key;

      const issue = await getIssue(issueKey);
      const comments = await getComments(issueKey);
      const fields = issue?.fields || {};
      const computed = computeRiskAndReasons(fields);
      const rec = computed.recommended || [];

      const steps = [];

      if (rec.includes('Assign to me')) {
        if (fields?.assignee) {
          steps.push({ key: 'assign', label: 'Assign to me', status: 'skipped', message: 'Skipped — already assigned' });
          skippedSteps += 1;
        } else {
          try {
            await assignToMe(issueKey, accountId);
            steps.push({ key: 'assign', label: 'Assign to me', status: 'done', message: `Assign to me complete for ${issueKey}` });
          } catch (e) {
            steps.push({ key: 'assign', label: 'Assign to me', status: 'failed', message: String(e) });
            failedSteps += 1;
          }
        }
      }

      if (rec.includes('Request update')) {
        const skip = hasRecentMarkedComment(comments, MARK_REQUEST_UPDATE, SKIP_REQUEST_UPDATE_WITHIN_HOURS);
        if (skip) {
          steps.push({
            key: 'req',
            label: 'Request update',
            status: 'skipped',
            message: `Skipped — requested within ${SKIP_REQUEST_UPDATE_WITHIN_HOURS}h`,
          });
          skippedSteps += 1;
        } else {
          try {
            await addComment(issueKey, [
              `${MARK_REQUEST_UPDATE}`,
              'Pit stop check: please post a quick update.',
              '',
              '• What’s blocking?',
              '• ETA for next step?',
              '• Do you need help?',
            ]);
            steps.push({ key: 'req', label: 'Request update', status: 'done', message: `Request update posted for ${issueKey}` });
          } catch (e) {
            steps.push({ key: 'req', label: 'Request update', status: 'failed', message: String(e) });
            failedSteps += 1;
          }
        }
      }

      if (rec.includes('Post playbook note')) {
        const skip = hasRecentMarkedComment(comments, MARK_PLAYBOOK_NOTE, SKIP_PLAYBOOK_NOTE_WITHIN_HOURS);
        if (skip) {
          steps.push({
            key: 'note',
            label: 'Post playbook note',
            status: 'skipped',
            message: `Skipped — posted within ${SKIP_PLAYBOOK_NOTE_WITHIN_HOURS}h`,
          });
          skippedSteps += 1;
        } else {
          try {
            await addComment(issueKey, [
              `${MARK_PLAYBOOK_NOTE}`,
              `Reasons: ${computed.reasons.join(' • ') || 'n/a'}`,
              '',
              'Plan:',
              '1) Assign owner (if missing)',
              '2) Request update on blockers',
              '3) Generate customer update draft',
              '4) Escalate if SLA hot / risk HIGH persists',
            ]);
            steps.push({ key: 'note', label: 'Post playbook note', status: 'done', message: `Playbook note posted for ${issueKey}` });
          } catch (e) {
            steps.push({ key: 'note', label: 'Post playbook note', status: 'failed', message: String(e) });
            failedSteps += 1;
          }
        }
      }

      let draft = null;
      if (rec.includes('Generate customer update')) {
        draft = buildCustomerDraft(issueKey, fields?.summary || issueKey, computed.status);
        steps.push({ key: 'draft', label: 'Generate customer update', status: 'done', message: `Draft ready for ${issueKey}` });
      }

      if (rec.includes('Escalate')) {
        try {
          const labels = fields?.labels || [];
          if (labels.includes(LABEL_ESCALATED)) {
            steps.push({ key: 'esc', label: 'Escalate', status: 'skipped', message: 'Skipped — already escalated' });
            skippedSteps += 1;
          } else {
            await escalateByLabel(issueKey);
            steps.push({ key: 'esc', label: 'Escalate', status: 'done', message: `Escalate complete for ${issueKey}` });
          }
        } catch (e) {
          steps.push({ key: 'esc', label: 'Escalate', status: 'failed', message: String(e) });
          failedSteps += 1;
        }
      }

      results.push({ issueKey, ok: true, steps, draft });
      okCount += 1;
    } catch (e) {
      results.push({ issueKey: t.key, ok: false, error: String(e) });
      failedCount += 1;
    }
  }

  return {
    ok: true,
    scope,
    projectKey,
    total: targets.length,
    okCount,
    failedCount,
    failedSteps,
    skippedSteps,
    results,
  };
});

export const handler = resolver.getDefinitions();