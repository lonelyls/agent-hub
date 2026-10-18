import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalInfo } from '../../shared/protocol';
import type { HubTransport } from './useHub';

interface Props {
  session: TerminalInfo;
  transport: HubTransport;
  epoch: number;
  connected: boolean;
}

export function TerminalPane({ session, transport, epoch, connected }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState(session);
  const [controlling, setControlling] = useState(false);
  const [ready, setReady] = useState(false);
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const terminalRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      scrollback: 10000,
      allowProposedApi: false,
      screenReaderMode: true,
      theme: { background: '#0b0e14', foreground: '#d9e0ee', cursor: '#5eead4', selectionBackground: '#315262' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current!);
    terminalRef.current = terminal;
    fit.fit();
    let hasSnapshot = false;
    let canControl = false;
    let online = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    setReady(false);
    setControlling(false);
    const resize = () => {
      if (!hasSnapshot || !canControl || !online || !connectedRef.current) return;
      fit.fit();
      transport.send({
        type: 'resize',
        cols: Math.max(20, Math.min(500, terminal.cols)),
        rows: Math.max(5, Math.min(200, terminal.rows)),
      });
    };
    const unsubscribe = transport.subscribe((message) => {
      if (message.type === 'snapshot' && message.session.id === session.id) {
        terminal.reset();
        hasSnapshot = true;
        canControl = message.controlling;
        online = message.session.status === 'online';
        setInfo(message.session);
        setControlling(canControl);
        setReady(true);
        terminal.resize(message.session.cols, message.session.rows);
        terminal.write(message.history, () => {
          resize();
          terminal.focus();
        });
      } else if (message.type === 'output' && message.sessionId === session.id && hasSnapshot) {
        terminal.write(message.data);
      } else if (message.type === 'state' && message.session.id === session.id) {
        const gainedControl = !canControl && message.controlling;
        online = message.session.status === 'online';
        canControl = message.controlling;
        setInfo(message.session);
        setControlling(canControl);
        if (!canControl) terminal.resize(message.session.cols, message.session.rows);
        if (gainedControl) { resize(); terminal.focus(); }
      }
    });
    const input = terminal.onData((data) => {
      if (!hasSnapshot || !canControl || !online || !connectedRef.current) return;
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(offset + 4096, data.length);
        const last = data.charCodeAt(end - 1);
        if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
        transport.send({ type: 'input', data: data.slice(offset, end) });
        offset = end;
      }
    });
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 100);
    });
    observer.observe(container.current!);
    transport.send({ type: 'watch', sessionId: session.id });
    return () => {
      transport.send({ type: 'unwatch' });
      clearTimeout(resizeTimer);
      unsubscribe();
      observer.disconnect();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [session.id, transport, epoch]);

  const writable = ready && controlling && info.status === 'online' && connected;
  return (
    <section className="terminal-pane" aria-label={`Terminal ${session.name}`}>
      <div className="terminal-heading">
        <div className="terminal-title">
          <span className={`status-dot ${info.status}`} />
          <div><h2>{info.name}</h2><p>{info.hostname} <span>/</span> {info.command}</p></div>
        </div>
        <div className="terminal-actions">
          <span className="mode-badge">{!connected ? 'Reconnecting' : writable ? 'You have control' : info.status === 'exited' ? `Exited (${info.exitCode ?? '?'})` : info.status === 'disconnected' ? 'Agent offline' : 'Read only'}</span>
          {ready && !controlling && connected && info.status === 'online' && (
            <button className="secondary compact" onClick={() => transport.send({ type: 'control' })}>Take control</button>
          )}
          <button className="secondary compact" title="Clear only this browser's terminal display" onClick={() => terminalRef.current?.clear()}>Clear display</button>
        </div>
      </div>
      <div className="terminal-surface" ref={container} data-testid="terminal" />
      <div className="terminal-footer">
        <span>{writable ? 'Live terminal · input goes directly to the agent' : !ready ? 'Loading terminal history...' : 'Input disabled · output remains visible'}</span>
        <span>PTY / xterm-256color</span>
      </div>
    </section>
  );
}
