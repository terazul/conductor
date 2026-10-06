/**
 * The storage question, and the line that stays up while nothing is saved.
 * (Amendment 46)
 *
 * Mounted outside the shell, like every always-on (lib/screens.ts), because it must
 * cover whatever screen is showing: until it is answered, the daemon is a setup server
 * that answers nothing else, so no screen has data to show.
 *
 * Fixture replays have no daemon to ask, and are left alone.
 */

import { useCallback, useEffect, useState } from 'react';
import type { StorageState } from '@conductor/shared';
import type { AlwaysOnDef } from '../lib/screens.js';
import { useFeedStatus } from '../lib/store.js';
import { errorText } from '../lib/errors.js';
import { DECLINE_NOTE, answer, bannerLine, bringLine, getChoice, homeish, questionLines, saveHome } from './storage.js';
import './settings.css';

/** How often to look again while the daemon is starting, or restarting after an answer. */
const POLL_MS = 1_500;

let known: StorageState | null = null;
const listeners = new Set<(s: StorageState) => void>();

/** The storage state, shared with Settings. Null until the daemon has said. */
export function useStorage(): StorageState | null {
  const [s, setS] = useState(known);
  useEffect(() => {
    listeners.add(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

export function setStorage(s: StorageState): void {
  known = s;
  for (const l of listeners) l(s);
}

function StorageGate() {
  const feed = useFeedStatus();
  const state = useStorage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [bring, setBring] = useState(true);

  // Ask until the daemon answers — it may be starting, or restarting after the choice.
  useEffect(() => {
    if (feed === 'fixture') return;
    if (state && state.mode !== 'undecided' && !waiting) return;
    let live = true;
    const ask = (): void => {
      getChoice().then(
        (s) => {
          if (!live) return;
          setStorage(s);
          if (s.mode !== 'undecided') setWaiting(false);
          else if (waiting) t = setTimeout(ask, POLL_MS);
        },
        () => {
          if (live) t = setTimeout(ask, POLL_MS);
        },
      );
    };
    let t: ReturnType<typeof setTimeout> | undefined;
    ask();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [feed, state?.mode, waiting]);

  const choose = useCallback(async (allow: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setStorage(await answer(allow, allow && bring && Boolean(known?.legacy)));
      // The setup server closes and the daemon proper starts; look until it answers.
      setWaiting(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStorage(await saveHome());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }, []);

  if (feed === 'fixture' || !state) return null;

  if (state.mode === 'undecided' || waiting) {
    const q = questionLines(state);
    return (
      <div className="st-veil" role="dialog" aria-modal="true" aria-labelledby="st-q">
        <div className="st-ask">
          <h2 id="st-q">{q.title}</h2>
          {q.body.map((line) => (
            <p key={line}>{line}</p>
          ))}
          {bringLine(state) && !waiting && (
            <label className="st-bring">
              <input type="checkbox" checked={bring} onChange={(e) => setBring(e.target.checked)} />
              {bringLine(state)}
            </label>
          )}
          {waiting ? (
            <p className="st-wait">Starting Conductor…</p>
          ) : (
            <>
              <div className="st-row">
                <button type="button" className="st-yes" disabled={busy} onClick={() => void choose(true)}>
                  {q.yes}
                </button>
                <button type="button" className="st-no" disabled={busy} onClick={() => void choose(false)}>
                  {q.no}
                </button>
              </div>
              <p className="st-note">{DECLINE_NOTE}</p>
            </>
          )}
          {error && <p className="st-err">{error}</p>}
        </div>
      </div>
    );
  }

  const line = bannerLine(state);
  if (!line) return null;
  return (
    <div className="st-banner" role="status">
      <span>{line}</span>
      {!state.savedAt && (
        <button type="button" disabled={busy} onClick={() => void save()} title={`Copy this session to ${state.dir}, for the next start to open`}>
          {busy ? 'saving…' : `save to ${homeish(state.dir)}`}
        </button>
      )}
      {error && <span className="st-err">{error}</span>}
    </div>
  );
}

export const alwaysOn: AlwaysOnDef = { id: 'storage-gate', Component: StorageGate };
