
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { ReactorAudio, type ReactorAudioMode } from '../audio';
import { createReactorStore, type ReactorStore, type StoreApi } from './store';
import type { ClientDeps } from '../core/client';
import type { ConnectOptions, JwtSource, ReactorOptions, TrackCapability } from '../types';

/** `connectOptions` for the provider — adds `autoConnect` to the core
 *  `ConnectOptions`. Live, same as every other `ReactorProviderProps` field —
 *  see `ReactorProvider`'s doc comment. */
export interface ReactorConnectOptions extends ConnectOptions {
  /** Connect automatically once a Reactor is built — initial mount, or any
   *  later rebuild. Default `false`. */
  autoConnect?: boolean;
}

export interface ReactorProviderProps {
  apiUrl?: string | undefined;
  modelName: string;
  local?: boolean | undefined;
  /** Media tracks to declare up front, so the transport can prepare the SDP
   *  offer in parallel with session polling instead of waiting to discover
   *  them from the model's schema. */
  modelTracks?: TrackCapability[] | undefined;
  /** Static token, or a resolver called before every authenticated request
   *  — see `JwtSource`. Required for `autoConnect` against a non-local
   *  runtime; can also be supplied later via an explicit `connect()` call
   *  instead. */
  jwtToken?: JwtSource | undefined;
  connectOptions?: ReactorConnectOptions | undefined;
  /**
   * React Native only. Disconnect when the app leaves the foreground.
   *
   * A backgrounded app keeps its session — and its bill — running until the
   * runtime notices the missing heartbeat, while iOS suspends the WebRTC
   * engine within seconds. `true` ends the session as soon as `AppState`
   * leaves `active`; coming back does not reconnect on its own, because
   * starting a new session is a decision with a price. Default `false`, which
   * matches the browser SDK.
   */
  disconnectOnBackground?: boolean | undefined;
  /**
   * React Native only. Where received audio plays while connected — see
   * `ReactorAudio`. Default `"media"`: the loudspeaker, unless headphones are
   * in, instead of the earpiece libwebrtc would pick. Use `"voiceChat"` when
   * publishing a microphone, `"none"` to manage the audio session yourself.
   * Restored to the default when the connection ends.
   */
  audioMode?: Exclude<ReactorAudioMode, 'default'> | 'none' | undefined;
  /** Advanced: replace the WebRTC engine or HTTP client (tests, pinning).
   *  Read once, when the Reactor is built. */
  deps?: Partial<ClientDeps> | undefined;
  children?: ReactNode;
}

/** Exported so a component can optionally read the nearest provider's store
 *  without requiring one — e.g. `ClipPlayer`, which works both inside and
 *  outside a `ReactorProvider`. Most consumers want `useReactor`/`useReactorStore`
 *  instead, which throw outside a provider rather than returning `undefined`. */
export const ReactorContext = createContext<StoreApi<ReactorStore> | undefined>(undefined);

type BuildStoreProps = Pick<
  ReactorProviderProps,
  'apiUrl' | 'modelName' | 'local' | 'modelTracks' | 'jwtToken' | 'connectOptions' | 'deps'
>;

/**
 * Builds a fresh store (and the `Reactor` underneath) from the provider's
 * props, firing `connect()` immediately when `autoConnect` is set. Used for
 * both the initial mount and every later rebuild, so both go through the
 * same auto-connect path rather than only the first one.
 */
function buildStore({
  apiUrl,
  modelName,
  local,
  modelTracks,
  jwtToken,
  connectOptions,
  deps,
}: BuildStoreProps): StoreApi<ReactorStore> {
  // Built up field-by-field, not as one object literal, so an omitted prop
  // stays omitted rather than becoming an explicit `undefined` — required
  // under `exactOptionalPropertyTypes`.
  const options: ReactorOptions = { modelName };

  if (apiUrl !== undefined) {
    options.apiUrl = apiUrl;
  }
  if (local !== undefined) {
    options.local = local;
  }
  if (modelTracks !== undefined) {
    options.modelTracks = modelTracks;
  }
  if (jwtToken !== undefined) {
    options.jwt = jwtToken;
  }

  // `autoConnect` isn't acted on here — see the effect in `ReactorProvider`
  // that fires it. `ConnectOptions` (unlike `ReactorConnectOptions`) has no
  // `autoConnect` field, so it's stripped before this is stored as the
  // store's `defaultConnectOptions`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { autoConnect, ...pollingOptions } = connectOptions ?? {};

  return createReactorStore(options, pollingOptions, deps);
}

/**
 * Owns a `Reactor` instance and exposes it to `useReactor` below.
 *
 * `apiUrl`/`modelName`/`local`/`modelTracks`/`jwtToken`/`connectOptions`
 * (including `autoConnect`) are live: changing any of them tears down the
 * current `Reactor` (`disconnect()` then `dispose()`) and builds a
 * fresh one — the same way `useLiveKitRoom` rebuilds its `Room` when its
 * construction `options` change. `Reactor` has no equivalent of LiveKit's
 * `token`/`serverUrl` split (reconnecting the *same* instance with new
 * credentials) or its live `connect` boolean (toggling the same `Room`'s
 * connection without rebuilding it) — its constructor bundles everything, so
 * any change, `autoConnect` included, means a fresh instance rather than
 * reconnecting/disconnecting the existing one. Pass a stable `jwtToken`
 * (e.g. via `useCallback` for a resolver) and stable `modelTracks`/
 * `connectOptions` references if you don't want an unrelated parent render to
 * rebuild the connection — object/array props are compared by reference
 * (`modelTracks`/`connectOptions` via a `JSON.stringify` snapshot, same as
 * `useLiveKitRoom` does for its own `options`).
 *
 * Unmounting tears down the same way — see `Reactor.disconnect()`/
 * `dispose()` for what that frees.
 */
export function ReactorProvider({
  apiUrl,
  modelName,
  local,
  modelTracks,
  jwtToken,
  connectOptions,
  disconnectOnBackground = false,
  audioMode = 'media',
  deps,
  children,
}: ReactorProviderProps) {
  const [store, setStore] = useState(() =>
    buildStore({ apiUrl, modelName, local, modelTracks, jwtToken, connectOptions, deps }),
  );
  // Skips the rebuild effect's mandatory first run — the initial store was
  // already built synchronously above, so re-running the same construction
  // on mount would just replace it with an equivalent one for nothing.
  const isFirstRun = useRef(true);

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;

      return;
    }
    setStore(buildStore({ apiUrl, modelName, local, modelTracks, jwtToken, connectOptions, deps }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl, modelName, local, JSON.stringify(modelTracks), jwtToken, JSON.stringify(connectOptions)]);

  // Fires autoConnect for whichever Reactor this provider currently owns —
  // on initial mount and on every rebuild, since both produce a new `store`.
  // Deliberately an effect, not part of `buildStore`'s synchronous
  // construction: `buildStore` runs inside `useState`'s lazy initializer,
  // and React 18 StrictMode double-invokes that during render to surface
  // impure side effects — calling connect() from there fires it against two
  // separate, independently-constructed Reactor instances, and the discarded
  // one leaks a live connection nothing ever tears down. Matches v2, which
  // also fires autoConnect from an effect rather than during construction.
  useEffect(() => {
    const { autoConnect = false, ...pollingOptions } = connectOptions ?? {};

    if (autoConnect && store.getState().status === 'disconnected') {
      // A rejection here (auth/network failure, ...) would otherwise escape
      // as an unhandled promise rejection — connect() throws rather than
      // reporting failures through the `error` event, and nothing here
      // awaits this fire-and-forget call.
      store.getState().connect(jwtToken, pollingOptions).catch((error: unknown) => {
        console.error('[Reactor.ReactorProvider] autoConnect failed:', error);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  // Tears down whichever Reactor this provider currently owns — on rebuild
  // (store changes, so this cleanup fires for the one being replaced) and on
  // final unmount. disconnect() first (ends the session server-side; a bare
  // dispose() skips that), then dispose to free local resources for
  // good and stop the store's event listeners from lingering on a Reactor
  // nothing references any more.
  useEffect(() => {
    return () => {
      const reactor = store.getState().internal.reactor;

      void reactor.disconnect().finally(() => reactor.dispose());
    };
  }, [store]);

  // Applied as the connection starts, so the route is right before the first
  // audio frame; handed back when it ends.
  useEffect(() => {
    if (audioMode === 'none') {
      return;
    }
    let applied = false;
    const sync = () => {
      const connected = store.getState().status !== 'disconnected';
      if (connected && !applied) {
        applied = true;
        ReactorAudio.setMode(audioMode).catch((error: unknown) => {
          console.warn('[Reactor.ReactorProvider] audio mode not applied:', error);
        });
      } else if (!connected && applied) {
        applied = false;
        ReactorAudio.setMode('default').catch(() => {});
      }
    };
    sync();
    const unsubscribe = store.subscribe(sync);
    return () => {
      unsubscribe();
      if (applied) {
        ReactorAudio.setMode('default').catch(() => {});
      }
    };
  }, [store, audioMode]);

  useEffect(() => {
    if (!disconnectOnBackground) {
      return;
    }
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && store.getState().status !== 'disconnected') {
        store.getState().disconnect().catch((error: unknown) => {
          console.error('[Reactor.ReactorProvider] background disconnect failed:', error);
        });
      }
    });
    return () => subscription.remove();
  }, [store, disconnectOnBackground]);

  return <ReactorContext.Provider value={store}>{children}</ReactorContext.Provider>;
}

/** Reads the store directly, with whatever equality behavior `selector`
 *  itself implies — most callers want `useReactor` instead, which adds
 *  shallow comparison. Throws outside a `ReactorProvider`. */
export function useReactorStore<T>(selector: (state: ReactorStore) => T): T {
  const store = useContext(ReactorContext);

  if (store === undefined) {
    throw new Error('useReactor must be used within a ReactorProvider');
  }

  // The same function serves as both snapshots: `createReactorStore()` is
  // side-effect-free at construction (the client and its WebRTC engine are
  // only built on first `connect()`), so the state a server render sees is identical to
  // what the client sees before hydration — there's no divergence to
  // reconcile. Omitting `getServerSnapshot` entirely makes React bail out of
  // SSR for this subtree instead ("Missing getServerSnapshot").
  const getSnapshot = () => selector(store.getState());

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
