import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';
import { useHub } from './useHub';
const TerminalPane = lazy(() => import('./TerminalPane').then((module) => ({ default: module.TerminalPane })));

function Mark() {
  return <span className="brand-mark" aria-hidden="true">&gt;_</span>;
}

export function App() {
  const [username, setUsername] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [checkingError, setCheckingError] = useState(false);
  const check = useCallback(async () => {
    setChecking(true);
    setCheckingError(false);
    try {
      const result = await api<{ username: string }>('/api/me');
      setUsername(result.username);
      setError('');
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        setError('Cannot reach Agent Hub. Check that the server is running.');
        setCheckingError(true);
      }
    } finally { setChecking(false); }
  }, []);
  useEffect(() => { void check(); }, [check]);
  if (checking) return <main className="center-screen"><Mark /><p>Connecting to Agent Hub...</p></main>;
  if (checkingError) return <main className="center-screen"><Mark /><p role="alert">{error}</p><button onClick={() => void check()}>Retry connection</button></main>;
  if (!username) return <Login initialError={error} onLogin={(name) => { setError(''); setUsername(name); }} />;
  return <Dashboard username={username} onExpired={() => { setUsername(null); setError('Your session ended. Sign in again.'); }} onLogout={() => setUsername(null)} />;
}

function Login({ onLogin, initialError }: { onLogin: (name: string) => void; initialError: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ username: string }>('/api/login', { username, password });
      setPassword('');
      onLogin(result.username);
    } catch (error) { setError(error instanceof Error ? error.message : 'Sign in failed.'); }
    finally { setBusy(false); }
  };
  return (
    <main className="login-page">
      <div className="login-intro">
        <div className="wordmark"><Mark /> Agent Hub</div>
        <span className="eyebrow">YOUR AGENTS. ONE WORKSPACE.</span>
        <h1>Stay close to<br />the work.</h1>
        <p>Live terminals from your agent nodes. See what is happening, respond to a prompt, and keep things moving.</p>
        <div className="intro-terminal" aria-hidden="true">
          <div className="window-dots"><i /><i /><i /><span>agent-node / terminal</span></div>
          <p><span>$</span> agent-hub --user you -- your-agent</p>
          <p className="intro-success">Connected. Ready when you are.<span className="cursor-block" /></p>
        </div>
        <div className="intro-features"><span>Real PTY sessions</span><span>Live input &amp; output</span><span>Private by default</span></div>
      </div>
      <section className="login-card">
        <span className="eyebrow">WELCOME BACK</span>
        <h2>Sign in to your hub</h2>
        <p>Use the account created on your hub server.</p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="username">Username</label>
          <input id="username" name="username" autoComplete="username" autoFocus required value={username} onChange={(event) => setUsername(event.target.value)} maxLength={64} />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'} <span aria-hidden="true">&rarr;</span></button>
        </form>
        <p className="login-help">Need an account? Ask your hub administrator.<br />There are no default credentials.</p>
      </section>
    </main>
  );
}

function Dashboard({ username, onExpired, onLogout }: { username: string; onExpired: () => void; onLogout: () => void }) {
  const { sessions, connection, epoch, notice, setNotice, transport } = useHub(onExpired);
  const [selected, setSelected] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const active = sessions.find((session) => session.id === selected) ?? sessions[0];
  const online = sessions.filter((session) => session.status === 'online').length;
  const insecureHttp = location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const logout = async () => {
    setSigningOut(true);
    try { await api('/api/logout', {}); onLogout(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Sign out failed.'); }
    finally { setSigningOut(false); }
  };
  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="wordmark"><Mark /><span>Agent Hub<small>TERMINAL WORKSPACE</small></span></div>
        <div className="connection-indicator"><span className={`status-dot ${connection === 'connected' ? 'online' : 'disconnected'}`} />{connection === 'connected' ? 'Hub connected' : connection === 'connecting' ? 'Connecting...' : 'Reconnecting...'}</div>
        <div className="sidebar-heading"><h2>Terminals</h2><span>{sessions.length}</span></div>
        <nav aria-label="Agent terminals">
          {sessions.map((session) => (
            <button className={`session-button ${active?.id === session.id ? 'selected' : ''}`} key={session.id} onClick={() => setSelected(session.id)}>
              <span className={`status-dot ${connection === 'connected' ? session.status : 'disconnected'}`} />
              <span><strong>{session.name}</strong><small>{session.hostname} · {connection === 'connected' ? session.status : 'status unknown'}</small></span>
              <span className="session-arrow" aria-hidden="true">&rsaquo;</span>
            </button>
          ))}
          {!sessions.length && <p className="sidebar-empty">Your registered agent terminals will appear here.</p>}
        </nav>
        <div className="sidebar-bottom">
          <span className="avatar">{username.slice(0, 2).toUpperCase()}</span>
          <span className="account"><strong>{username}</strong><small>Private workspace</small></span>
          <button className="signout" onClick={() => void logout()} disabled={signingOut}>Sign out</button>
        </div>
      </aside>
      <main className="main-panel">
        <header className="page-heading">
          <div><span className="eyebrow">WORKSPACE / TERMINALS</span><h1>Agent terminals</h1><p>A direct line to your running agents.</p></div>
          <span className="online-count"><span className={`status-dot ${connection === 'connected' ? 'online' : 'disconnected'}`} />{connection === 'connected' ? `${online} online` : 'Status unknown'}</span>
        </header>
        {notice && <div className="notice" role="alert"><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice('')}>&times;</button></div>}
        {active ? <Suspense fallback={<section className="empty-state">Loading terminal...</section>}><TerminalPane key={active.id} session={active} transport={transport} epoch={epoch} connected={connection === 'connected'} /></Suspense> : (
          <section className="empty-state">
            <div className="empty-icon" aria-hidden="true">&gt;_</div><span className="eyebrow">READY TO CONNECT</span>
            <h2>Your next terminal starts here.</h2>
            <p>Run the CLI wrapper on an agent node with this account.<br />Its live terminal will appear automatically.</p>
            <pre>agent-hub --server {location.origin}{insecureHttp ? ' --allow-insecure-http' : ''} --user {username} -- your-agent-command</pre>
            <p className="empty-footnote">Install the standalone agent package on the agent node first; on Windows use agent-hub.cmd.<br />Replace your-agent-command with a shell or agent CLI. Passwords are prompted locally.</p>
            {insecureHttp && <p className="empty-footnote">Trusted LAN only: HTTP sends passwords and terminal traffic without encryption. Use HTTPS on untrusted networks.</p>}
          </section>
        )}
      </main>
    </div>
  );
}
