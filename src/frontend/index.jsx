import React, { useEffect, useState } from 'react';
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

function formatSla(hours) {
  if (hours === null || hours === undefined) return null;
  return `${Math.round(hours * 10) / 10}h`;
}

const App = () => {
  const [state, setState] = useState({
    loading: true,
    projectKey: null,
    issues: [],
    error: null,
    toast: null,
  });

  const loadIssues = async () => {
    try {
      const result = await invoke('getAtRiskIssues', {});
      setState((s) => ({
        ...s,
        loading: false,
        projectKey: result.projectKey || null,
        issues: result.issues || [],
        error: result.error || null,
      }));
    } catch (e) {
      setState((s) => ({
        ...s,
        loading: false,
        issues: [],
        error: String(e),
      }));
    }
  };

  useEffect(() => {
    loadIssues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestUpdate = async (issueKey) => {
    setState((s) => ({ ...s, toast: `Sending request for ${issueKey}...` }));
    try {
      const res = await invoke('requestUpdate', { issueKey });
      if (res?.ok) {
        setState((s) => ({ ...s, toast: `✅ Comment added to ${issueKey}` }));
        await loadIssues();
      } else {
        setState((s) => ({ ...s, toast: `❌ Failed: ${res?.error || 'unknown error'}` }));
      }
    } catch (e) {
      setState((s) => ({ ...s, toast: `❌ Failed: ${String(e)}` }));
    }
  };

  const assignToMe = async (issueKey) => {
    setState((s) => ({ ...s, toast: `Assigning ${issueKey} to you...` }));
    try {
      const res = await invoke('assignToMe', { issueKey });
      if (res?.ok) {
        setState((s) => ({ ...s, toast: `✅ Assigned ${issueKey} to you` }));
        await loadIssues();
      } else {
        setState((s) => ({ ...s, toast: `❌ Failed: ${res?.error || 'unknown error'}` }));
      }
    } catch (e) {
      setState((s) => ({ ...s, toast: `❌ Failed: ${String(e)}` }));
    }
  };

  if (state.loading) return <Text>Loading Pit Wall…</Text>;
  if (state.error) return <Text>Error: {state.error}</Text>;

  const riskLozenge = (risk) => {
    if (risk === 'HIGH') return <Lozenge appearance="removed">HIGH RISK</Lozenge>;
    if (risk === 'MEDIUM') return <Lozenge appearance="inprogress">MEDIUM RISK</Lozenge>;
    return <Lozenge appearance="success">NORMAL</Lozenge>;
  };

  return (
    <Stack space="space.200">
      <Text>
        <Strong>Pit Wall — At-Risk Work (Top 10)</Strong>
      </Text>

      {state.projectKey && <Text>Project: {state.projectKey}</Text>}
      {state.toast && <Text>{state.toast}</Text>}

      {!state.issues.length ? (
        <Text>No open issues found. Create a few issues in this project to demo.</Text>
      ) : (
        state.issues.map((i) => (
          <Stack key={i.key} space="space.100">
            <Text>
              <Strong>{i.key}</Strong> — {cleanSummary(i.summary)}
            </Text>

            <Text>
              {riskLozenge(i.risk)}{' '}
              <Lozenge>{i.status}</Lozenge>{' '}
              Updated: {i.updated ? new Date(i.updated).toLocaleString() : 'Unknown'} |{' '}
              Stale: {formatStale(i.staleHours)} |{' '}
              Owner: {i.assigneeName || 'Unassigned'}
              {i.firstResponseRemainingHours !== null && i.firstResponseRemainingHours !== undefined
                ? ` | SLA (1st response): ${formatSla(i.firstResponseRemainingHours)}`
                : ''}
            </Text>

            {Array.isArray(i.reasons) && i.reasons.length > 0 && (
              <Text>
                <Strong>Reason:</Strong> {i.reasons.join(' • ')}
              </Text>
            )}

            <Stack space="space.100">
              {!i.assigneeName && (
                <Button onClick={() => assignToMe(i.key)}>Assign to me</Button>
              )}
              <Button onClick={() => requestUpdate(i.key)}>Request update</Button>
            </Stack>
          </Stack>
        ))
      )}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);