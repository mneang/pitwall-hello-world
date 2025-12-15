import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@forge/bridge';
import ForgeReconciler, { Text, Strong, Stack, Lozenge, Button } from '@forge/react';

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

const App = () => {
  const [state, setState] = useState({
    loading: true,
    projectKey: null,
    issues: [],
    stats: null,
    error: null,
    toast: null,

    // Per-issue UI state
    busy: {},              // { [issueKey]: boolean }
    logs: [],              // array of strings
    drafts: {},            // { [issueKey]: string }
    lastRun: {},           // { [issueKey]: string }
  });

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

  const pushLog = (line) => {
    setState((s) => ({ ...s, logs: [line, ...s.logs].slice(0, 12) })); // keep last 12
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

  const generateDraftLocal = (issue) => {
    const summary = cleanSummary(issue.summary);
    const text =
      `Update on "${summary}" (${issue.key})\n` +
      `Current status: ${issue.status}\n` +
      `What we're doing now: We are assigning an owner and beginning investigation immediately.\n` +
      `Next update: within the next business day (or sooner if we make progress)\n` +
      `Thanks for your patience — we'll keep you posted.`;

    setState((s) => ({
      ...s,
      drafts: { ...s.drafts, [issue.key]: text },
      toast: `✅ Customer update draft ready for ${issue.key}`,
      lastRun: { ...s.lastRun, [issue.key]: new Date().toLocaleString() },
    }));
    pushLog(`✅ Generate customer update — Customer update draft ready for ${issue.key}`);
  };

  const runPlaybook = async (issue) => {
    const issueKey = issue.key;

    setBusy(issueKey, true);
    setState((s) => ({ ...s, toast: `Running playbook for ${issueKey}…` }));

    try {
      const res = await invoke('runPlaybook', { issueKey });

      if (!res?.ok) {
        setState((s) => ({ ...s, toast: `❌ Playbook failed: ${res?.error || 'unknown error'}` }));
        pushLog(`❌ Playbook — failed for ${issueKey}: ${res?.error || 'unknown error'}`);
        return;
      }

      // Step logs (done/skipped/failed)
      const steps = res.steps || [];
      for (const step of steps) {
        pushLog(`${stepPrefix(step.status)} ${step.label} — ${step.message}`);
      }

      // Draft
      if (typeof res.draft === 'string' && res.draft.trim()) {
        setState((s) => ({ ...s, drafts: { ...s.drafts, [issueKey]: res.draft } }));
      }

      // Timestamp
      setState((s) => ({
        ...s,
        toast: `✅ Playbook complete for ${issueKey}`,
        lastRun: { ...s.lastRun, [issueKey]: new Date().toLocaleString() },
      }));

      await loadIssues();
    } catch (e) {
      setState((s) => ({ ...s, toast: `❌ Playbook failed: ${String(e)}` }));
      pushLog(`❌ Playbook — failed for ${issueKey}: ${String(e)}`);
    } finally {
      setBusy(issueKey, false);
    }
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setState((s) => ({ ...s, toast: '✅ Copied draft' }));
    } catch {
      setState((s) => ({ ...s, toast: '❌ Copy failed (browser permissions)' }));
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

  if (state.loading) return <Text>Loading Pit Wall…</Text>;
  if (state.error) return <Text>Error: {state.error}</Text>;

  return (
    <Stack space="space.200">
      <Text>
        <Strong>Pit Wall — At-Risk Work (Top 10)</Strong>
      </Text>

      {state.projectKey && <Text>Project: {state.projectKey}</Text>}
      {scoreboard}
      {state.toast && <Text>{state.toast}</Text>}

      {!!state.logs.length && (
        <Stack space="space.050">
          {state.logs.map((l, idx) => (
            <Text key={idx}>{l}</Text>
          ))}
        </Stack>
      )}

      {!state.issues.length ? (
        <Text>No open issues found. Create a few issues in this project to demo.</Text>
      ) : (
        state.issues.map((i) => {
          const isBusy = !!state.busy[i.key];
          const draft = state.drafts[i.key];
          const last = state.lastRun[i.key];

          return (
            <Stack key={i.key} space="space.100">
              <Text>
                <Strong>{i.key}</Strong> — {cleanSummary(i.summary)}
              </Text>

              <Text>
                {riskLozenge(i.risk)}{' '}
                <Lozenge>{i.status}</Lozenge>{' '}
                Updated: {new Date(i.updated).toLocaleString()} | Stale: {formatStale(i.staleHours)} | Owner: {i.assigneeName || 'Unassigned'}
                {i.firstResponseRemainingHours !== null
                  ? ` | SLA (1st response): ${Math.round(i.firstResponseRemainingHours * 10) / 10}h`
                  : ''}
              </Text>

              <Text>
                <Strong>Reason:</Strong> {(i.reasons || []).join(' • ') || '—'}
              </Text>

              {(i.recommended || []).length ? (
                <Text>
                  <Strong>Next:</Strong> {(i.recommended || []).join(' → ')}
                </Text>
              ) : null}

              {/* Buttons inline (safe layout) */}
              <Text>
                <Button isDisabled={isBusy} onClick={() => assignToMe(i.key)}>Assign to me</Button>{' '}
                <Button isDisabled={isBusy} onClick={() => requestUpdate(i.key)}>Request update</Button>{' '}
                <Button isDisabled={isBusy} onClick={() => postPlaybookNote(i.key, i.reasons)}>Post playbook note</Button>{' '}
                <Button isDisabled={isBusy} onClick={() => generateDraftLocal(i)}>Generate customer update</Button>{' '}
                <Button isDisabled={isBusy} appearance="danger" onClick={() => escalate(i.key)}>Escalate</Button>{' '}
                <Button isDisabled={isBusy} appearance="primary" onClick={() => runPlaybook(i)}>Run playbook</Button>
              </Text>

              {last ? <Text>Last run: {last}</Text> : null}

              {draft ? (
                <Stack space="space.050">
                  <Text><Strong>Customer update draft</Strong></Text>
                  <Text>{draft}</Text>
                  <Button onClick={() => copyToClipboard(draft)}>Copy draft</Button>
                </Stack>
              ) : null}
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