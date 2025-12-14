import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@forge/bridge';
import ForgeReconciler, { Text, Strong, Stack, Lozenge, Button, Inline, Box } from '@forge/react';

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

const riskLozenge = (risk) => {
  if (risk === 'HIGH') return <Lozenge appearance="removed">HIGH RISK</Lozenge>;
  if (risk === 'MEDIUM') return <Lozenge appearance="inprogress">MEDIUM RISK</Lozenge>;
  return <Lozenge appearance="success">NORMAL</Lozenge>;
};

const App = () => {
  const [state, setState] = useState({
    loading: true,
    projectKey: null,
    issues: [],
    error: null,
    toast: null,
    drafts: {}, // issueKey -> draft text
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

  const setToast = (msg) => setState((s) => ({ ...s, toast: msg }));

  const runAction = async (label, issueKey, actionName, payload = {}) => {
    setToast(`⏳ ${label} for ${issueKey}...`);
    try {
      const res = await invoke(actionName, { issueKey, ...payload });
      if (res?.ok) {
        setToast(`✅ ${label} complete for ${issueKey}`);
        await loadIssues();
      } else {
        setToast(`❌ ${label} for ${issueKey} failed: ${res?.error || 'unknown error'}`);
      }
      return res;
    } catch (e) {
      setToast(`❌ ${label} for ${issueKey} failed: ${String(e)}`);
      return { ok: false, error: String(e) };
    }
  };

  const onAssignToMe = (issueKey) => runAction('Assign to me', issueKey, 'assignToMe');
  const onRequestUpdate = (issueKey) => runAction('Request update', issueKey, 'requestUpdate');
  const onPlaybookNote = (issueKey) => runAction('Post playbook note', issueKey, 'postPlaybookNote');

  const onGenerateCustomerUpdate = async (issueKey) => {
    setToast(`⏳ Generating customer update for ${issueKey}...`);
    try {
      const res = await invoke('generateCustomerUpdate', { issueKey });
      if (res?.ok) {
        setState((s) => ({
          ...s,
          drafts: { ...s.drafts, [issueKey]: res.draft || '' },
          toast: `✅ Customer update draft ready for ${issueKey}`,
        }));
      } else {
        setToast(`❌ Generate customer update for ${issueKey} failed: ${res?.error || 'unknown error'}`);
      }
    } catch (e) {
      setToast(`❌ Generate customer update for ${issueKey} failed: ${String(e)}`);
    }
  };

  const onEscalate = (issueKey) => runAction('Escalate', issueKey, 'escalate');

  const copyDraft = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setToast('✅ Draft copied to clipboard');
    } catch {
      setToast('⚠️ Could not auto-copy (browser blocked). You can manually copy the text.');
    }
  };

  if (state.loading) return <Text>Loading Pit Wall…</Text>;
  if (state.error) return <Text>Error: {state.error}</Text>;

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
        state.issues.map((i) => {
          const reasonsText = i.reasons?.length ? i.reasons.join(' • ') : '—';
          const slaText =
            i.firstResponseRemainingHours !== null && i.firstResponseRemainingHours !== undefined
              ? ` | SLA (1st response): ${Math.round(i.firstResponseRemainingHours * 10) / 10}h`
              : '';

          const draft = state.drafts[i.key];

          return (
            <Stack key={i.key} space="space.100">
              <Text>
                <Strong>{i.key}</Strong> — {cleanSummary(i.summary)}
              </Text>

              <Text>
                {riskLozenge(i.risk)}{' '}
                <Lozenge>{i.status}</Lozenge>{' '}
                Updated: {i.updated ? new Date(i.updated).toLocaleString() : 'Unknown'} | Stale: {formatStale(i.staleHours)} | Owner: {i.assigneeName || 'Unassigned'}
                {slaText}
              </Text>

              <Text>
                <Strong>Reason:</Strong> {reasonsText}
              </Text>

              <Inline space="space.100">
                <Button onClick={() => onAssignToMe(i.key)}>Assign to me</Button>
                <Button onClick={() => onRequestUpdate(i.key)}>Request update</Button>
                <Button onClick={() => onPlaybookNote(i.key)}>Post playbook note</Button>
                <Button onClick={() => onGenerateCustomerUpdate(i.key)}>Generate customer update</Button>
                <Button appearance="danger" onClick={() => onEscalate(i.key)}>Escalate</Button>
              </Inline>

              {draft ? (
                <Box padding="space.100">
                  <Text><Strong>Customer update draft</Strong></Text>
                  <Text>{draft}</Text>
                  <Inline space="space.100">
                    <Button onClick={() => copyDraft(draft)}>Copy draft</Button>
                  </Inline>
                </Box>
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