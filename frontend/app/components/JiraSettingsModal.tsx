'use client';

import { useEffect, useState } from 'react';
import { useJira } from '../context/JiraContext';

export default function JiraSettingsModal({ onClose }: { onClose: () => void }) {
  const { status, statusLoaded, refreshStatus, connect, disconnect } = useJira();
  const [jiraBaseUrl, setJiraBaseUrl] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [error, setError] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => { if (!statusLoaded) refreshStatus(); }, [statusLoaded, refreshStatus]);

  useEffect(() => {
    if (status?.connected) {
      setJiraBaseUrl(status.jiraBaseUrl || '');
      setJiraEmail(status.jiraEmail || '');
    }
  }, [status]);

  const handleConnect = async () => {
    if (!jiraBaseUrl.trim() || !jiraEmail.trim() || !apiToken.trim()) return;
    setState('saving'); setError('');
    try {
      await connect({ jiraBaseUrl: jiraBaseUrl.trim(), jiraEmail: jiraEmail.trim(), apiToken: apiToken.trim() });
      setApiToken('');
      setState('idle');
    } catch (e: any) {
      setError(e.message || 'Connexion à Jira impossible');
      setState('error');
    }
  };

  const handleDisconnect = async () => {
    setState('saving');
    try {
      await disconnect();
      setJiraBaseUrl(''); setJiraEmail(''); setApiToken('');
      setConfirmDisconnect(false);
      setState('idle');
    } catch (e: any) {
      setError(e.message || 'Déconnexion impossible');
      setState('error');
    }
  };

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white dark:bg-blacksection border border-stroke dark:border-strokedark shadow-solid-3 p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-bold text-black dark:text-white flex items-center gap-2">🔗 Compte Atlassian</h3>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white transition-colors">✕</button>
        </div>
        <p className="text-xs text-waterloo mb-5">
          Connectez votre compte Atlassian pour exporter directement vos cas de test validés.
        </p>

        {status?.connected && (
          <div className="mb-4 px-3 py-2.5 rounded-lg bg-meta/10 border border-meta/30 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-bold text-meta">✓ Compte connecté</div>
              <div className="text-[11px] text-waterloo truncate">{status.jiraEmail} — {status.jiraBaseUrl}</div>
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-bold text-waterloo mb-1">URL de votre instance Jira</label>
            <input
              type="text"
              value={jiraBaseUrl}
              onChange={e => setJiraBaseUrl(e.target.value)}
              placeholder="https://monentreprise.atlassian.net"
              className="w-full px-3 py-2 rounded-lg border border-stroke dark:border-strokedark bg-transparent text-sm text-black dark:text-white outline-none focus:border-primary/50"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-waterloo mb-1">Email du compte Atlassian</label>
            <input
              type="email"
              value={jiraEmail}
              onChange={e => setJiraEmail(e.target.value)}
              placeholder="vous@entreprise.com"
              className="w-full px-3 py-2 rounded-lg border border-stroke dark:border-strokedark bg-transparent text-sm text-black dark:text-white outline-none focus:border-primary/50"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-waterloo mb-1">Jeton d'API Atlassian</label>
            <input
              type="password"
              value={apiToken}
              onChange={e => setApiToken(e.target.value)}
              placeholder={status?.connected ? '••••••••••••••• (laisser vide pour ne pas changer)' : 'Jeton API (pas votre mot de passe)'}
              className="w-full px-3 py-2 rounded-lg border border-stroke dark:border-strokedark bg-transparent text-sm text-black dark:text-white outline-none focus:border-primary/50"
            />
            <p className="text-[10px] text-waterloo mt-1">
              Créez un jeton depuis votre compte Atlassian : id.atlassian.com → Sécurité → Jetons d'API.
            </p>
          </div>
        </div>

        {error && <div className="mt-3 text-[11px] text-red-700 dark:text-red-400 bg-red-600/5 border border-red-600/30 rounded-lg px-3 py-2">{error}</div>}

        <div className="flex items-center gap-2 mt-5">
          <button
            onClick={handleConnect}
            disabled={state === 'saving' || !jiraBaseUrl.trim() || !jiraEmail.trim() || !apiToken.trim()}
            className="flex-1 px-4 py-2.5 rounded-full text-sm font-bold bg-primary text-white hover:bg-primaryho transition-all disabled:bg-stroke disabled:text-waterloo disabled:cursor-not-allowed"
          >
            {state === 'saving' ? 'Connexion...' : status?.connected ? 'Mettre à jour' : 'Connecter'}
          </button>
          {status?.connected && !confirmDisconnect && (
            <button onClick={() => setConfirmDisconnect(true)} className="px-4 py-2.5 rounded-full border border-red-600/30 text-red-700 dark:text-red-400 text-sm font-bold hover:bg-red-600/5 transition-all">
              Déconnecter
            </button>
          )}
          {confirmDisconnect && (
            <>
              <button onClick={handleDisconnect} disabled={state === 'saving'} className="px-4 py-2.5 rounded-full bg-red-600 text-white text-sm font-bold hover:bg-red-700 transition-all">Confirmer</button>
              <button onClick={() => setConfirmDisconnect(false)} className="px-4 py-2.5 rounded-full border border-stroke dark:border-strokedark text-waterloo text-sm transition-all">Annuler</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}