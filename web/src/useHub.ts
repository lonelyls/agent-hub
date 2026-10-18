import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isViewerServerMessage, type TerminalInfo, type ViewerMessage, type ViewerServerMessage } from '../../shared/protocol';

type Listener = (message: ViewerServerMessage) => void;

export function useHub(onExpired: () => void) {
  const [sessions, setSessions] = useState<TerminalInfo[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [epoch, setEpoch] = useState(0);
  const [notice, setNotice] = useState('');
  const socket = useRef<WebSocket | null>(null);
  const listeners = useRef(new Set<Listener>());
  const expired = useRef(onExpired);
  expired.current = onExpired;

  const send = useCallback((message: ViewerMessage): boolean => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(message));
    return true;
  }, []);
  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);
  const transport = useMemo(() => ({ send, subscribe }), [send, subscribe]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/browser`);
      socket.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConnection('connected');
        setNotice('');
        setEpoch((value) => value + 1);
      };
      ws.onmessage = (event: MessageEvent<string>) => {
        let decoded: unknown;
        try { decoded = JSON.parse(event.data); }
        catch {
          setNotice('The hub sent an invalid response. Reconnecting.');
          ws.close();
          return;
        }
        if (!isViewerServerMessage(decoded)) {
          setNotice('The hub sent an invalid response.');
          ws.close();
          return;
        }
        const message = decoded;
        if (message.type === 'sessions') setSessions(message.sessions);
        if (message.type === 'error') setNotice(message.message);
        for (const listener of listeners.current) listener(message);
      };
      ws.onerror = () => { if (!disposed) setNotice('Cannot reach the hub. Checking connection...'); };
      ws.onclose = async (event) => {
        if (disposed) return;
        setConnection('reconnecting');
        if (event.code === 4401) { expired.current(); return; }
        // Browsers hide HTTP upgrade status. Check the cookie before retrying a failed handshake.
        try {
          const response = await fetch('/api/me', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
          if (disposed) return;
          if (response.status === 401) { expired.current(); return; }
        } catch {
          if (!disposed) setNotice('The hub is offline. Reconnecting automatically; input is disabled.');
        }
        if (!disposed) timer = setTimeout(connect, Math.min(1000 * 2 ** Math.min(retry++, 4), 15000));
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket.current?.close();
      socket.current = null;
    };
  }, []);

  return { sessions, connection, epoch, notice, setNotice, transport };
}

export type HubTransport = ReturnType<typeof useHub>['transport'];
