import React, { useEffect, useMemo, useState } from 'react';
import { invoke, router } from '@forge/bridge';
import ForgeReconciler, {
  Text,
  Strong,
  Stack,
  Lozenge,
  Button,
  Textfield,
} from '@forge/react';

function cleanSummary(summary) {
  if (!summary) return '';
  return summary.replace('[DEMO-HIGH]', '').trim();
}

function formatStale(staleHours) {
  if (staleHours === null || staleHours === undefined) return 'Unknown';
  if (staleHours < 24) return `${Math.round(staleHours)}h`;
  const days = staleHours / 24;
  return `${days.toFixed(1)}d`;
}

function riskRank(risk) {
  if (risk === 'HIGH') return 0;
  if (risk === 'MEDIUM') return 1;
  return 2;
}

function riskLozenge(risk) {
  if (risk === 'HIGH') return <Lozenge appearance="removed">HIGH RISK</Lozenge>;
  if (risk === 'MEDIUM') return <Lozenge appearance="inprogress">MEDIUM RISK</Lozenge>;
  return <Lozenge appearance="success">Normal</Lozenge>;
}

function stepPrefix(status) {
  if (status === 'done') return '✅';
  if (status === 'skipped') return '⏭️';
  return '❌';
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

const App = () => {
  const [state, setState] = useState({
    loading: true,
    projectKey: null,
    issues: [],
    stats: null,
    error: null,
    toast: null,

    // Per-issue UI state
    busy: {},

    // Activity log
    showLog: true,
    logs: [],

    // Drafts + run history
    drafts: {},
    lastRun: {},
    lastSteps: {}, // NEW: { [issueKey]: steps[] }
    lastOutcome: {}, // NEW: { [issueKey]: outcome }

    // Bulk mode
    bulkBusy: false,

    // UX refinements
    filter: 'ALL',
    query: '',
    collapsed: {},

    // NEW: meta per issue (cooldowns)
    metaBusy: {},
    meta: {}, // { [issueKey]: { cooldowns } }

    // NEW: sort
    sortKey: 'RISK', // RISK | STALE | SLA | UPDATED
  });

  const pushLog = (line) => {
    setState((s) => ({ ...s, logs: [line, ...s.logs].slice(0, 60) }));
  };

  const loadIssues = async () => {
    try {
      const result = await invoke('getAtRiskIssues', {});
      setState((s) => ({
        ...s,
        loading: false,
        projectKey: result.projectKey || null,
        issues: result.issues || [],
        stats: result.stats || null,
        error: result.error || null,
      }));
    } catch (e) {
      setState((s) => ({
        ...s,
        loading: false,
        issues: [],
        stats: null,
        error: String(e),
      }));
    }
  };

  useEffect(() => {
    loadIssues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setBusy = (issueKey, value) => {
    setState((s) => ({ ...s, busy: { ...s.busy, [issueKey]: value } }));
  };

  const setMetaBusy = (issueKey, value) => {
    setState((s) => ({ ...s, metaBusy: { ...s.metaBusy, [issueKey]: value } }));
  };

  const doAction = async (issueKey, label, fn) => {
    setBusy(issueKey, true);
    setState((s) => ({ ...s, toast: `${label} running for ${issueKey}…` }));
    try {
      const res = await fn();
      if (res?.ok) {
        setState((s) => ({ ...s, toast: `✅ ${label} complete for ${issueKey}` }));
        pushLog(`✅ ${label} — ${label} complete for ${issueKey}`);
        await loadIssues();
      } else {
        setState((s) => ({ ...s, toast: `❌ ${label} failed: ${res?.error || 'unknown error'}` }));
        pushLog(`❌ ${label} — failed for ${issueKey}: ${res?.error || 'unknown error'}`);
      }
    } catch (e) {
      setState((s) => ({ ...s, toast: `❌ ${label} failed: ${String(e)}` }));
      pushLog(`❌ ${label} — failed for ${issueKey}: ${String(e)}`);
    } finally {
      setBusy(issueKey, false);
    }
  };

  const assignToMe = (issueKey) =>
    doAction(issueKey, 'Assign to me', () => invoke('assignToMe', { issueKey }));

  const requestUpdate = (issueKey) =>
    doAction(issueKey, 'Request update', () => invoke('requestUpdate', { issueKey }));

  const postPlaybookNote = (issueKey, reasons) =>
    doAction(issueKey, 'Post playbook note', () => invoke('postPlaybookNote', { issueKey, reasons }));

  const escalate = (issueKey) =>
    doAction(issueKey, 'Escalate', () => invoke('escalate', { issueKey }));

  const openIssue = async (issueKey) => {
    try {
      await router.open(`/browse/${issueKey}`);
      pushLog(`🔗 Open — opened ${issueKey}`);
    } catch (e) {
      setState((s) => ({ ...s, toast: `❌ Open failed: ${String(e)}` }));
      pushLog(`❌ Open — failed for ${issueKey}: ${String(e)}`);
    }
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setState((s) => ({ ...s, toast: '✅ Copied to clipboard' }));
    } catch {
      setState((s) => ({ ...s, toast: '❌ Copy failed (browser permissions)' }));
    }
  };

  // NEW: fetch cooldown meta on demand (when expanded / opened)
  const loadMeta = async (issueKey) => {
    if (state.meta[issueKey] || state.metaBusy[issueKey]) return;
    setMetaBusy(issueKey, true);
    try {
      const res = await invoke('getIssueCooldowns', { issueKey });
      if (res?.ok) {
        setState((s) => ({ ...s, meta: { ...s.meta, [issueKey]: { cooldowns: res.cooldowns } } }));
      }
    } catch (e) {
      pushLog(`⚠️ Meta — failed for ${issueKey}: ${String(e)}`);
    } finally {
      setMetaBusy(issueKey, false);
    }
  };

  const toggleCollapsed = async (issueKey) => {
    const willCollapse = !state.collapsed[issueKey];
    setState((s) => ({
      ...s,
      collapsed: { ...s.collapsed, [issueKey]: willCollapse },
    }));
    // If expanding, load meta
    if (!willCollapse) await loadMeta(issueKey);
  };

  // NEW: “Race radio” summary (copies perfect judge-friendly output)
  const copyRunSummary = async (issue) => {
    const issueKey = issue.key;
    const steps = state.lastSteps[issueKey] || [];
    const outcome = state.lastOutcome[issueKey] || null;
    const draft = state.drafts[issueKey] || '';

    const header = `[PIT WALL] ${issueKey} — ${cleanSummary(issue.summary)}`;
    const line1 = `Risk: ${issue.risk} | Status: ${issue.status} | Owner: ${issue.assigneeName || 'Unassigned'}`;
    const line2 = `Reasons: ${(issue.reasons || []).join(' • ') || '—'}`;
    const line3 = `Recommended: ${(issue.recommended || []).join(' → ') || '—'}`;

    const stepsLine =
      steps.length
        ? `Actions: ${steps
            .map((s) => `${stepPrefix(s.status)} ${s.label}`)
            .join(' | ')}`
        : `Actions: (no run history yet)`;

    const nextLine = outcome?.next ? `Next: ${outcome.next}` : (issue.nextAction ? `Next: ${issue.nextAction}` : `Next: —`);

    const draftBlock =
      draft && draft.trim()
        ? `\nCustomer update draft:\n${draft}`
        : '';

    const payload = [header, line1, line2, line3, stepsLine, nextLine].join('\n') + draftBlock;

    await copyToClipboard(payload);
    pushLog(`📣 Copy summary — copied ${issueKey}`);
  };

  // Use SERVER runRecommended (single issue) for consistency
  const runRecommended = async (issue) => {
    const issueKey = issue.key;

    setBusy(issueKey, true);
    setState((s) => ({ ...s, toast: `Running recommended for ${issueKey}…` }));
    pushLog(`🏁 Run recommended started — ${issueKey}`);

    try {
      const res = await invoke('runRecommended', { issueKey });

      if (!res?.ok) {
        setState((s) => ({ ...s, toast: `❌ Run recommended failed: ${res?.error || 'unknown error'}` }));
        pushLog(`❌ Run recommended — failed for ${issueKey}: ${res?.error || 'unknown error'}`);
        return;
      }

      const steps = res.steps || [];
      for (const step of steps) {
        pushLog(`${stepPrefix(step.status)} ${step.label} — ${step.message}`);
      }

      if (typeof res.draft === 'string' && res.draft.trim()) {
        setState((s) => ({ ...s, drafts: { ...s.drafts, [issueKey]: res.draft } }));
      }

      setState((s) => ({
        ...s,
        lastRun: { ...s.lastRun, [issueKey]: new Date().toLocaleString() },
        lastSteps: { ...s.lastSteps, [issueKey]: steps },
        lastOutcome: { ...s.lastOutcome, [issueKey]: res.outcome || null },
        toast: `✅ Run recommended complete for ${issueKey}`,
      }));

      // refresh list + meta after running
      await loadIssues();
      await loadMeta(issueKey);
    } catch (e) {
      setState((s) => ({ ...s, toast: `❌ Run recommended failed: ${String(e)}` }));
      pushLog(`❌ Run recommended — failed for ${issueKey}: ${String(e)}`);
    } finally {
      setBusy(issueKey, false);
    }
  };

  // Keep Run playbook (single issue) as-is
  const runPlaybook = async (issue) => {
    const issueKey = issue.key;

    setBusy(issueKey, true);
    setState((s) => ({ ...s, toast: `Running playbook for ${issueKey}…` }));
    pushLog(`🏁 Run playbook started — ${issueKey}`);

    try {
      const res = await invoke('runPlaybook', { issueKey });

      if (!res?.ok) {
        setState((s) => ({ ...s, toast: `❌ Playbook failed: ${res?.error || 'unknown error'}` }));
        pushLog(`❌ Playbook — failed for ${issueKey}: ${res?.error || 'unknown error'}`);
        return;
      }

      const steps = res.steps || [];
      for (const step of steps) {
        pushLog(`${stepPrefix(step.status)} ${step.label} — ${step.message}`);
      }

      if (typeof res.draft === 'string' && res.draft.trim()) {
        setState((s) => ({ ...s, drafts: { ...s.drafts, [issueKey]: res.draft } }));
      }

      setState((s) => ({
        ...s,
        lastRun: { ...s.lastRun, [issueKey]: new Date().toLocaleString() },
        lastSteps: { ...s.lastSteps, [issueKey]: steps },
        lastOutcome: { ...s.lastOutcome, [issueKey]: res.outcome || null },
        toast: `✅ Run playbook complete for ${issueKey}`,
      }));

      await loadIssues();
      await loadMeta(issueKey);
    } catch (e) {
      setState((s) => ({ ...s, toast: `❌ Playbook failed: ${String(e)}` }));
      pushLog(`❌ Playbook — failed for ${issueKey}: ${String(e)}`);
    } finally {
      setBusy(issueKey, false);
    }
  };

  // BULK: Use SERVER runBulkRecommended
  const runBulk = async (scope) => {
    if (state.bulkBusy) return;

    setState((s) => ({ ...s, bulkBusy: true, toast: 'Bulk run started…' }));
    pushLog(`🏁 Bulk run started — ${scope === 'HIGH' ? 'HIGH only' : 'ALL visible'}`);

    try {
      const res = await invoke('runBulkRecommended', { scope: scope === 'HIGH' ? 'HIGH' : 'VISIBLE' });

      if (!res?.ok) {
        setState((s) => ({ ...s, toast: `❌ Bulk failed: ${res?.error || 'unknown error'}` }));
        pushLog(`❌ Bulk — failed: ${res?.error || 'unknown error'}`);
        return;
      }

      pushLog(
        `🏁 Bulk finished — ok: ${res.okCount}, failed: ${res.failedCount}, failed steps: ${res.failedSteps}, skipped steps: ${res.skippedSteps}`
      );

      const results = res.results || [];
      for (const r of results) {
        if (!r.ok) {
          pushLog(`❌ Bulk — ${r.issueKey} failed: ${r.error || 'unknown error'}`);
          continue;
        }

        pushLog(`➡️ Bulk — ${r.issueKey}`);
        const steps = r.steps || [];
        for (const step of steps) {
          pushLog(`${stepPrefix(step.status)} ${step.label} — ${step.message}`);
        }

        if (typeof r.draft === 'string' && r.draft.trim()) {
          setState((s) => ({ ...s, drafts: { ...s.drafts, [r.issueKey]: r.draft } }));
        }

        // store steps for “Copy summary” convenience even after bulk
        setState((s) => ({
          ...s,
          lastSteps: { ...s.lastSteps, [r.issueKey]: steps },
        }));
      }

      setState((s) => ({
        ...s,
        toast: `✅ Bulk complete — ok: ${res.okCount}, failed: ${res.failedCount}`,
      }));

      await loadIssues();
    } catch (e) {
      setState((s) => ({ ...s, toast: `❌ Bulk failed: ${String(e)}` }));
      pushLog(`❌ Bulk — failed: ${String(e)}`);
    } finally {
      setState((s) => ({ ...s, bulkBusy: false }));
    }
  };

  const scoreboard = useMemo(() => {
    const stats = state.stats;
    if (!stats) return null;
    return (
      <Text>
        <Lozenge appearance="removed">HIGH: {stats.high}</Lozenge>{' '}
        <Lozenge appearance="inprogress">MEDIUM: {stats.medium}</Lozenge>{' '}
        <Lozenge appearance="success">NORMAL: {stats.normal}</Lozenge>{' '}
        <Lozenge>Unassigned HIGH: {stats.unassignedHigh}</Lozenge>{' '}
        <Lozenge>SLA ≤ 2h: {stats.slaHot}</Lozenge>
      </Text>
    );
  }, [state.stats]);

  const filteredIssues = useMemo(() => {
    const q = (state.query || '').toLowerCase().trim();
    const filter = state.filter;

    return (state.issues || []).filter((i) => {
      if (filter !== 'ALL' && i.risk !== filter) return false;
      if (!q) return true;

      const hay = `${i.key} ${i.summary} ${i.status} ${(i.reasons || []).join(' ')} ${(i.recommended || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }, [state.issues, state.filter, state.query]);

  const visibleIssues = useMemo(() => {
    const list = [...filteredIssues];
    const key = state.sortKey;

    list.sort((a, b) => {
      if (key === 'RISK') {
        const ra = riskRank(a.risk);
        const rb = riskRank(b.risk);
        if (ra !== rb) return ra - rb;
        // tiebreaker: oldest updated first
        return new Date(a.updated).getTime() - new Date(b.updated).getTime();
      }

      if (key === 'STALE') {
        const sa = a.staleHours ?? -1;
        const sb = b.staleHours ?? -1;
        // more stale first
        return sb - sa;
      }

      if (key === 'SLA') {
        const slaA = a.firstResponseRemainingHours;
        const slaB = b.firstResponseRemainingHours;
        // nulls last
        if (slaA === null && slaB === null) return 0;
        if (slaA === null) return 1;
        if (slaB === null) return -1;
        // less remaining first
        return slaA - slaB;
      }

      // UPDATED: oldest updated first
      return new Date(a.updated).getTime() - new Date(b.updated).getTime();
    });

    return list;
  }, [filteredIssues, state.sortKey]);

  if (state.loading) return <Text>Loading Pit Wall…</Text>;
  if (state.error) return <Text>Error: {state.error}</Text>;

  const headerBusy = state.bulkBusy;

  return (
    <Stack space="space.200">
      <Text>
        <Strong>Pit Wall — At-Risk Work (Top 10)</Strong>
      </Text>

      {state.projectKey && <Text>Project: {state.projectKey}</Text>}
      {scoreboard}
      {state.toast && <Text>{state.toast}</Text>}

      {/* Bulk controls */}
      <Text>
        <Button isDisabled={headerBusy} appearance="primary" onClick={() => runBulk('HIGH')}>
          Run recommended (ALL HIGH)
        </Button>{' '}
        <Button isDisabled={headerBusy} appearance="primary" onClick={() => runBulk('VISIBLE')}>
          Run recommended (ALL visible)
        </Button>{' '}
        <Button isDisabled={headerBusy} onClick={() => loadIssues()}>
          Refresh
        </Button>
      </Text>

      {/* Sort controls (operator cockpit) */}
      <Text>
        <Strong>Sort:</Strong>{' '}
        <Button isDisabled={headerBusy} onClick={() => setState((s) => ({ ...s, sortKey: 'RISK' }))}>
          Risk{state.sortKey === 'RISK' ? ' ✓' : ''}
        </Button>{' '}
        <Button isDisabled={headerBusy} onClick={() => setState((s) => ({ ...s, sortKey: 'STALE' }))}>
          Stale{state.sortKey === 'STALE' ? ' ✓' : ''}
        </Button>{' '}
        <Button isDisabled={headerBusy} onClick={() => setState((s) => ({ ...s, sortKey: 'SLA' }))}>
          SLA{state.sortKey === 'SLA' ? ' ✓' : ''}
        </Button>{' '}
        <Button isDisabled={headerBusy} onClick={() => setState((s) => ({ ...s, sortKey: 'UPDATED' }))}>
          Updated{state.sortKey === 'UPDATED' ? ' ✓' : ''}
        </Button>
      </Text>

      {/* Filter + Search */}
      <Text>
        <Button isDisabled={headerBusy} onClick={() => setState((s) => ({ ...s, filter: 'ALL' }))}>
          All
        </Button>{' '}
        <Button isDisabled={headerBusy} onClick={() => setState((s) => ({ ...s, filter: 'HIGH' }))}>
          HIGH
        </Button>{' '}
        <Button isDisabled={headerBusy} onClick={() => setState((s) => ({ ...s, filter: 'MEDIUM' }))}>
          MEDIUM
        </Button>{' '}
        <Button isDisabled={headerBusy} onClick={() => setState((s) => ({ ...s, filter: 'NORMAL' }))}>
          NORMAL
        </Button>{' '}
        <Lozenge>Showing: {visibleIssues.length}</Lozenge>
      </Text>

      <Textfield
        name="search"
        placeholder="Search issues (key, summary, status, reason, recommended)…"
        value={state.query}
        onChange={(e) => setState((s) => ({ ...s, query: e.target.value }))}
      />

      {/* Log controls */}
      <Text>
        <Button onClick={() => setState((s) => ({ ...s, showLog: !s.showLog }))}>
          {state.showLog ? 'Hide activity log' : 'Show activity log'}
        </Button>{' '}
        <Button onClick={() => setState((s) => ({ ...s, logs: [] }))}>
          Clear log
        </Button>
      </Text>

      {state.showLog && !!state.logs.length && (
        <Stack space="space.050">
          {state.logs.map((l, idx) => (
            <Text key={idx}>{l}</Text>
          ))}
        </Stack>
      )}

      {!visibleIssues.length ? (
        <Text>No issues match your view. (Try All / clear search / create demo issues.)</Text>
      ) : (
        visibleIssues.map((i) => {
          const isBusy = !!state.busy[i.key] || state.bulkBusy;
          const draft = state.drafts[i.key];
          const last = state.lastRun[i.key];
          const collapsed = !!state.collapsed[i.key];

          const meta = state.meta[i.key] || null;
          const cooldowns = meta?.cooldowns || null;

          // Determine “will run now” vs cooldown for recommended actions
          const willRun = [];
          const cooldownList = [];

          const rec = i.recommended || [];
          for (const action of rec) {
            if (action === 'Request update' && cooldowns?.requestUpdate) {
              if (cooldowns.requestUpdate.remainingHours > 0) {
                cooldownList.push(`Request update (next in ${round1(cooldowns.requestUpdate.remainingHours)}h)`);
              } else {
                willRun.push('Request update');
              }
              continue;
            }
            if (action === 'Post playbook note' && cooldowns?.playbookNote) {
              if (cooldowns.playbookNote.remainingHours > 0) {
                cooldownList.push(`Post playbook note (next in ${round1(cooldowns.playbookNote.remainingHours)}h)`);
              } else {
                willRun.push('Post playbook note');
              }
              continue;
            }
            if (action === 'Assign to me') {
              if (i.assigneeName) {
                cooldownList.push('Assign to me (already assigned)');
              } else {
                willRun.push('Assign to me');
              }
              continue;
            }
            // other actions don’t have cooldown logic
            willRun.push(action);
          }

          return (
            <Stack key={i.key} space="space.100">
              <Text>
                <Strong>{i.key}</Strong> — {cleanSummary(i.summary)}{' '}
                <Button isDisabled={isBusy} onClick={() => openIssue(i.key)}>Open</Button>{' '}
                <Button isDisabled={isBusy} onClick={() => toggleCollapsed(i.key)}>
                  {collapsed ? 'Expand' : 'Collapse'}
                </Button>{' '}
                <Button isDisabled={isBusy} onClick={() => copyRunSummary(i)}>
                  Copy run summary
                </Button>
              </Text>

              {!collapsed && (
                <>
                  <Text>
                    {riskLozenge(i.risk)}{' '}
                    <Lozenge>{i.status}</Lozenge>{' '}
                    Updated: {new Date(i.updated).toLocaleString()} | Stale: {formatStale(i.staleHours)} | Owner: {i.assigneeName || 'Unassigned'}
                    {i.firstResponseRemainingHours !== null
                      ? ` | SLA (1st response): ${round1(i.firstResponseRemainingHours)}h`
                      : ''}
                  </Text>

                  <Text>
                    <Strong>Reason:</Strong> {(i.reasons || []).join(' • ') || '—'}
                  </Text>

                  {(i.recommended || []).length ? (
                    <Text>
                      <Strong>Recommended:</Strong> {(i.recommended || []).join(' → ')}
                    </Text>
                  ) : null}

                  {/* NEW: Strategy window (why skipped, what runs now) */}
                  <Text>
                    <Strong>Strategy window:</Strong>{' '}
                    {state.metaBusy[i.key] ? 'Loading…' : ''}
                  </Text>

                  {cooldowns ? (
                    <>
                      <Text>
                        <Strong>Will run now:</Strong> {willRun.length ? willRun.join(' • ') : '—'}
                      </Text>
                      <Text>
                        <Strong>Cooldown:</Strong> {cooldownList.length ? cooldownList.join(' • ') : '—'}
                      </Text>
                    </>
                  ) : (
                    <Text>
                      <Lozenge>Tip:</Lozenge> Expand loads cooldown intel for “smart skips”.
                    </Text>
                  )}

                  {i.pitWallCall ? (
                    <Text>
                      <Strong>Pit Wall call:</Strong> {i.pitWallCall}
                    </Text>
                  ) : null}

                  <Text>
                    <Button isDisabled={isBusy} onClick={() => assignToMe(i.key)}>Assign to me</Button>{' '}
                    <Button isDisabled={isBusy} onClick={() => requestUpdate(i.key)}>Request update</Button>{' '}
                    <Button isDisabled={isBusy} onClick={() => postPlaybookNote(i.key, i.reasons)}>Post playbook note</Button>{' '}
                    <Button isDisabled={isBusy} appearance="danger" onClick={() => escalate(i.key)}>Escalate</Button>{' '}
                    <Button isDisabled={isBusy} appearance="primary" onClick={() => runPlaybook(i)}>Run playbook</Button>{' '}
                    <Button isDisabled={isBusy} appearance="primary" onClick={() => runRecommended(i)}>Run recommended</Button>
                  </Text>

                  {last ? <Text>Last run: {last}</Text> : null}

                  {draft ? (
                    <Stack space="space.050">
                      <Text><Strong>Customer update draft</Strong></Text>
                      <Text>{draft}</Text>
                      <Text>
                        <Button onClick={() => copyToClipboard(draft)}>Copy draft</Button>{' '}
                        <Button onClick={() => copyRunSummary(i)}>Copy summary + draft</Button>
                      </Text>
                    </Stack>
                  ) : null}
                </>
              )}
            </Stack>
          );
        })
      )}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);